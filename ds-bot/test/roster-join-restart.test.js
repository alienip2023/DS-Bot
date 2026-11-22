// After the hub restarts, shadow rows loaded from disk still say `online: true`. Until their node
// reports again that is a memory, not a fact: the page must not offer to send work to it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, shadowId } from '../src/host/roster-join.js'

const shadow = (nodeId) => { const id = shadowId(nodeId, 'r'); return { id, origin: 'joined', worker: { home: 'remote', nodeId, remoteBotId: 'r', online: true, lastSeen: 1 } } }

function runtime(bots, { reported } = {}) {
  const handlers = {}
  const registry = { on: (name, fn) => { handlers[name] = fn }, off() {} }
  const effects = []
  let saves = 0
  const rt = {
    state: { bots },
    ctx: {
      get: (name) => (name === 'remote-agent:registry' ? registry : name === 'remote-agent:roster-report' ? () => {} : undefined),
      effect: (fn) => effects.push(fn),
    },
    load: async () => {}, loadSecrets: async () => {}, save: async () => { saves += 1 },
    botOf: id => bots[id], warn() {},
  }
  return { rt, handlers, effects, saves: () => saves, reported }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

test('a shadow whose node has not reported since the restart is offline, one that has reported stays online', async () => {
  const a = shadow('n1'); const b = shadow('n2')
  const bots = { [a.id]: a, [b.id]: b }
  const w = runtime(bots)
  install(w.rt)
  // n2 reported before the first sweep ran.
  w.handlers.roster({ nodeId: 'n2', bots: [{ id: 'r', name: 'B'}] })
  await tick()
  assert.equal(a.worker.online, false, 'n1 is silent: offline')
  assert.notEqual(bots[b.id].worker.online, false, 'n2 reported: still online')
  assert.ok(w.saves() >= 1)
  for (const stop of w.effects) stop()
})

test('a node that reports after the sweep comes back online', async () => {
  const a = shadow('n1')
  const bots = { [a.id]: a }
  const w = runtime(bots)
  install(w.rt)
  await tick()
  assert.equal(a.worker.online, false)
  w.handlers.roster({ nodeId: 'n1', bots: [{ id: 'r', name: 'A' }] })
  assert.notEqual(bots[a.id].worker.online, false)
  for (const stop of w.effects) stop()
})
