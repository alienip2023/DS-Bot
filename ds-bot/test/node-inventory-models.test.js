// M2 item 3: a node row is another machine's Bot. Model sync must never select a model
// for it, rewrite its applied fields, or move it when a route is refused. These tests run
// the real models module inside the real runtime; only llm and the session controller are
// stubs, because there is no provider here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inventory, nodeId, NODE_BOT, seedTeam, startWorld } from './node-inventory-world.js'

async function world(t) {
  const w = await startWorld(seedTeam({
    bots: { l1: { id: 'l1', name: 'Local', role: 'R', sessionId: 'l1', createdAt: 3 } },
  }))
  t.after(w.stop)
  const selects = []
  w.ctx.llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
  }
  w.ctx.sessionController.selectModel = async (arg) => {
    selects.push(arg)
    return { selected: { provider: arg.provider, model: arg.model } }
  }
  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R1', model: 'p/m1' }] }))
  w.rt.dropCatalog()
  await w.rt.catalog()
  return { w, selects, row: () => w.rt.state.bots[NODE_BOT] }
}

test('M1 syncModels skips a node row: no selectModel, applied fields untouched', async (t) => {
  const { w, selects, row } = await world(t)
  await w.rt.syncModels()
  assert.deepEqual(selects.filter(arg => String(arg.sessionId).startsWith('node:')), [])
  assert.equal(row().appliedModel, undefined)
  assert.equal(row().model, 'p/m1')
})

test('M2 applyModel on a node row is a no-op', async (t) => {
  const { w, selects, row } = await world(t)
  const result = await w.rt.applyModel(row())
  assert.equal(result, undefined)
  assert.equal(selects.length, 0)
  assert.equal(row().appliedModel, undefined)
})

test('M3 applyThreadModel on a node row never selects a Session model', async (t) => {
  const { w, selects, row } = await world(t)
  const result = await w.rt.applyThreadModel(row(), `${NODE_BOT}:t1`)
  assert.equal(result, undefined)
  assert.equal(selects.length, 0)
})

test('M4 routeRefused does not move a node row pinned to the refused route', async (t) => {
  const { w, row } = await world(t)
  row().model = 'bad/ref'
  row().appliedModel = 'bad/ref'
  await w.rt.routeRefused('bad/ref')
  assert.equal(row().model, 'bad/ref')
  assert.equal(row().appliedModel, 'bad/ref')
})
