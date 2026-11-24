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

test('a send with the hub online hands exactly one bot/assign frame to the hub (rewrite R2)', async () => {
  const { w, frames, assigns, sender, peer } = await world(true)
  const out = await w.rt.deliver({ fromId: sender, toId: peer.id, text: 'hello', role: 'request' })
  assert.equal(out.ok, true)
  assert.equal(out.away, false)
  assert.equal(frames.length, 0, 'no bot/message any more')
  assert.equal(assigns.length, 1)
  assert.equal(assigns[0].op, 'deliver')
  assert.equal(assigns[0].role, 'request')
  assert.equal(assigns[0].to.nodeId, 'hub')
  assert.equal(assigns[0].to.id, 'cmd')
  assert.equal(assigns[0].from.nodeId, 'n9')
  assert.equal(assigns[0].from.id, `joined:n9:${encodeURIComponent(sender)}`, 'the sender goes by its team-wide id')
  assert.equal(w.rt.assign.pending().length, 1, 'kept until the hub acks it')
})

test('with the hub offline the send is kept (away) and goes when the hub is back (rewrite R2)', async () => {
  const { w, assigns, state, sender, peer } = await world(false)
  const out = await w.rt.deliver({ fromId: sender, toId: peer.id, text: 'hello', role: 'request' })
  assert.equal(out.ok, true)
  assert.equal(out.away, true)
  assert.equal(assigns.length, 0)
  state.online = true
  await w.rt.assign.flush({ force: true })
  assert.equal(assigns.length, 1)
  assert.equal(assigns[0].text, 'hello')
})

test('sendToPeer refuses a row that is not a session peer row', async () => {
  const { w, sender } = await world(true)
  assert.equal(sendToPeer(w.rt, { fromId: sender, toId: sender, text: 'x' }).ok, false)
})
