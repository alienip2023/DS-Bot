import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { install as installRoster, shadowId } from '../src/host/roster-join.js'
import { install as installFederation, emptyFederation } from '../src/host/federation.js'

function world(registry) {
  const disposers = []
  const state = { bots: {}, prefs: { federation: 'roster' }, federation: emptyFederation() }
  let publishes = 0
  let saves = 0
  const rt = {
    state,
    ctx: {
      get: key => key === 'remote-agent:registry' ? registry : key === 'remote-agent:roster-report' ? () => { publishes++ } : undefined,
      provide() {},
      effect: fn => { const off = fn(); if (typeof off === 'function') disposers.push(off) },
    },
    warn() {},
    async save() { saves++ },
    peerRosterDelayMs: 5,
  }
  return { rt, dispose: () => { for (const off of disposers.splice(0)) off() }, publishes: () => publishes, saves: () => saves }
}

test('unloading the roster bridge removes its registry listeners and publisher timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const registry = new EventEmitter()
  const w = world(registry)
  installRoster(w.rt)
  assert.equal(registry.listenerCount('roster'), 1)
  w.dispose()
  const published = w.publishes()
  registry.emit('roster', { nodeId: 'n1', bots: [{ id: 'r1', name: 'Remote' }] })
  t.mock.timers.tick(5000)
  assert.equal(registry.listenerCount('roster'), 0)
  assert.equal(registry.listenerCount('nodeOffline'), 0)
  assert.equal(w.publishes(), published)
  assert.equal(w.saves(), 0)
})

test('a reloaded roster bridge receives reports on the same registry', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const registry = new EventEmitter()
  const first = world(registry)
  installRoster(first.rt)
  first.dispose()
  const second = world(registry)
  installRoster(second.rt)
  t.after(second.dispose)
  registry.emit('roster', { nodeId: 'n1', bots: [{ id: 'r1', name: 'Remote' }] })
  const id = shadowId('n1', 'r1')
  assert.equal(second.rt.state.bots[id]?.name, 'Remote')
  assert.equal(first.rt.state.bots[id], undefined)
  assert.equal(registry.listenerCount('roster'), 1)
})

test('unloading federation cancels its pending roster push and lets a new runtime subscribe', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = new EventEmitter()
  let sent = 0
  registry.getNode = () => ({ hello: { caps: ['peer/v1'] } })
  registry.send = () => { sent++; return true }
  const first = world(registry)
  installFederation(first.rt)
  registry.emit('roster', { nodeId: 'n1' })
  first.dispose()
  t.mock.timers.tick(5)
  assert.equal(sent, 0)
  assert.equal(registry.listenerCount('roster'), 0)
  const second = world(registry)
  installFederation(second.rt)
  t.after(second.dispose)
  registry.emit('roster', { nodeId: 'n1' })
  t.mock.timers.tick(5)
  assert.equal(sent, 1)
  assert.equal(first.rt.state.federation.seq, 0)
  assert.equal(second.rt.state.federation.seq, 1)
})
