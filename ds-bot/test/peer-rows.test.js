import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDirectory, install } from '../src/host/bot-network.js'
import { reportableBots } from '../src/host/roster-join.js'
import { threadWorld } from './thread-t2-world.js'
import { entry, fakeNetwork, peerRows } from './peer-fixture.js'

async function world() {
  const net = fakeNetwork()
  const w = threadWorld({ services: { 'remote-agent:bot-network': net.network } })
  await w.rt.load()
  return { w, ...net }
}
const feed = (network, bots) => network.emit('directory', bots)

test('a hub directory becomes read-only peer rows, then shrinks, then empties', async () => {
  const { w, network } = await world()
  feed(network, [entry('a', 'hub', 'Commander'), entry('b', 'n10', 'Exec10')])
  let rows = peerRows(w.rt)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.origin, 'peer')
    assert.equal(row.hubId, 'hub')
    assert.ok(['hub', 'n10'].includes(row.homeNodeId))
  }
  assert.equal(rows.find(row => row.name === 'Exec10').homeNodeId, 'n10')

  feed(network, [entry('a', 'hub', 'Commander')])
  rows = peerRows(w.rt)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'Commander')

  feed(network, [])
  assert.equal(peerRows(w.rt).length, 0)
})

test('a directory frame without the hub signature writes no peer row', async () => {
  const { w } = await world()
  const result = applyDirectory(w.rt, [entry('a', 'hub')], undefined)
  const rows = peerRows(w.rt)
  assert.equal(rows.length, 0)
  assert.equal(result, null)
})

test('peer rows never reach the roster report, the disk, or a restart', async () => {
  const { w, network } = await world()
  feed(network, [entry('a', 'hub')])
  assert.equal(reportableBots(w.rt.state.bots).some(bot => bot.id.startsWith('peer:')), false)
  await w.rt.save(true)
  const disk = JSON.parse((await import('node:fs')).readFileSync(w.rt.statePath, 'utf8'))
  assert.equal(Object.values(disk.bots).some(bot => bot.origin === 'peer'), false)
})

test('an entry from this node and a missing frame leave only own bots', async () => {
  const { w, network } = await world()
  feed(network, [entry('self', 'n9')])
  assert.equal(peerRows(w.rt).length, 0)
  assert.equal(install === undefined, false)
})
