// Phase 3: work ledger — assignment state machine, away state, crash-restart rules.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createWorkLedger, ASSIGNMENT_KIND, ASSIGNMENT_STATE, isTerminal,
} from '../src/host/work-ledger.js'

let clock = 1000
const freshHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-ledger-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('createWorkLedger initialises with empty assignments', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    assert.equal(ledger.all().length, 0)
  } finally { cleanup() }
})

test('create adds an assignment in queued state', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.HANDOFF, from: 'bot-a', to: 'bot-b', payload: { text: 'hello' } })
    assert.equal(a.state, ASSIGNMENT_STATE.QUEUED)
    assert.equal(a.kind, 'handoff')
    assert.equal(a.attempts, 0)
    assert.ok(a.id)
    assert.equal(ledger.all().length, 1)
    assert.equal(ledger.byId(a.id), a)
  } finally { cleanup() }
})

test('transition queued → running increments attempts', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.REMOTE_TURN, from: 'bot-a', to: 'bot-b' })
    const running = ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    assert.equal(running.state, 'running')
    assert.equal(running.attempts, 1)
  } finally { cleanup() }
})

test('transition to a terminal state is final', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.ROUTINE, from: 'bot-a', to: 'bot-b' })
    const done = ledger.transition(a.id, ASSIGNMENT_STATE.DONE)
    assert.equal(done.state, 'done')
    assert.ok(isTerminal(done))
    // Transitions from terminal state are ignored.
    const again = ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    assert.equal(again.state, 'done')
  } finally { cleanup() }
})

test('markAway puts a running assignment into away state', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.REMOTE_TURN, from: 'bot-a', to: 'bot-b' })
    ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    const away = ledger.markAway(a.id)
    assert.equal(away.state, 'away')
    assert.equal(ledger.byId(a.id).state, 'away')
  } finally { cleanup() }
})

test('resume moves assignment back from away to queued', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.HANDOFF, from: 'bot-a', to: 'bot-b' })
    ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    ledger.markAway(a.id)
    const resumed = ledger.resume(a.id)
    assert.equal(resumed.state, 'queued')
  } finally { cleanup() }
})

test('resume is a no-op on a non-away assignment', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.HANDOFF, from: 'bot-a', to: 'bot-b' })
    const result = ledger.resume(a.id)
    assert.equal(result, undefined)
  } finally { cleanup() }
})

test('applyRestartRules with no external effects re-queues (one retry)', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.REMOTE_TURN, from: 'bot-a', to: 'bot-b' })
    ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    const restarted = ledger.applyRestartRules(a.id)
    assert.equal(restarted.state, 'queued')
  } finally { cleanup() }
})

test('applyRestartRules with external effects marks failed(interrupted)', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.REMOTE_TURN, from: 'bot-a', to: 'bot-b' })
    ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    ledger.recordEffect(a.id, 'sent-message')
    const result = ledger.applyRestartRules(a.id)
    assert.equal(result.state, 'failed')
    assert.equal(result.reason, 'interrupted-with-effects')
  } finally { cleanup() }
})

test('applyRestartRules does not re-run after first retry already happened', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.REMOTE_TURN, from: 'bot-a', to: 'bot-b' })
    ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    ledger.applyRestartRules(a.id) // first retry
    ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    const second = ledger.applyRestartRules(a.id)
    assert.equal(second.state, 'failed')
    assert.equal(second.reason, 'interrupted-no-retry')
  } finally { cleanup() }
})

test('ledger persists across instances: create, reload, state intact', () => {
  const { home, cleanup } = freshHome()
  try {
    let ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.HANDOFF, from: 'bot-a', to: 'bot-b' })
    ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    // Simulate a restart by creating a new ledger on the same home.
    ledger = createWorkLedger({ home, now: () => clock })
    const restored = ledger.byId(a.id)
    assert.ok(restored, 'assignment survives reload')
    assert.equal(restored.state, 'running')
    assert.equal(restored.from, 'bot-a')
  } finally { cleanup() }
})

test('prune removes terminal assignments older than maxAgeMs', () => {
  const { home, cleanup } = freshHome()
  try {
    let tc = 1000
    const ledger = createWorkLedger({ home, now: () => tc })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.ROUTINE, from: 'bot-a', to: 'bot-b' })
    ledger.transition(a.id, ASSIGNMENT_STATE.DONE)
    // a.updatedAt = 1000
    tc += 500
    // b.updatedAt = 1500
    const b = ledger.create({ kind: ASSIGNMENT_KIND.ROUTINE, from: 'bot-a', to: 'bot-b' })
    ledger.transition(b.id, ASSIGNMENT_STATE.DONE)
    tc += 100_000
    // now = 101500. prune with maxAgeMs=1000: cutoff = 101500 - 1000 = 100500
    // a.updatedAt=1000 < 100500 → pruned
    // b.updatedAt=1500 < 100500 → also pruned! need larger gap
    // Use maxAgeMs = 100100: cutoff = 101500 - 100100 = 1400
    // a (1000) < 1400 → pruned; b (1500) > 1400 → kept
    const pruned = ledger.prune(100100)
    assert.equal(pruned, 1)
    assert.equal(ledger.byId(a.id), undefined)
    assert.ok(ledger.byId(b.id), 'newer terminal assignment kept')
  } finally { cleanup() }
})

test('pending returns only non-terminal assignments', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.HANDOFF, from: 'bot-a', to: 'bot-b' })
    ledger.create({ kind: ASSIGNMENT_KIND.HANDOFF, from: 'bot-a', to: 'bot-c' })
    ledger.transition(a.id, ASSIGNMENT_STATE.DONE)
    assert.equal(ledger.pending().length, 1)
  } finally { cleanup() }
})

test('awayFor returns assignments targeting a machine that are away', () => {
  const { home, cleanup } = freshHome()
  try {
    const ledger = createWorkLedger({ home, now: () => clock })
    const a = ledger.create({ kind: ASSIGNMENT_KIND.HANDOFF, from: 'bot-a', to: 'bot-b' })
    ledger.transition(a.id, ASSIGNMENT_STATE.RUNNING)
    ledger.markAway(a.id)
    const found = ledger.awayFor('bot-b')
    assert.equal(found.length, 1)
    assert.equal(found[0].id, a.id)
    assert.equal(ledger.awayFor('bot-c').length, 0)
  } finally { cleanup() }
})
