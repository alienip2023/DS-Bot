import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { clusterBotDirName } from '../src/host/memory.js'
import { shadowId } from '../src/host/roster-join.js'
import { hub, rosterFor } from './memory-hub-ctx.js'
import { fakeLink, startNode } from './memory-node-ctx.js'

async function start(t, { clusterBotId } = {}) {
  const roster = rosterFor('n1', ['b1'])
  if (clusterBotId !== undefined) roster.bots[0].clusterBotId = clusterBotId
  const remote = await hub({ roster: [roster] })
  t.after(() => remote.close())
  const link = fakeLink({ online: true, hub: {
    async receive(type, payload, reply) {
      if (type !== 'mem/write' && type !== 'mem/read') return
      await remote.registry.emitAsync(type === 'mem/write' ? 'memoryWrite' : 'memoryRead', { ...payload, nodeId: 'n1' })
      const answer = remote.registry.frames(`${type}-result`).find(frame => frame.payload.requestId === payload.requestId)
      reply(answer.payload)
    },
  } })
  const node = startNode({ link })
  t.after(() => node.stop())
  await node.rt.load()
  assert.equal(remote.rt.botOf(shadowId('n1', 'b1')).clusterBotId, clusterBotId)
  return { remote, ...node }
}

function assertWrite(remote, scope, directory, text) {
  assert.equal(remote.registry.frames('mem/write-result').at(-1).payload.ok, true)
  assert.equal(remote.rt.memoryHub.seq(), 1)
  assert.equal(remote.rt.memoryHost.dirOf(scope), directory)
  assert.match(readFileSync(`${directory}/MEMORY.md`, 'utf8'), new RegExp(text))
  const journal = scope.nodeId === undefined ? remote.dir('journal.jsonl') : remote.dir('nodes', scope.nodeId, 'journal.jsonl')
  const rows = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].scope, remote.rt.memoryHost.logKeyOf(scope))
}

test('bot scope with clusterBotId writes only to the cluster identity', async (t) => {
  const { remote, tool } = await start(t, { clusterBotId: 'identity-1' })

  assert.match(await tool('remember', { scope: 'bot', text: 'Cluster memory' }), /^Saved\./)
  assertWrite(remote, { kind: 'clusterBot', clusterBotId: 'identity-1' }, remote.dir('bots', clusterBotDirName('identity-1')), 'Cluster memory')
  assert.equal(existsSync(remote.dir('nodes', 'n1', 'bots')), false)
})

test('bot scope without clusterBotId refuses the write without creating node Bot memory', async (t) => {
  const { remote, rt, tool } = await start(t)

  let failure
  try { await tool('remember', { scope: 'bot', text: 'Must not split memory' }) } catch (error) { failure = error }
  const answer = remote.registry.frames('mem/write-result').at(-1).payload
  // Check the filesystem even when the old fallback incorrectly reports success.
  assert.equal(existsSync(remote.dir('nodes', 'n1', 'bots')), false)
  assert.equal(answer.ok, false)
  assert.equal(answer.error, 'memory/refused')
  assert.equal(answer.seq, 0)
  assert.equal(failure?.code, 'memory/refused')
  assert.match(failure.message, /clusterBotId/)
  assert.equal(remote.rt.memoryHub.seq(), 0)
  assert.deepEqual(Object.keys(remote.rt.memoryMeta.view().inbox), [])
  assert.deepEqual(rt.memoryNode.outbox(), [])
  assert.equal(existsSync(remote.dir('bots')), false)
})

test('own scope without clusterBotId still writes to the node Bot directory', async (t) => {
  const { remote, tool } = await start(t)

  assert.match(await tool('remember', { scope: 'own', text: 'Local own memory' }), /^Saved\./)
  assertWrite(remote, { kind: 'bot', nodeId: 'n1', botId: 'b1' }, remote.dir('nodes', 'n1', 'bots', 'b1'), 'Local own memory')
  assert.equal(existsSync(remote.dir('bots')), false)
})

test('node scope without clusterBotId still writes to the node directory', async (t) => {
  const { remote, tool } = await start(t)

  assert.match(await tool('remember', { scope: 'node', text: 'Shared node memory' }), /^Saved\./)
  assertWrite(remote, { kind: 'node', nodeId: 'n1' }, remote.dir('nodes', 'n1'), 'Shared node memory')
  assert.equal(existsSync(remote.dir('nodes', 'n1', 'bots')), false)
  assert.equal(existsSync(remote.dir('bots')), false)
})
