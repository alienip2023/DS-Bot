import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { threadWorld } from './thread-t2-world.js'
import { entry, fakeNetwork, peerRows } from './peer-fixture.js'

async function world() {
  const net = fakeNetwork()
  const w = threadWorld({ services: { 'remote-agent:bot-network': net.network } })
  await w.rt.load()
  net.network.emit('directory', [entry('a', 'hub', 'Commander'), entry('b', 'n10', 'Exec10')])
  await w.rt.save(true)
  return { w, row: peerRows(w.rt)[0] }
}
const disk = w => readFileSync(w.rt.statePath, 'utf8')

test('rename, delete and model change of a peer row return bot/refused and change nothing', async () => {
  const { w, row } = await world()
  const before = disk(w)
  const memory = JSON.stringify(row)
  for (const [endpoint, body] of [
    ['update-bot', { id: row.id, patch: { name: 'Mine now' } }],
    ['update-bot', { id: row.id, patch: { model: 'other/model' } }],
    ['delete-bot', { id: row.id }],
  ]) {
    const result = await w.call(endpoint, body)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bot/refused')
  }
  assert.equal(JSON.stringify(w.rt.state.bots[row.id]), memory)
  assert.equal(disk(w), before)
})

test('the rename path returns the refusal code for a peer row', async () => {
  const { w, row } = await world()
  const result = await w.call('update-bot', { id: row.id, patch: { name: 'x' } })
  assert.equal(result.error.code, 'bot/refused')
  assert.equal(w.rt.state.bots[row.id].name, row.name)
})
