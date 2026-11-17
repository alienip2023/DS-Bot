import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendToPeer } from '../src/host/bot-network.js'
import { threadWorld } from './thread-t2-world.js'
import { entry, fakeNetwork, peerRows } from './peer-fixture.js'
import { makeBot } from './thread-t2-world.js'

async function world(online) {
  const net = fakeNetwork({ online })
  const w = threadWorld({ services: { 'remote-agent:bot-network': net.network } })
  await w.rt.load()
  const sender = await makeBot(w, 'Exec9')
  net.network.emit('directory', [entry('cmd', 'hub', 'Commander')])
  return { w, ...net, sender: typeof sender === 'string' ? sender : sender?.id ?? Object.keys(w.rt.state.bots).find(id => !id.startsWith('peer:')), peer: peerRows(w.rt)[0] }
}

test('a send with the hub online hands exactly one bot/message frame to the hub', async () => {
  const { w, frames, sender, peer } = await world(true)
  const out = await w.rt.deliver({ fromId: sender, toId: peer.id, text: 'hello', role: 'request' })
  assert.equal(out.ok, true)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].kind, 'ask')
  assert.equal(frames[0].to.nodeId, 'hub')
  assert.equal(frames[0].to.id, 'cmd')
  assert.equal(frames[0].from.nodeId, 'n9')
})

test('with the hub offline the send returns E_HUB_OFFLINE, hands nothing over, and never retries', async () => {
  const { w, frames, state, sender, peer } = await world(false)
  const out = await w.rt.deliver({ fromId: sender, toId: peer.id, text: 'hello', role: 'request' })
  assert.deepEqual(out, { ok: false, error: 'E_HUB_OFFLINE' })
  assert.equal(frames.length, 0)
  state.online = true
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(frames.length, 0)
})

test('sendToPeer refuses a row that is not a session peer row', async () => {
  const { w, sender } = await world(true)
  assert.equal(sendToPeer(w.rt, { fromId: sender, toId: sender, text: 'x' }).ok, false)
})
