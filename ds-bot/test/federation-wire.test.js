// The hub pushes its own read-only roster down to nodes that announced peer/v1:
// once per burst, never to a node that cannot read it, and never silently lost.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { handlePeerRoster, peerId, pushPeerRoster } from '../src/host/federation.js'
import { makeBot, threadWorld } from './thread-t2-world.js'

class FakeRegistry extends EventEmitter {
  constructor() {
    super()
    this.nodes = new Map()
    this.sent = []
    this.fail = false
    this.refuse = false
  }

  add(nodeId, caps = ['peer/v1'], online = true) {
    const node = { nodeId, online, hello: { caps } }
    this.nodes.set(nodeId, node)
    return node
  }

  getNode(nodeId) {
    return this.nodes.get(nodeId)
  }

  onlineNodes() {
    return [...this.nodes.values()].filter(node => node.online)
  }

  send(nodeId, type, data) {
    if (this.fail) throw new Error('send failed')
    if (this.refuse) return false
    this.sent.push({ nodeId, type, data })
    return true
  }
}

async function world(registry) {
  const w = threadWorld({ services: { 'remote-agent:registry': registry } })
  await w.rt.load()
  w.rt.peerRosterDelayMs = 5
  return w
}

const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))

test('a roster event from a peer/v1 node gets one frame with the hub Bots', async () => {
  const registry = new FakeRegistry()
  registry.add('node-1')
  const w = await world(registry)
  const bot = await makeBot(w, 'Alpha')
  await w.rt.setFederationLevel('roster')
  registry.sent.length = 0
  registry.emit('roster', { nodeId: 'node-1' })
  registry.emit('roster', { nodeId: 'node-1' })
  await wait()
  const frames = registry.sent.filter(entry => entry.type === 'peer/roster' && entry.nodeId === 'node-1')
  assert.equal(frames.length, 1)
  assert.match(frames[0].data.hubId, /^hub-[0-9a-f]{8}$/)
  assert.equal(frames[0].data.level, 'roster')
  assert.equal(typeof frames[0].data.hostname, 'string')
  assert.deepEqual(frames[0].data.bots.map(row => row.id), [bot.id])
  assert.equal(frames[0].data.bots[0].name, 'Alpha')
})

test('the hub tells the node about its local Bots only: no joined, peer or remote-worker rows', async () => {
  const registry = new FakeRegistry()
  registry.add('node-1')
  const w = await world(registry)
  const local = await makeBot(w, 'Alpha')
  await w.rt.setFederationLevel('roster')
  await handlePeerRoster(w.rt, { hubId: 'hub-a', level: 'roster', hostname: 'mac-b', bots: [{ id: 'b1', name: 'Bravo', role: 'R' }] })
  w.rt.state.bots['joined-x'] = { id: 'joined-x', name: 'Joined', origin: 'joined', worker: { home: 'remote', nodeId: 'n' } }
  w.rt.state.bots['worker-y'] = { id: 'worker-y', name: 'Worker', type: 'remote-worker' }
  registry.sent.length = 0
  assert.equal(await pushPeerRoster(w.rt, 'node-1'), true)
  const frame = registry.sent.at(-1)
  assert.deepEqual(frame.data.bots.map(row => row.id), [local.id])
})

test('a node without peer/v1 gets nothing, even when it reports a roster', async () => {
  const registry = new FakeRegistry()
  registry.add('node-1')
  registry.add('node-2', ['remote/turn'])
  const w = await world(registry)
  await makeBot(w, 'Alpha')
  await w.rt.setFederationLevel('roster')
  registry.sent.length = 0
  registry.emit('roster', { nodeId: 'node-2' })
  await wait()
  assert.equal(registry.sent.filter(entry => entry.nodeId === 'node-2').length, 0)
  assert.equal(await pushPeerRoster(w.rt, 'node-2'), false)
})

test('switching off tells the node the list is empty', async () => {
  const registry = new FakeRegistry()
  registry.add('node-1')
  const w = await world(registry)
  await makeBot(w, 'Alpha')
  await w.rt.setFederationLevel('roster')
  await w.rt.setFederationLevel('off')
  const last = registry.sent.filter(entry => entry.type === 'peer/roster').at(-1)
  assert.equal(last.nodeId, 'node-1')
  assert.equal(last.data.level, 'off')
  assert.deepEqual(last.data.bots, [])
})

test('an offline node is not pushed to', async () => {
  const registry = new FakeRegistry()
  registry.add('node-1', ['peer/v1'], false)
  const w = await world(registry)
  await w.rt.setFederationLevel('roster')
  registry.sent.length = 0
  w.rt.markPeerRosterDirty()
  await wait()
  assert.equal(registry.sent.length, 0)
})

test('a local change pushes once after the burst', async () => {
  const registry = new FakeRegistry()
  registry.add('node-1')
  const w = await world(registry)
  await w.rt.setFederationLevel('roster')
  registry.sent.length = 0
  w.rt.markPeerRosterDirty('node-1')
  w.rt.markPeerRosterDirty('node-1')
  w.rt.markPeerRosterDirty('node-1')
  await wait()
  assert.equal(registry.sent.filter(entry => entry.nodeId === 'node-1').length, 1)
})

test('a send that throws or is refused is recorded, and the next push clears it', async () => {
  const registry = new FakeRegistry()
  registry.add('node-1')
  const w = await world(registry)
  await w.rt.setFederationLevel('roster')
  registry.fail = true
  assert.equal(await pushPeerRoster(w.rt, 'node-1'), false)
  assert.equal(w.rt.federationView().lastError.code, 'send-threw')
  registry.fail = false
  registry.refuse = true
  assert.equal(await pushPeerRoster(w.rt, 'node-1'), false)
  assert.equal(w.rt.federationView().lastError.code, 'send-failed')
  registry.refuse = false
  assert.equal(await pushPeerRoster(w.rt, 'node-1'), true)
  assert.equal(w.rt.federationView().lastError, null)
})

test('the installed receiver applies a frame that arrives through provide', async () => {
  const registry = new FakeRegistry()
  registry.add('node-1')
  const w = await world(registry)
  await w.rt.setFederationLevel('roster')
  const receiver = w.ctx.get('remote-agent:peer-roster')
  assert.equal(typeof receiver.onRoster, 'function')
  receiver.onRoster({ hubId: 'hub-z', level: 'roster', hostname: 'mac-z', bots: [{ id: 'b9', name: 'Zulu', role: 'Ops' }] })
  await wait()
  assert.equal(w.rt.state.bots[peerId('hub-z', 'b9')]?.name, 'Zulu')
  assert.equal(w.rt.peerBots().length, 1)
  // A malformed frame from the same wire changes nothing.
  receiver.onRoster({ hubId: 'hub-z', level: 'roster', bots: [{ id: '', name: 'X', role: 'Y' }] })
  await wait()
  assert.equal(w.rt.peerBots().length, 1)
})
