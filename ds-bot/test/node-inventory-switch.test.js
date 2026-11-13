// M2: the node-inventory switch must be reachable, not just a pref default. These tests
// drive the real channel endpoint, the real runtime and the provider dsh-remote-agent reads.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { inventory, NODE_BOT, seedTeam, startWorld } from './node-inventory-world.js'

const JOINED = 'joined:n1:rb1'

function seed(over = {}) {
  return seedTeam({
    prefs: { nodeInventory: false },
    bots: {
      [JOINED]: {
        id: JOINED, name: 'Remote', origin: 'joined', type: 'remote-worker',
        worker: { nodeId: 'n1', remoteBotId: 'rb1', hostname: 'box-1', home: 'remote', online: true },
        createdAt: 2,
      },
      ...(over.bots ?? {}),
    },
    ...over,
  })
}

test('S1 the switch reads and writes through the real endpoint; closing clears rows at once', async (t) => {
  const w = await startWorld(seed())
  t.after(w.stop)

  const off = await w.call('node-inventory')
  assert.equal(off.ok, true)
  assert.equal(off.value.enabled, false)

  const on = await w.call('node-inventory', { enabled: true })
  assert.equal(on.ok, true)
  assert.equal(on.value.enabled, true)
  assert.equal(on.value.rows, 0)

  // The node side reads the same preference: provider.enabled() is what gates reporting.
  const provider = w.ctx.get('remote-agent:node-bots')
  assert.equal(provider.enabled(), true)

  await w.rt.applyNodeInventory(inventory({ bots: [{ id: 'b1', name: 'One', role: 'R1' }] }))
  const listed = await w.call('node-inventory')
  assert.equal(listed.value.rows, 1)

  const closed = await w.call('node-inventory', { enabled: false })
  assert.equal(closed.ok, true)
  assert.equal(closed.value.enabled, false)
  assert.equal(closed.value.applied, 0)
  assert.equal(w.rt.state.bots[NODE_BOT], undefined, 'the node row is gone immediately')
  assert.notEqual(w.rt.state.bots[JOINED], undefined, 'a joined row is not an inventory row')
  assert.equal(provider.enabled(), false)

  const reopened = await w.call('node-inventory', { enabled: true })
  assert.equal(reopened.value.enabled, true)
  assert.equal(w.rt.state.bots[NODE_BOT], undefined, 'reopening waits for the next report')
  await w.rt.applyNodeInventory(inventory({ at: 2000, bots: [{ id: 'b1', name: 'One', role: 'R1' }] }))
  assert.equal(w.rt.state.bots[NODE_BOT]?.name, 'One')
})

test('S2 the switch refuses a value that is not a boolean', async (t) => {
  const w = await startWorld(seed())
  t.after(w.stop)
  const bad = await w.call('node-inventory', { enabled: 'yes' })
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /true or false/)
  assert.equal(w.rt.state.prefs.nodeInventory, false)
})

test('S3 the provider lists local Bots only', async (t) => {
  const w = await startWorld(seed({
    bots: {
      l1: { id: 'l1', name: 'Local', role: 'R', sessionId: 'l1', createdAt: 3 },
      p1: { id: 'p1', name: 'Private', role: 'R', sessionId: 'p1', private: true, createdAt: 4 },
    },
  }))
  t.after(w.stop)
  await w.call('node-inventory', { enabled: true })
  const ids = w.ctx.get('remote-agent:node-bots').list().map(bot => bot.id)
  assert.deepEqual(ids.sort(), ['a', 'l1'])
})

test('S4 turning the switch off with no rows still persists the off state', async (t) => {
  const w = await startWorld(seed())
  t.after(w.stop)
  const on = await w.call('node-inventory', { enabled: true })
  assert.equal(on.value.enabled, true)
  assert.equal(w.rt.state.prefs.nodeInventory, true)

  // No inventory has arrived: there is no row to delete. The off state itself must still
  // reach the disk, otherwise a restart brings the switch back on.
  const off = await w.call('node-inventory', { enabled: false })
  assert.equal(off.value.enabled, false)
  assert.equal(off.value.applied, 0)
  assert.equal(w.rt.state.prefs.nodeInventory, false)

  const disk = JSON.parse(readFileSync(join(w.home, 'state.json'), 'utf8'))
  assert.equal(disk.prefs.nodeInventory, false, 'the off state is on disk')

  await w.rt.load()
  assert.equal(w.rt.state.prefs.nodeInventory, false, 'a reload keeps it off')
})
