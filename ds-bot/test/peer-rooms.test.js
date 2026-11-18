import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyDirectory, directoryOf, publishDirectory, reapStalePeers, roomsOf } from '../src/host/bot-network.js'
import { applyRosterReport } from '../src/host/roster-join.js'
import { entry, fakeNetwork, peerRows } from './peer-fixture.js'
import { makeBot, threadWorld } from './thread-t2-world.js'

async function world(t, services = {}) {
  const net = fakeNetwork()
  const home = mkdtempSync(join(import.meta.dirname, '../.dsh-test-peer-rooms-'))
  const w = threadWorld({ home, services: { 'remote-agent:bot-network': net.network, ...services } })
  t.after(async () => {
    try { await w.ctx.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  })
  await w.rt.load()
  const bot = await makeBot(w, 'Local')
  const list = args => w.rt.teamTools.find(tool => tool.name === 'list_bots').execute(args ?? {}, { agent: { id: w.rt.chatOf(bot.id) } })
  return { ...w, ...net, bot, list }
}

const rooms = [
  { id: 'review', name: '二开收口', members: 2 },
  { id: 'deploy', name: 'Deployment', members: 3 },
]
const bots = [entry('commander', 'hub', 'Commander')]

test('a directory frame with rooms fills hubRooms and list_bots prints every room', async t => {
  const w = await world(t)
  w.network.emit('directory', { bots, rooms, at: Date.now() })
  const text = await w.list()
  assert.match(text, /"二开收口"/)
  assert.match(text, /"Deployment"/)
  assert.match(text, /"二开收口" — 2 members \(hub, read-only\)/)
  assert.match(text, /"Deployment" — 3 members \(hub, read-only\)/)
  assert.deepEqual(w.rt.hubRooms, rooms)
  assert.equal(peerRows(w.rt)[0].name, 'Commander')
  await w.rt.save(true)
  const disk = JSON.parse(readFileSync(w.rt.statePath, 'utf8'))
  assert.equal(Object.hasOwn(disk, 'hubRooms'), false)
  assert.deepEqual(disk.rooms, {})
})

test('a legacy bare array clears rooms and reports none you can see while the hub is online', async t => {
  const w = await world(t)
  w.network.emit('directory', { bots, rooms })
  w.network.emit('directory', bots)
  assert.deepEqual(w.rt.hubRooms, [])
  const text = await w.list()
  assert.match(text, /Hub group chats: none you can see\./)
  assert.doesNotMatch(text, /unavailable/)
  assert.doesNotMatch(text, /二开收口/)
  w.network.emit('directory', { bots, rooms })
  w.network.emit('directory', { bots })
  assert.deepEqual(w.rt.hubRooms, [])
})

test('invalid rooms are dropped and valid names are trimmed and capped at 40 characters', async t => {
  const w = await world(t)
  const longName = 'x'.repeat(50)
  w.network.emit('directory', { bots, rooms: [
    null,
    { name: 'No id', members: 1 },
    { id: '', name: 'Empty id', members: 1 },
    { id: '   ', name: 'Blank id', members: 1 },
    { id: 'negative', name: 'Negative', members: -1 },
    { id: 'not-name', name: 42, members: 1 },
    { id: 'fraction', name: 'Fraction', members: 1.5 },
    { id: 'infinite', name: 'Infinite', members: Infinity },
    { id: 'nan', name: 'NaN', members: NaN },
    { id: 'string', name: 'String count', members: '2' },
    { id: 'trim', name: '  Review  ', members: 0, extra: 'ignored' },
    { id: 'long', name: `  ${longName}  `, members: 4 },
  ] })
  assert.deepEqual(w.rt.hubRooms, [
    { id: 'trim', name: 'Review', members: 0 },
    { id: 'long', name: longName.slice(0, 40), members: 4 },
  ])
})

test('more than 100 valid rooms keeps exactly the first 100', async t => {
  const w = await world(t)
  const many = Array.from({ length: 105 }, (_, i) => ({ id: `r${i}`, name: `Room ${i}`, members: i }))
  w.network.emit('directory', { bots, rooms: [{ name: 'Invalid', members: 0 }, ...many] })
  assert.equal(w.rt.hubRooms.length, 100)
  assert.deepEqual(w.rt.hubRooms, many.slice(0, 100))
})

test('a stale directory clears rooms and peers using the injected time', async t => {
  const w = await world(t)
  w.network.emit('directory', { bots, rooms })
  const now = Date.now()
  assert.equal(reapStalePeers(w.rt, now + 179_000), false)
  assert.deepEqual(w.rt.hubRooms, rooms)
  assert.equal(reapStalePeers(w.rt, now + 180_000), true)
  assert.deepEqual(w.rt.hubRooms, [])
  assert.equal(peerRows(w.rt).length, 0)
  const text = await w.list()
  assert.match(text, /Hub group chats: unavailable, the hub is offline\./)
  assert.doesNotMatch(text, /二开收口|Deployment/)
})

test('hub payloads include real room member counts and exclude private rooms', async t => {
  const registry = new EventEmitter()
  const frames = []
  registry.onlineNodes = () => [{ nodeId: 'n9' }]
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true }
  const w = await world(t, { 'remote-agent:registry': registry })
  const other = await makeBot(w, 'Other')
  const [joined] = applyRosterReport(w.rt.state, { nodeId: 'n9', bots: [{ id: 'remote', name: 'Node nine' }] })
  const room = await w.rt.createRoom({ name: 'Public', members: [w.bot.id, other.id, joined.id] })
  const privateRoom = await w.rt.createRoom({ name: 'Private', members: [w.bot.id, other.id, joined.id] })
  privateRoom.private = true
  assert.deepEqual(room.members, [w.bot.id, other.id, joined.id])
  assert.deepEqual(roomsOf(w.rt), [{ id: room.id, name: 'Public', members: 3 }])
  frames.length = 0
  await publishDirectory(w.rt)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].nodeId, 'n9')
  assert.equal(frames[0].type, 'bot/directory')
  assert.deepEqual(frames[0].payload.bots, directoryOf(w.rt))
  assert.deepEqual(frames[0].payload.rooms, [{ id: room.id, name: 'Public', members: 3 }])
  assert.equal(typeof frames[0].payload.at, 'number')
})

test('room renames and membership changes republish without changing Bot rows', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const registry = new EventEmitter()
  const frames = []
  registry.onlineNodes = () => [{ nodeId: 'n9' }]
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true }
  const w = await world(t, { 'remote-agent:registry': registry })
  const other = await makeBot(w, 'Other')
  const [joined] = applyRosterReport(w.rt.state, { nodeId: 'n9', bots: [{ id: 'remote', name: 'Node nine' }] })
  const room = await w.rt.createRoom({ name: 'Team', members: [w.bot.id, other.id, joined.id] })
  await w.rt.save(true)
  t.mock.timers.tick(1_000)
  await Promise.resolve()
  const before = directoryOf(w.rt)
  for (const patch of [{ name: 'Renamed' }, { members: [w.bot.id, joined.id] }]) {
    frames.length = 0
    Object.assign(room, patch)
    await w.rt.save(true)
    t.mock.timers.tick(999)
    assert.equal(frames.length, 0)
    t.mock.timers.tick(1)
    await Promise.resolve()
    assert.equal(frames.length, 1)
    assert.deepEqual(frames[0].payload.bots, before)
    assert.deepEqual(frames[0].payload.rooms, [{ id: room.id, name: room.name, members: room.members.length }])
  }
})

test('hub room publication is capped at 100 visible rooms', () => {
  const many = Array.from({ length: 105 }, (_, i) => ({ id: `r${i}`, name: `Room ${i}`, members: ['a', 'b'] }))
  const rt = { state: { rooms: Object.fromEntries([
    ['private', { id: 'private', name: 'Private', private: true, members: ['a'] }],
    ...many.map(room => [room.id, room]),
  ]) } }
  const result = roomsOf(rt)
  assert.equal(result.length, 100)
  assert.deepEqual(result[99], { id: 'r99', name: 'Room 99', members: 2 })
})

test('an untrusted directory cannot replace hub rooms', async t => {
  const w = await world(t)
  w.network.emit('directory', { bots, rooms })
  assert.equal(applyDirectory(w.rt, { bots: [], rooms: [] }, undefined), null)
  assert.deepEqual(w.rt.hubRooms, rooms)
  assert.equal(peerRows(w.rt).length, 1)
})

test('a group or Bot scoped list suppresses the hub rooms', async t => {
  const w = await world(t)
  const other = await makeBot(w, 'Other')
  const room = await w.rt.createRoom({ name: 'Local team', members: [w.bot.id, other.id] })
  w.network.emit('directory', { bots, rooms })
  for (const args of [{ group: room.name }, { bot: w.bot.name }]) {
    const text = await w.list(args)
    assert.match(text, /Local team/)
    assert.doesNotMatch(text, /hub, read-only|Hub group chats|二开收口|Deployment/)
  }
})
