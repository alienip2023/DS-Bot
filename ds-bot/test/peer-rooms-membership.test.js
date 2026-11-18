import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { directoryOf, HUB_NODE, publishDirectory } from '../src/host/bot-network.js'
import { applyRosterReport } from '../src/host/roster-join.js'
import { fakeNetwork } from './peer-fixture.js'
import { makeBot, threadWorld } from './thread-t2-world.js'

async function world(t) {
  const net = fakeNetwork()
  const registry = new EventEmitter()
  const frames = []
  const warnings = []
  registry.onlineNodes = () => ['node009', 'node010', HUB_NODE, 'node011'].map(nodeId => ({ nodeId }))
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true }
  const home = mkdtempSync(join(import.meta.dirname, '../.dsh-test-peer-rooms-membership-'))
  const w = threadWorld({ home, services: { 'remote-agent:bot-network': net.network, 'remote-agent:registry': registry } })
  t.after(async () => {
    try { await w.ctx.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  })
  await w.rt.load()
  const bot = await makeBot(w, 'Local')
  const [node009] = applyRosterReport(w.rt.state, { nodeId: 'node009', bots: [{ id: 'same', name: 'Nine' }] })
  const [node010, other010] = applyRosterReport(w.rt.state, {
    nodeId: 'node010', bots: [{ id: 'same', name: 'Ten' }, { id: 'other', name: 'Other ten' }],
  })
  w.rt.warn = (...args) => warnings.push(args)
  const publish = async () => { frames.length = 0; await publishDirectory(w.rt) }
  const payload = nodeId => {
    const frame = frames.find(frame => frame.nodeId === nodeId)
    assert.equal(frame?.type, 'bot/directory')
    return frame.payload
  }
  return { ...w, bot, node009, node010, other010, registry, frames, warnings, publish, payload }
}

const summary = room => ({ id: room.id, name: room.name, members: room.members.length })

test('node009 receives a room containing its roster bot and preserves the payload shape', async t => {
  const w = await world(t)
  const room = await w.rt.createRoom({ name: 'Nine and hub', members: [w.node009.id, w.bot.id] })
  assert.deepEqual(room.members, ['joined:node009:same', w.bot.id])
  await w.publish()
  const payload = w.payload('node009')
  assert.deepEqual(Object.keys(payload).sort(), ['at', 'bots', 'rooms'])
  assert.deepEqual(payload.bots, directoryOf(w.rt))
  assert.equal(typeof payload.at, 'number')
  assert.deepEqual(payload.rooms, [summary(room)])
  assert.equal(typeof payload.rooms[0].members, 'number')
})

test('node009 cannot see a room whose members belong only to node010', async t => {
  const w = await world(t)
  const room = await w.rt.createRoom({ name: 'Ten only', members: [w.node010.id, w.other010.id] })
  await w.publish()
  assert.deepEqual(w.payload('node009').rooms, [], 'node009 must not receive node010-only rooms')
  assert.deepEqual(w.payload('node010').rooms, [summary(room)])
})

test('a room containing bots from both nodes is visible to both', async t => {
  const w = await world(t)
  const room = await w.rt.createRoom({ name: 'Shared', members: [w.node009.id, w.node010.id] })
  await w.publish()
  for (const nodeId of ['node009', 'node010']) assert.deepEqual(w.payload(nodeId).rooms, [summary(room)])
})

test('private rooms are excluded from every node including the hub', async t => {
  const w = await world(t)
  const room = await w.rt.createRoom({ name: 'Private', members: [w.node009.id, w.node010.id] })
  room.private = true
  await w.publish()
  for (const { payload } of w.frames) assert.deepEqual(payload.rooms, [])
})

test('the hub keeps every non-private room and a node without member bots sees none', async t => {
  const w = await world(t)
  const other = await makeBot(w, 'Other local')
  const rooms = [
    await w.rt.createRoom({ name: 'Hub only', members: [w.bot.id, other.id] }),
    await w.rt.createRoom({ name: 'Nine', members: [w.node009.id, w.bot.id] }),
    await w.rt.createRoom({ name: 'Ten', members: [w.node010.id, w.other010.id] }),
  ]
  await w.publish()
  assert.deepEqual(w.payload(HUB_NODE).rooms, rooms.map(summary))
  assert.deepEqual(w.payload('node011').rooms, [])
})

test('the 100-room cap applies after filtering for each node', async t => {
  const w = await world(t)
  const rooms = ['node010', 'node009'].flatMap(nodeId => Array.from({ length: 105 }, (_, i) => ({
    id: `${nodeId}-${i}`, name: `${nodeId} room ${i}`, members: [w[nodeId].id, w.bot.id],
  })))
  w.rt.state.rooms = Object.fromEntries(rooms.map(room => [room.id, room]))
  await w.publish()
  for (const nodeId of ['node009', 'node010']) {
    assert.deepEqual(w.payload(nodeId).rooms, rooms.filter(room => room.id.startsWith(nodeId)).slice(0, 100).map(summary))
  }
  assert.deepEqual(w.payload(HUB_NODE).rooms, rooms.slice(0, 100).map(summary))
})

test('replacing a member from another node republishes even when the member count stays the same', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const w = await world(t)
  const room = await w.rt.createRoom({ name: 'Moving', members: [w.node009.id, w.bot.id] })
  await w.rt.save(true)
  t.mock.timers.tick(1_000)
  await Promise.resolve()
  w.frames.length = 0
  room.members = [w.node010.id, w.bot.id]
  await w.rt.save(true)
  t.mock.timers.tick(999)
  assert.equal(w.frames.length, 0)
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.equal(w.frames.length, 4)
  assert.deepEqual(w.payload('node009').rooms, [])
  assert.deepEqual(w.payload('node010').rooms, [summary(room)])
})

test('a failed directory send warns and continues to the next node', async t => {
  const w = await world(t)
  const room = await w.rt.createRoom({ name: 'Shared', members: [w.node009.id, w.node010.id] })
  const send = w.registry.send
  const error = new Error('send failed')
  w.registry.send = (nodeId, type, payload) => {
    if (nodeId === 'node009') throw error
    return send(nodeId, type, payload)
  }
  w.warnings.length = 0
  await w.publish()
  assert.deepEqual(w.warnings, [['ds-bot: Bot directory send to %s failed: %s', 'node009', error]])
  assert.deepEqual(w.frames.map(frame => frame.nodeId), ['node010', HUB_NODE, 'node011'])
  assert.deepEqual(w.payload('node010').rooms, [summary(room)])
})
