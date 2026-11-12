// A peer row is read-only here: every local mutation refuses it with a coded error,
// and delivery refuses to dispatch to it before any remote-worker path runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handlePeerRoster, peerId } from '../src/host/federation.js'
import { makeBot, threadWorld } from './thread-t2-world.js'

const report = { hubId: 'hub-a', level: 'roster', hostname: 'mac-b', bots: [{ id: 'b1', name: 'Bravo', role: 'Engineer', main: true }] }

async function world() {
  const w = threadWorld()
  await w.rt.load()
  await makeBot(w, 'Alpha')
  await w.rt.setFederationLevel('roster')
  await handlePeerRoster(w.rt, report)
  return { w, id: peerId('hub-a', 'b1') }
}

test('updateBot refuses a shadow with a code the channel can map', async () => {
  const { w, id } = await world()
  await assert.rejects(w.rt.updateBot(id, { name: 'Mine now' }), error => error.code === 'E_SHADOW_READONLY')
  assert.equal(w.rt.state.bots[id].name, 'Bravo')
})

test('deleteBot refuses a shadow and never runs the joined delete path', async () => {
  const { w, id } = await world()
  let joined = 0
  const realJoined = w.rt.joinedDeleteBot
  w.rt.joinedDeleteBot = async () => { joined += 1 }
  try {
    await assert.rejects(w.rt.deleteBot(id), error => error.code === 'E_SHADOW_READONLY')
  } finally {
    w.rt.joinedDeleteBot = realJoined
  }
  assert.equal(joined, 0)
  assert.equal(w.rt.state.bots[id] !== undefined, true)
})

test('createThread refuses a shadow: no Thread, no Session, no model', async () => {
  const { w, id } = await world()
  const threadsBefore = Object.keys(w.rt.state.threads).length
  await assert.rejects(w.rt.createThread({ botId: id }), error => error.code === 'E_SHADOW_READONLY')
  assert.equal(Object.keys(w.rt.state.threads).length, threadsBefore)
  assert.equal(Object.values(w.rt.state.threads).some(thread => thread.botId === id), false)
})

test('delivery refuses a shadow before the remote-worker path', async () => {
  const { w, id } = await world()
  const out = await w.rt.deliver({ toId: id, text: 'hello', role: 'request' })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'E_PEER_NOT_ENABLED')
})

test('the channel answers bot/refused for a shadow menu action', async () => {
  const { w, id } = await world()
  const updated = await w.call('update-bot', { id, patch: { name: 'Mine now' } })
  assert.equal(updated.ok, false)
  assert.equal(updated.error.code, 'bot/refused')
  const deleted = await w.call('delete-bot', { id })
  assert.equal(deleted.ok, false)
  assert.equal(deleted.error.code, 'bot/refused')
  assert.equal(w.rt.state.bots[id] !== undefined, true)
})

test('the federation endpoint reads the level and writes it only from a body.level', async () => {
  const { w } = await world()
  const first = await w.call('federation')
  assert.equal(first.ok, true)
  assert.equal(first.value.level, 'roster')
  await w.rt.setFederationLevel('off')
  const before = await w.call('federation')
  assert.equal(before.value.level, 'off')
  const set = await w.call('federation', { level: 'roster' })
  assert.equal(set.ok, true)
  assert.equal(set.value.level, 'roster')
  const bad = await w.call('federation', { level: 'everything' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bot/invalid')
  assert.equal(w.rt.state.prefs.federation, 'roster')
})
