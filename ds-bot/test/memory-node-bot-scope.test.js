import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { shadowId } from '../src/host/roster-join.js'
import { hub, rosterFor } from './memory-hub-ctx.js'
import { fakeHub, fakeLink, startNode } from './memory-node-ctx.js'

const frames = (link, type) => link.sent.filter(frame => frame.type === type)

test('remember with bot scope sends mem/write with the same remoteBotId', async (t) => {
  const link = fakeLink({ online: true })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  assert.match(await tool('bot_remember', { text: 'Keep this across machines', scope: 'bot' }), /^Saved\./)
  const sent = frames(link, 'mem/write')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.scope, 'bot')
  assert.equal(sent[0].payload.remoteBotId, rt.state.bots.b1.id)
  assert.equal(sent[0].payload.text, 'Keep this across machines')
})

test('recall with bot scope sends mem/read and labels cluster entries', async (t) => {
  const remote = fakeHub()
  remote.entries.set('bot:b1', [{ id: 'cluster-note', text: 'A cluster memory' }])
  const link = fakeLink({ online: true, hub: remote })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  const answer = await tool('bot_recall', { scope: 'bot' })
  const sent = frames(link, 'mem/read')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.scope, 'bot')
  assert.equal(sent[0].payload.remoteBotId, rt.state.bots.b1.id)
  assert.match(answer, /The Bot's cluster memory: 1 entries\./)
  assert.match(answer, /\[bot\] A cluster memory/)
})

test('cluster scope aliases are trimmed, unquoted and case-insensitive for reads and writes', async (t) => {
  const link = fakeLink({ online: true })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  for (const scope of ['cluster', '  "BoT"  ', " 'CLUSTER' ", '  "ClUsTeR BoT"  ', '机器人', '集群']) {
    await tool('bot_remember', { text: `Alias ${scope}`, scope })
    assert.equal(frames(link, 'mem/write').at(-1).payload.scope, 'bot', scope)
    await tool('bot_recall', { scope })
    assert.equal(frames(link, 'mem/read').at(-1).payload.scope, 'bot', scope)
  }
})

test('a write without scope still sends own', async (t) => {
  const link = fakeLink({ online: true })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  await tool('bot_remember', { text: 'Keep this on the node' })
  assert.deepEqual(frames(link, 'mem/write').map(frame => frame.payload.scope), ['own'])
})

test('recall without scope still reads own then team', async (t) => {
  const link = fakeLink({ online: true })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  assert.equal(await tool('bot_recall', {}), 'Your memory: nothing saved yet.\n\nThe team memory: nothing saved yet.')
  assert.deepEqual(frames(link, 'mem/read').map(frame => frame.payload.scope), ['own', 'team'])
})

test('team writes are refused locally without a frame or outbox entry, online or offline', async (t) => {
  for (const online of [true, false]) {
    const link = fakeLink({ online })
    const { rt, tool, stop } = startNode({ link })
    t.after(() => stop())
    await rt.load()
    const before = [...link.sent]

    await assert.rejects(tool('bot_remember', { text: 'Do not save this', scope: 'team' }), error => {
      assert.equal(error.code, 'memory/team-read-only')
      assert.equal(error.message, 'The team memory is written on the hub by a Main Bot or a group admin; a node cannot write it. Nothing was saved.')
      return true
    })
    assert.deepEqual(link.sent, before)
    assert.deepEqual(rt.memoryNode.outbox(), [])
  }
})

test('unknown and named Bot scope messages explain bot cluster memory', async (t) => {
  const link = fakeLink({ online: true })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  const unknown = await tool('bot_recall', { scope: 'missing' })
  assert.match(unknown, /^No scope named missing\./)
  for (const message of [unknown, await tool('bot_recall', { scope: 'Two' })]) {
    assert.match(message, /"bot"/)
    assert.match(message, /the memory the Bot keeps under its cluster identity, readable from any machine once that Bot has an identity/)
  }
  assert.equal(frames(link, 'mem/read').length, 0)
})

test('the hub refuses a bot write when the roster row has no cluster identity', async (t) => {
  const remote = await hub({ roster: [rosterFor('n1', ['b1'])] })
  t.after(() => remote.close())
  assert.equal(remote.rt.botOf(shadowId('n1', 'b1')).clusterBotId, undefined)
  const link = fakeLink({ online: true, hub: {
    async receive(type, payload, reply) {
      if (type !== 'mem/write' && type !== 'mem/read') return
      await remote.registry.emitAsync(type === 'mem/write' ? 'memoryWrite' : 'memoryRead', { ...payload, nodeId: 'n1' })
      const answer = remote.registry.frames(`${type}-result`).find(frame => frame.payload.requestId === payload.requestId)
      reply(answer.payload)
    },
  } })
  const { rt, tool, warnings, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()
  const beforeWarnings = [...warnings]

  await assert.rejects(tool('bot_remember', { text: 'Fallback memory', scope: 'bot' }), error => {
    assert.equal(error.code, 'memory/refused')
    assert.match(error.message, /A "bot" write requires clusterBotId on the hub roster\. Nothing was saved\./)
    return true
  })
  const sent = frames(link, 'mem/write')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.scope, 'bot')
  const answer = remote.registry.frames('mem/write-result').at(-1).payload
  assert.equal(answer.requestId, sent[0].payload.requestId)
  assert.equal(answer.ok, false)
  assert.equal(answer.error, 'memory/refused')
  assert.equal(existsSync(remote.dir('nodes', 'n1', 'bots', 'b1', 'MEMORY.md')), false)
  assert.equal(existsSync(remote.dir('nodes', 'n1', 'bots', 'b1')), false)
  assert.equal(existsSync(remote.dir('bots')), false)
  assert.equal(await tool('bot_recall', { scope: 'bot' }), "The Bot's cluster memory: nothing saved yet.")
  assert.equal(await tool('bot_recall', { scope: 'own' }), 'Your memory: nothing saved yet.')
  assert.deepEqual(frames(link, 'mem/read').map(frame => frame.payload.scope), ['bot', 'own'])
  assert.deepEqual(remote.registry.frames('mem/read-result').map(frame => frame.payload.entries), [[], []])
  assert.equal(existsSync(remote.dir('nodes', 'n1', 'bots', 'b1')), false)
  assert.equal(remote.rt.memoryHub.seq(), 0)
  assert.deepEqual(warnings, beforeWarnings)
  assert.deepEqual(rt.memoryNode.outbox(), [])
})
