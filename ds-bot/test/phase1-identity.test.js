// Phase 1: identityId as top-level field, Team Directory, joined rows no longer type:'remote-worker',
// lease/epoch module, remote-worker dispatch only for legacy (non-joined) rows.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { IDENTITY_ID_RE, LEASE_RENEWAL_MS, LEASE_DURATION_MS } from '../src/host/constants.js'
import { grantLease, renewLease, hasValidLease, migrateLease, revokeLease, leaseOf, noLease } from '../src/host/lease.js'
import {
  ensureDirectory, applyMachineHello, markMachineOffline, applyBotIdentity,
  removeBotFromDirectory, botByIdentityId, allMachines, shadowByIdentityId,
} from '../src/host/team-directory.js'
import { applyRosterReport, shadowId, reportableBots } from '../src/host/roster-join.js'

const IDENTITY_ID = 'ab12cd34ef56gh78'.slice(0, 16).replace(/[^0-9a-f]/g, '0').padEnd(16, '0')
// valid 16-hex id
const ID1 = '0123456789abcdef'
const ID2 = 'fedcba9876543210'

// ── constants ────────────────────────────────────────────────────────────────

test('IDENTITY_ID_RE matches 16 lowercase hex chars only', () => {
  assert.ok(IDENTITY_ID_RE.test('0123456789abcdef'))
  assert.ok(IDENTITY_ID_RE.test('fedcba9876543210'))
  assert.ok(!IDENTITY_ID_RE.test('0123456789abcde'))  // 15 chars
  assert.ok(!IDENTITY_ID_RE.test('0123456789ABCDEF'))  // uppercase
  assert.ok(!IDENTITY_ID_RE.test('0123456789abcdefg')) // 17 chars
})

test('LEASE_RENEWAL_MS < LEASE_DURATION_MS (station can renew before expiry)', () => {
  assert.ok(LEASE_RENEWAL_MS < LEASE_DURATION_MS)
})

// ── lease module ─────────────────────────────────────────────────────────────

test('grantLease creates a lease with epoch 1 and future leaseUntil', () => {
  const state = {}
  const now = Date.now()
  const lease = grantLease(state, ID1, 'machine-a', { now })
  assert.equal(lease.machineId, 'machine-a')
  assert.equal(lease.epoch, 1)
  assert.ok(lease.leaseUntil > now)
  assert.deepEqual(leaseOf(state, ID1), lease)
})

test('hasValidLease returns false for expired lease, true while valid', () => {
  const state = {}
  const past = Date.now() - 1000
  grantLease(state, ID1, 'machine-a', { now: past - LEASE_DURATION_MS })
  assert.ok(!hasValidLease(state, ID1, 'machine-a'))  // expired
  grantLease(state, ID1, 'machine-a', { now: Date.now() })
  assert.ok(hasValidLease(state, ID1, 'machine-a'))   // valid
})

test('hasValidLease returns false for wrong machineId', () => {
  const state = {}
  grantLease(state, ID1, 'machine-a')
  assert.ok(!hasValidLease(state, ID1, 'machine-b'))
})

test('renewLease extends leaseUntil for the same machine', () => {
  const state = {}
  const now = Date.now()
  grantLease(state, ID1, 'machine-a', { now })
  const renewed = renewLease(state, ID1, 'machine-a', { now: now + 10_000 })
  assert.ok(renewed.leaseUntil > now + 10_000)
})

test('renewLease returns undefined for wrong machine', () => {
  const state = {}
  grantLease(state, ID1, 'machine-a')
  assert.equal(renewLease(state, ID1, 'machine-b'), undefined)
})

test('migrateLease bumps epoch +1 and grants to new machine', () => {
  const state = {}
  grantLease(state, ID1, 'machine-a', { now: Date.now(), epoch: 3 })
  const newLease = migrateLease(state, ID1, 'machine-b')
  assert.equal(newLease.machineId, 'machine-b')
  assert.equal(newLease.epoch, 4)
})

test('revokeLease removes the lease', () => {
  const state = {}
  grantLease(state, ID1, 'machine-a')
  revokeLease(state, ID1)
  assert.equal(leaseOf(state, ID1), undefined)
})

test('noLease returns a zero lease', () => {
  const l = noLease()
  assert.equal(l.machineId, null)
  assert.equal(l.epoch, 0)
  assert.equal(l.leaseUntil, 0)
})

// ── team-directory ───────────────────────────────────────────────────────────

test('ensureDirectory initialises directory on bare state', () => {
  const state = {}
  const dir = ensureDirectory(state)
  assert.deepEqual(dir, { machines: {}, bots: {} })
  assert.equal(state.directory, dir)
})

test('applyMachineHello upserts a machine record', () => {
  const state = {}
  const changed = applyMachineHello(state, { nodeId: 'n1', hostname: 'mypc', os: 'darwin', caps: ['bot-locate/1'], acVersion: '0.4.33' })
  assert.ok(changed)
  const rec = state.directory.machines['n1']
  assert.equal(rec.name, 'mypc')
  assert.equal(rec.os, 'darwin')
  assert.ok(rec.caps.includes('bot-locate/1'))
})

test('applyMachineHello returns false when nothing changed', () => {
  const state = {}
  applyMachineHello(state, { nodeId: 'n1', hostname: 'mypc', os: 'darwin', caps: [], acVersion: '' })
  const now = state.directory.machines['n1'].lastSeen
  const changed = applyMachineHello(state, { nodeId: 'n1', hostname: 'mypc', os: 'darwin', caps: [], acVersion: '' }, { now })
  assert.ok(!changed)
})

test('markMachineOffline marks online=false', () => {
  const state = {}
  applyMachineHello(state, { nodeId: 'n1', hostname: 'mypc', os: 'linux', caps: [] })
  assert.ok(markMachineOffline(state, 'n1'))
  assert.equal(state.directory.machines['n1'].online, false)
})

test('applyBotIdentity stores Bot in directory and can be found by botByIdentityId', () => {
  const state = {}
  applyBotIdentity(state, { identityId: ID1, name: 'Ada', role: 'Dev', machineId: 'n1' })
  const bot = botByIdentityId(state, ID1)
  assert.equal(bot.name, 'Ada')
  assert.equal(bot.home.machineId, 'n1')
})

test('removeBotFromDirectory removes the entry', () => {
  const state = {}
  applyBotIdentity(state, { identityId: ID1, name: 'Ada', role: 'Dev', machineId: 'n1' })
  assert.ok(removeBotFromDirectory(state, ID1))
  assert.equal(botByIdentityId(state, ID1), undefined)
})

test('shadowByIdentityId finds bot by top-level or worker.identityId', () => {
  const state = {
    bots: {
      'joined:n1:ada': { id: 'joined:n1:ada', origin: 'joined', identityId: ID1, worker: { identityId: ID1 } },
      'joined:n2:bob': { id: 'joined:n2:bob', origin: 'joined', worker: { identityId: ID2 } },
    }
  }
  assert.equal(shadowByIdentityId(state, ID1)?.id, 'joined:n1:ada')
  assert.equal(shadowByIdentityId(state, ID2)?.id, 'joined:n2:bob')
  assert.equal(shadowByIdentityId(state, '0000000000000000'), undefined)
})

// ── roster-join Phase 1 ───────────────────────────────────────────────────────

test('applyRosterReport builds joined rows without type:remote-worker', () => {
  const state = { bots: {}, rooms: {} }
  applyRosterReport(state, { nodeId: 'n1', hostname: 'mypc', bots: [{ id: 'ada', name: 'Ada', identityId: ID1 }] })
  const id = shadowId('n1', 'ada')
  const row = state.bots[id]
  assert.ok(row, 'row exists')
  assert.equal(row.origin, 'joined')
  assert.equal(row.type, undefined, 'type:remote-worker should be absent on joined rows')
  assert.equal(row.identityId, ID1, 'identityId promoted to top-level')
  assert.equal(row.worker.identityId, ID1, 'identityId also in worker for backward compat')
})

test('applyRosterReport populates Team Directory when identityId is present', () => {
  const state = { bots: {}, rooms: {} }
  applyRosterReport(state, { nodeId: 'n1', hostname: 'mypc', bots: [{ id: 'ada', name: 'Ada', identityId: ID1 }] })
  const dirBot = botByIdentityId(state, ID1)
  assert.ok(dirBot, 'directory entry created')
  assert.equal(dirBot.home.machineId, 'n1')
})

test('reportableBots includes joined rows (no type:remote-worker)', () => {
  const state = { bots: {}, rooms: {} }
  applyRosterReport(state, { nodeId: 'n1', hostname: 'mypc', bots: [{ id: 'ada', name: 'Ada', identityId: ID1 }] })
  const reported = reportableBots(state.bots)
  assert.ok(reported.some(b => b.name === 'Ada'), 'Ada is reported')
})

test('reportableBots excludes legacy remote-worker rows (non-joined)', () => {
  const state = {
    bots: {
      'worker-1': { id: 'worker-1', name: 'Old Worker', type: 'remote-worker' },
    },
    rooms: {}
  }
  const reported = reportableBots(state.bots)
  assert.ok(!reported.some(b => b.name === 'Old Worker'), 'legacy remote-worker row excluded')
})

test('existing remote-worker row is migrated: type removed on next roster report', () => {
  const state = {
    bots: { [shadowId('n1', 'ada')]: { id: shadowId('n1', 'ada'), type: 'remote-worker', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'ada', home: 'remote' } } },
    rooms: {}
  }
  applyRosterReport(state, { nodeId: 'n1', hostname: 'mypc', bots: [{ id: 'ada', name: 'Ada' }] })
  const row = state.bots[shadowId('n1', 'ada')]
  assert.equal(row.type, undefined, 'type:remote-worker removed on update')
})
