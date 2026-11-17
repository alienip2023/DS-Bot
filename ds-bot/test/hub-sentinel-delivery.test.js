import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { directoryOf, handleNodeMessage, publishDirectory } from '../src/host/bot-network.js'
import { fakeNetwork, peerRows } from './peer-fixture.js'
import { makeBot, threadWorld } from './thread-t2-world.js'

function hub() {
  const sends = []
  const delivered = []
  const local = { id: 'cmd', name: 'Commander', role: 'Lead' }
  const rt = {
    state: { bots: { cmd: local } }, load: async () => {}, warn: () => {},
    ctx: { get: name => name === 'remote-agent:registry' ? { send: (...args) => { sends.push(args); return true } } : undefined },
    deliver: async args => { delivered.push(args) },
  }
  return { rt, sends, delivered }
}

test('a message addressed to nodeId hub is one local delivery and no registry.send', async () => {
  const { rt, sends, delivered } = hub()
  await handleNodeMessage(rt, {
    exchangeId: 'e1', kind: 'ask', depth: 0, text: 'hi',
    from: { id: 'x', name: 'Exec9', nodeId: 'n9' }, to: { id: 'cmd', name: 'Commander', nodeId: 'hub' },
  })
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0], {
    fromId: 'x', toId: 'cmd', text: 'hi', role: 'default',
    exchangeId: 'e1', fromName: 'Exec9',
  })
  assert.equal(sends.length, 0)
})

for (const kind of ['ask', 'reply']) {
  test(`the registered hub receiver delivers a hub sentinel ${kind} to the local Session without forwarding`, async t => {
    const registry = new EventEmitter()
    const forwarded = []
    registry.onlineNodes = () => [{ nodeId: 'n9' }]
    registry.send = (...args) => { forwarded.push(args); return true }
    const w = threadWorld({ services: { 'remote-agent:registry': registry } })
    t.after(async () => {
      const results = await w.ctx.dispose()
      assert.ok(results.every(result => result.status === 'fulfilled'))
      rmSync(w.home, { recursive: true, force: true })
    })
    const bot = await makeBot(w, 'Commander')
    await makeBot(w, 'Other')
    await publishDirectory(w.rt)
    forwarded.length = 0
    assert.equal(w.rt.botOf('exec9'), undefined, 'the node sender is not a hub-local Bot')
    const receive = w.ctx.get('remote-agent:bot-message')
    assert.equal(typeof receive, 'function')
    await receive({
      kind, exchangeId: `hub-${kind}`, depth: 0, text: 'From the node',
      from: { id: 'exec9', name: 'Exec9', nodeId: 'n9' },
      to: { id: bot.id, name: 'Commander', nodeId: 'hub' },
    })
    assert.equal(w.followups.length, 1, 'the hub sentinel must reach one local Session')
    assert.equal(w.followups[0].sessionId, w.rt.chatOf(bot.id))
    assert.deepEqual(w.followups[0].message.content, [{ type: 'text', text: '[Message from Exec9]\nFrom the node' }])
    assert.equal(w.followups[0].message.source.exchangeId, `hub-${kind}`)
    assert.equal(w.followups[0].message.source.senderName, 'Exec9')
    assert.deepEqual(forwarded, [], 'a hub-local destination must never use registry.send')
  })
}

test('a node discovers the published hub Bot and message_bot reaches its hub-local Session', async t => {
  const registry = new EventEmitter()
  const frames = []
  registry.onlineNodes = () => [{ nodeId: 'n9' }]
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true }
  const hub = threadWorld({ services: { 'remote-agent:registry': registry } })
  const { network, frames: sent } = fakeNetwork()
  const node = threadWorld({ services: { 'remote-agent:bot-network': network } })
  t.after(async () => {
    for (const w of [node, hub]) {
      const results = await w.ctx.dispose()
      assert.ok(results.every(result => result.status === 'fulfilled'))
      rmSync(w.home, { recursive: true, force: true })
    }
  })
  const commander = await makeBot(hub, 'Commander')
  const exec9 = await makeBot(node, 'Exec9')
  frames.length = 0
  await publishDirectory(hub.rt)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, 'bot/directory')
  assert.equal(frames[0].nodeId, 'n9')
  assert.ok(frames[0].payload.bots.some(bot => bot.id === commander.id && bot.nodeId === 'hub'))
  network.emit('directory', frames[0].payload.bots)
  const peer = peerRows(node.rt).find(bot => bot.remoteBotId === commander.id)
  assert.ok(peer, 'the hub-local Bot must be visible as a node peer row')
  assert.equal(peer.homeNodeId, 'hub')
  const exec = { agent: { id: node.rt.chatOf(exec9.id) } }
  const list = node.rt.teamTools.find(tool => tool.name === 'list_bots')
  assert.match(await list.execute({}, exec), /Commander/)
  const send = node.rt.teamTools.find(tool => tool.name === 'message_bot')
  assert.match(await send.execute({ to: 'Commander', message: 'Across the hub boundary' }, exec), /^Sent to Commander on hub;/)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].to, { id: commander.id, name: 'Commander', nodeId: 'hub' })
  assert.deepEqual(sent[0].from, { id: exec9.id, name: 'Exec9', nodeId: 'n9' })
  frames.length = 0
  await hub.ctx.get('remote-agent:bot-message')(sent[0])
  assert.equal(hub.followups.length, 1, 'the published hub Bot must receive the node message')
  assert.equal(hub.followups[0].sessionId, hub.rt.chatOf(commander.id))
  assert.equal(hub.followups[0].message.content[0].text, '[Message from Exec9]\nAcross the hub boundary')
  assert.equal(hub.followups[0].message.source.exchangeId, sent[0].exchangeId)
  assert.deepEqual(frames, [], 'the inbound hub sentinel must not be forwarded to any node')
  assert.equal(node.followups.length, 0, 'sending must not execute the peer locally')
})

test('the directory carries the hub sentinel for every non-joined row', () => {
  const { rt } = hub()
  assert.deepEqual(directoryOf(rt).map(bot => bot.nodeId), ['hub'])
})
