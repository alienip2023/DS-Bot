// M2: a node's Bot list becomes read-only, dispatchable rows on the hub. These tests
// drive the real store and the real merge (applyInventory) — no fake row writer.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureRegistrySubscription, isNodeBot, MISSING_FRAMES, NODE_PREFIX } from '../src/host/node-inventory.js'
import { inventory, NODE, NODE_BOT, seedTeam, settle, startWorld } from './node-inventory-world.js'

test('D1 an inventory creates one node row per Bot, with no Session and no Thread', async (t) => {
  const w = await startWorld(seedTeam())
  t.after(w.stop)
  const result = await w.rt.applyNodeInventory(inventory({
    bots: [{ id: 'b1', name: 'One', role: 'R1', model: 'deepseek-v4', createdAt: 11 }, { id: 'b2', name: 'Two', role: 'R2' }],
  }))
  assert.equal(result.ok, true)
  const one = w.rt.state.bots[NODE_BOT]
  assert.equal(one.name, 'One')
  assert.equal(one.role, 'R1')
  assert.equal(one.model, 'deepseek-v4')
  assert.equal(one.origin, 'node')
  assert.equal(one.type, 'remote-worker')
  assert.equal(one.managedBy, 'node')
  assert.equal(one.readonly, true)
  assert.equal(one.dispatchable, true)
  assert.equal(one.worker.home, 'node')
  assert.equal(one.worker.nodeId, NODE)
  assert.equal(one.worker.remoteBotId, 'b1')
  assert.equal(one.worker.hostname, 'box-1')
  assert.equal(one.worker.online, true)
  assert.equal('sessionId' in one, false)
  assert.equal('threadIds' in one, false)
  assert.equal(Object.values(w.rt.state.threads).some(thread => thread.botId === one.id), false, 'no Main Thread for a node row')
  assert.equal(isNodeBot(w.rt.state.bots[`${NODE_PREFIX}${NODE}:b2`]), true)
  const ack = w.frames.find(frame => frame.type === 'bot/inventory-ack').payload
  assert.equal(ack.nodeId, NODE)
  assert.equal(ack.ok, true)
  assert.equal(ack.applied, 2)
  assert.equal(typeof ack.at, 'number')
})

test('D2 the same inventory is idempotent and keeps the first createdAt', async (t) => {
  const w = await startWorld(seedTeam())
  t.after(w.stop)
  const frame = inventory({ bots: [{ id: 'b1', name: 'One', role: 'R', createdAt: 11 }] })
  await w.rt.applyNodeInventory(frame)
  const before = w.rt.state.bots[NODE_BOT].createdAt
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One renamed', role: 'R', createdAt: 11 }], at: 2000 }))
  const rows = Object.values(w.rt.state.bots).filter(isNodeBot)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'One renamed')
  assert.equal(rows[0].createdAt, before)
  assert.equal(rows[0].worker.firstSeenAt, 1000)
})

test('D3 a joined row for the same node Bot wins; the inventory only refreshes it', async (t) => {
  const joinedId = 'joined:n1:rb1'
  const w = await startWorld(seedTeam({
    bots: {
      [joinedId]: {
        id: joinedId, name: 'Mine', role: 'Mine', model: 'my-model', origin: 'joined', type: 'remote-worker',
        worker: { nodeId: 'n1', remoteBotId: 'rb1', hostname: 'box-1', home: 'remote', online: false },
        createdAt: 2,
      },
    },
  }))
  t.after(w.stop)
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'rb1', name: 'Theirs', role: 'Other' }] }))
  assert.equal(w.rt.state.bots[joinedId].name, 'Mine')
  assert.equal(w.rt.state.bots[joinedId].model, 'my-model')
  assert.equal(w.rt.state.bots[joinedId].worker.online, true)
  assert.equal(w.rt.state.bots['node:n1:rb1'], undefined, 'no duplicate row')
  assert.equal(Object.values(w.rt.state.bots).filter(isNodeBot).length, 0)
})

test('D4 a node row is not indexed as a local Session or Thread', async (t) => {
  const w = await startWorld(seedTeam())
  t.after(w.stop)
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }] }))
  await w.rt.load()
  assert.equal(w.rt.bySessionId?.(NODE_BOT), undefined)
  assert.equal(w.rt.chatOwners.get(NODE_BOT), undefined, 'not indexed as a local chat either')
  assert.equal(w.rt.isBotSession?.(NODE_BOT), false)
  assert.equal(Object.values(w.rt.state.threads).some(thread => thread.botId === NODE_BOT), false)
})

test('D5 a row missing from twelve reports in a row is removed, not before', async (t) => {
  const w = await startWorld(seedTeam())
  t.after(w.stop)
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }, { id: 'b2', name: 'Two', role: 'R' }] }))
  assert.equal(MISSING_FRAMES, 12, 'the product keeps twelve misses before deleting')
  for (let i = 0; i < 11; i += 1) {
    await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }], at: 2000 + i }))
  }
  assert.equal(w.rt.state.bots['node:n1:b2'] !== undefined, true, 'still listed before the twelfth miss')
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }], at: 3000 }))
  assert.equal(w.rt.state.bots['node:n1:b2'], undefined)
})

test('D6 a truncated report does not count as a deletion', async (t) => {
  const w = await startWorld(seedTeam())
  t.after(w.stop)
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }, { id: 'b2', name: 'Two', role: 'R' }] }))
  for (let i = 0; i < MISSING_FRAMES + 2; i += 1) {
    await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }], truncated: true, at: 2000 + i }))
  }
  assert.notEqual(w.rt.state.bots['node:n1:b2'], undefined)
  assert.equal(w.rt.state.bots['node:n1:b2'].worker.missingFrames, 0)
})

test('D7 nodeOffline greys the rows out and keeps them', async (t) => {
  const w = await startWorld(seedTeam())
  t.after(w.stop)
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }] }))
  ensureRegistrySubscription(w.rt)
  w.registry.emit('nodeOffline', { nodeId: NODE })
  await settle()
  assert.equal(w.rt.state.bots[NODE_BOT].worker.online, false)
  assert.notEqual(w.rt.state.bots[NODE_BOT], undefined)
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }], at: 5000 }))
  assert.equal(w.rt.state.bots[NODE_BOT].worker.online, true)
})

test('D8 with the switch off no rows appear, but the frame is acknowledged', async (t) => {
  const w = await startWorld(seedTeam({ prefs: { nodeInventory: false } }))
  t.after(w.stop)
  const result = await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }] }))
  assert.equal(result.ok, true)
  assert.equal(w.rt.nodeBots().length, 0)
  const ack = w.frames.filter(frame => frame.type === 'bot/inventory-ack').at(-1).payload
  assert.equal(ack.nodeId, NODE)
  assert.equal(ack.ok, true)
  assert.equal(ack.applied, 0)
})

test('D9 a failed save restores the previous rows and records lastError', async (t) => {
  const w = await startWorld(seedTeam())
  t.after(w.stop)
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }] }))
  const before = JSON.parse(JSON.stringify(w.rt.state.bots[NODE_BOT]))
  const realSave = w.rt.save
  w.rt.save = async () => { throw new Error('disk full') }
  const result = await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'Changed', role: 'R' }, { id: 'b2', name: 'New', role: 'R' }], at: 2000 }))
  w.rt.save = realSave
  assert.equal(result.ok, false)
  assert.deepEqual(w.rt.state.bots[NODE_BOT], before, 'the old row is restored exactly')
  assert.equal(w.rt.state.bots['node:n1:b2'], undefined)
  assert.equal(w.rt.state.nodeInventory.lastError.code, 'save-failed')
  assert.equal(w.frames.filter(frame => frame.type === 'bot/inventory-ack').at(-1).payload.ok, false)
})

test('D10 two Bots with the same name stay two rows', async (t) => {
  const w = await startWorld(seedTeam())
  t.after(w.stop)
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'Same', role: 'R' }, { id: 'b2', name: 'Same', role: 'R' }] }))
  assert.equal(w.rt.nodeBots().length, 2)
  assert.equal(w.rt.nodeBots()[0].name, 'Same')
  assert.equal(w.rt.nodeBots()[1].name, 'Same')
})

test('D11 enabled:false clears the node rows at once', async (t) => {
  const w = await startWorld(seedTeam())
  t.after(w.stop)
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R' }] }))
  assert.equal(w.rt.nodeBots().length, 1)
  await w.rt.applyNodeInventory(inventory({ enabled: false, bots: [], at: 4000 }))
  assert.equal(w.rt.nodeBots().length, 0)
  const ack = w.frames.filter(frame => frame.type === 'bot/inventory-ack').at(-1).payload
  assert.equal(ack.nodeId, NODE)
  assert.equal(ack.ok, true)
  assert.equal(ack.applied, 0)
})
