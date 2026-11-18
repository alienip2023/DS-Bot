import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installNetwork, reapStalePeers } from '../src/host/bot-network.js'
import { install as installTools } from '../src/host/tools.js'
import { fakeContext } from './fake-ctx.js'
import { entry, fakeNetwork, peerRows } from './peer-fixture.js'

function world(t, { install = true, network = fakeNetwork().network } = {}) {
  const ctx = fakeContext({ services: { 'remote-agent:bot-network': network } })
  const bot = { id: 'local', name: 'Local', sessionId: 'local-chat' }
  const rt = {
    ctx, state: { bots: { local: bot }, rooms: {} }, teamTools: [],
    load: async () => {}, selfOf: () => bot.id, isMain: () => false,
    findBot: name => Object.values(rt.state.bots).find(bot => bot.name === name),
    statusOf: () => 'idle',
  }
  t.after(() => ctx.dispose())
  if (install) installNetwork(rt)
  else rt.botNetwork = network
  installTools(rt)
  const list = () => rt.teamTools.find(tool => tool.name === 'list_bots').execute({}, { agent: { id: bot.sessionId } })
  return { rt, ctx, network, list }
}

test('online before the first directory frame does not report the hub offline', async t => {
  const w = world(t)
  assert.equal(peerRows(w.rt).length, 0)
  const text = await w.list()
  assert.doesNotMatch(text, /Hub group chats: unavailable, the hub is offline\./)
  assert.match(text, /Hub group chats: none you can see\./)
  assert.equal(w.rt.hubOnline(), true)
})

test('fresh directory frames renew online even with no peer rows', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const w = world(t)
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(179_000)
    w.network.emit('directory', { bots: [entry('self', 'n9')], rooms: [] })
    assert.equal(peerRows(w.rt).length, 0)
    assert.equal(w.rt.hubOnline(), true)
    assert.equal(reapStalePeers(w.rt), false)
    assert.match(await w.list(), /Hub group chats: none you can see\./)
  }
})

test('reaping a stale directory with no observable live link reports offline', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const w = world(t)
  const rooms = [{ id: 'review', name: 'Review', members: 2 }]
  w.network.emit('directory', { bots: [entry('commander', 'hub')], rooms })
  const at = Date.now()
  assert.equal(w.rt.hubOnline(), true)
  assert.match(await w.list(), /"Review" — 2 members \(hub, read-only\)/)
  assert.equal(reapStalePeers(w.rt, at + 179_999), false)
  assert.equal(w.rt.hubOnline(), true)
  assert.equal(reapStalePeers(w.rt, at + 180_000), true)
  assert.equal(w.rt.hubOnline(), false)
  assert.deepEqual(w.rt.hubRooms, [])
  assert.equal(peerRows(w.rt).length, 0)
  assert.match(await w.list(), /Hub group chats: unavailable, the hub is offline\./)
  w.network.emit('directory', { bots: [], rooms: [] })
  assert.equal(w.rt.hubOnline(), true)
  assert.match(await w.list(), /Hub group chats: none you can see\./)
})

test('the initial lease expires without any directory frame', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const w = world(t)
  t.mock.timers.tick(179_999)
  assert.equal(w.rt.hubOnline(), true)
  t.mock.timers.tick(1)
  assert.equal(w.rt.hubOnline(), false)
  assert.equal(reapStalePeers(w.rt), false)
  assert.equal(w.rt.hubOnline(), false)
  assert.match(await w.list(), /Hub group chats: unavailable, the hub is offline\./)
})

test('list_bots falls back to peer rows only when hubOnline is absent', async t => {
  const w = world(t, { install: false })
  assert.equal(w.rt.hubOnline, undefined)
  assert.match(await w.list(), /Hub group chats: unavailable, the hub is offline\./)
  w.rt.state.bots.peer = { id: 'peer', name: 'Peer', origin: 'peer' }
  assert.match(await w.list(), /Hub group chats: none you can see\./)
  w.rt.hubOnline = () => false
  assert.match(await w.list(), /Hub group chats: unavailable, the hub is offline\./)
})

test('disposing clears the online signal and invalidates retained callbacks', async t => {
  const w = world(t)
  const online = w.rt.hubOnline
  assert.equal(online(), true)
  await w.ctx.dispose()
  assert.equal(w.rt.botNetwork, undefined)
  assert.equal(w.rt.hubOnline, undefined)
  assert.equal(online(), false)
  w.network.emit('directory', { bots: [entry('late', 'hub')], rooms: [] })
  assert.equal(peerRows(w.rt).length, 0)
})
