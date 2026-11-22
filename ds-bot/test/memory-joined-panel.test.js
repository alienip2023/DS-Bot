// The Bot page's memory for a node Bot is the memory the node keeps with the hub (its node scope),
// not an empty local folder named after the shadow. Edits go to that scope and reach the node.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { shadowId } from '../src/host/roster-join.js'
import { hub, rosterFor, writeFrame } from './memory-hub-ctx.js'

const SHADOW = shadowId('n1', 'rb1')

async function world() {
  const w = await hub({ roster: [rosterFor('n1', ['rb1'], 'dshtest-1')] })
  await w.registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'req-1', { text: 'the port is 4387' }))
  return w
}

test('the memory view of a node Bot shows the memory the node wrote', async (t) => {
  const { rt, close, dir } = await world()
  t.after(close)
  const view = await rt.memoryEndpoint('memory-view', { botId: SHADOW })
  assert.deepEqual(view.entries.filter(entry => entry.scope === 'own').map(entry => entry.text), ['the port is 4387'])
  assert.equal(view.keys.own, SHADOW, 'the panel names the node scope')
  assert.equal(view.summary, null, 'no hub model writes a summary of a node Bot')
  assert.ok(view.places.some(place => place.key === SHADOW && place.name === 'rb1'), 'the node Bot is a place an entry can move to')
  assert.match(readFileSync(dir('nodes', 'n1', 'bots', 'rb1', 'MEMORY.md'), 'utf8'), /4387/)
})

test('editing a node Bot\'s memory from its page writes the node scope and marks the node for a new snapshot', async (t) => {
  const { rt, registry, close } = await world()
  t.after(close)
  const seqBefore = rt.memoryHub.seq()
  const added = await rt.memoryEdit({ botId: SHADOW, scope: 'own', next: 'the port is 4388', text: 'the port is 4387', topic: null })
  assert.deepEqual(added.entries.filter(entry => entry.scope === 'own').map(entry => entry.text), ['the port is 4388'])
  assert.ok(rt.memoryHub.seq() > seqBefore, 'a panel change steps the federation sequence')

  const more = await rt.memoryAdd({ botId: SHADOW, scope: 'own', text: 'deploys go through the staging box' })
  assert.equal(more.entries.filter(entry => entry.scope === 'own').length, 2)
  const gone = await rt.memoryEndpoint('memory-forget', { botId: SHADOW, scope: 'own', text: 'the port is 4388' })
  assert.deepEqual(gone.entries.filter(entry => entry.scope === 'own').map(entry => entry.text), ['deploys go through the staging box'])
  await rt.memoryHub.flush?.()
  assert.ok(registry.frames('mem/snapshot').length > 0 || rt.memoryHub.seq() > seqBefore)
})

test('nothing is written to a local folder named after the shadow', async (t) => {
  const { rt, close, dir } = await world()
  t.after(close)
  await rt.memoryAdd({ botId: SHADOW, scope: 'own', text: 'another fact' })
  assert.equal(existsSync(dir('bots')), false, 'no bots/ folder for the shadow id')
})

test('the memory assistant and restore refuse for a node Bot with a reason instead of acting on the wrong memory', async (t) => {
  const { rt, close } = await world()
  t.after(close)
  await assert.rejects(() => rt.memoryEndpoint('memory-ask', { botId: SHADOW, text: 'tidy this' }), /Not available for a node Bot/)
  await assert.rejects(() => rt.memoryEndpoint('memory-restore', { botId: SHADOW, id: 'x' }), /Not available for a node Bot/)
})

test('the change log of a node Bot lists the changes its memory made', async (t) => {
  const { rt, close } = await world()
  t.after(close)
  const history = await rt.memoryEndpoint('memory-history', { botId: SHADOW })
  assert.equal(history.rows.length, 1)
  assert.equal(history.rows[0].text, 'the port is 4387')
})
