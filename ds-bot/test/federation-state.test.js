// Federation state: defaults on an old state file, the one-time backup, and what
// switching the level off does (and must not do). The real runtime and its state file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { emptyFederation, ensureFederationState, handlePeerRoster, migrateFederation } from '../src/host/federation.js'
import { makeBot, threadWorld } from './thread-t2-world.js'

const report = (bots = [{ id: 'b1', name: 'Bravo', role: 'Engineer' }]) => ({ hubId: 'hub-a', level: 'roster', hostname: 'mac-b', bots })

test('an old state without federation gets the defaults, once', () => {
  const state = { bots: {}, prefs: {}, works: { keep: 1 } }
  assert.equal(ensureFederationState(state), true)
  assert.equal(state.prefs.federation, 'off')
  assert.deepEqual(state.federation, emptyFederation())
  assert.deepEqual(state.works, { keep: 1 })
  assert.equal(ensureFederationState(state), false)
})

test('a peer row without a hub is dropped by the migration, a good one survives', () => {
  const state = {
    bots: {
      'peer:hub-a:b1': { id: 'peer:hub-a:b1', origin: 'peer', worker: { home: 'hub', hubId: 'hub-a', botId: 'b1' } },
      'peer:hub-a:b2': { id: 'peer:hub-a:b2', origin: 'peer', worker: { home: 'local' } },
      local: { id: 'local', name: 'Alpha' },
    },
  }
  assert.equal(migrateFederation(state), true)
  assert.deepEqual(Object.keys(state.bots), ['peer:hub-a:b1', 'local'])
})

test('a failed save leaves no half roster and keeps the reason', async () => {
  const w = threadWorld()
  await w.rt.load()
  await w.rt.setFederationLevel('roster')
  await handlePeerRoster(w.rt, report())
  const before = JSON.parse(JSON.stringify(w.rt.state.bots))
  const save = w.rt.save
  w.rt.save = async () => { throw new Error('disk full') }
  const ok = await handlePeerRoster(w.rt, report([{ id: 'b1', name: 'Changed', role: 'Engineer' }]))
  assert.equal(ok, false)
  assert.deepEqual(w.rt.state.bots, before)
  assert.equal(w.rt.federationView().lastError.code, 'save-failed')
  w.rt.save = save
  assert.equal(await handlePeerRoster(w.rt, report()), true)
  assert.equal(w.rt.federationView().lastError, null)
})

test('switching off deletes shadows, clears inbox/outbox, prunes seen and keeps works', async () => {
  const w = threadWorld()
  await w.rt.load()
  await w.rt.setFederationLevel('roster')
  await handlePeerRoster(w.rt, report())
  const now = Date.now()
  w.rt.state.federation.inbox = { a: 1 }
  w.rt.state.federation.outbox = { b: 2 }
  w.rt.state.federation.seen = { old: now - 25 * 60 * 60 * 1000, fresh: now }
  w.rt.state.works = { keep: 1 }
  assert.equal(Object.values(w.rt.state.bots).some(bot => bot.origin === 'peer'), true)
  await w.rt.setFederationLevel('off')
  assert.equal(Object.values(w.rt.state.bots).some(bot => bot.origin === 'peer'), false)
  assert.deepEqual(w.rt.state.federation.inbox, {})
  assert.deepEqual(w.rt.state.federation.outbox, {})
  assert.equal(Object.hasOwn(w.rt.state.federation.seen, 'old'), false)
  assert.equal(Object.hasOwn(w.rt.state.federation.seen, 'fresh'), true)
  assert.deepEqual(w.rt.state.works, { keep: 1 })
})

test('the state file is backed up once before the first share, never overwritten', async () => {
  const w = threadWorld()
  await w.rt.load()
  await makeBot(w, 'Alpha')
  await w.rt.save()
  const backup = `${w.rt.statePath}.federation.bak`
  assert.equal(existsSync(backup), false)
  await w.rt.setFederationLevel('roster')
  assert.equal(existsSync(backup), true)
  const first = readFileSync(backup, 'utf8')
  // The backup is the file as it was before the first share.
  assert.match(first, /"federation":"off"/)
  assert.equal(first.includes('"federation":"roster"'), false)
  // A second switch away and back must not replace the first backup.
  await w.rt.setFederationLevel('off')
  await w.rt.setFederationLevel('roster')
  assert.equal(readFileSync(backup, 'utf8'), first)
  assert.equal(existsSync(backup), true)
})

test('a frame at level off clears the shadows without asking the node again', async () => {
  const w = threadWorld()
  await w.rt.load()
  await w.rt.setFederationLevel('roster')
  await handlePeerRoster(w.rt, report())
  assert.equal(Object.values(w.rt.state.bots).some(bot => bot.origin === 'peer'), true)
  // Local off wins over a remote roster (effective = min).
  await w.rt.setFederationLevel('off')
  await handlePeerRoster(w.rt, report())
  assert.equal(Object.values(w.rt.state.bots).some(bot => bot.origin === 'peer'), false)
})
