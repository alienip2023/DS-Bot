// P3 pmo.js 测试
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planDispatch, applyDispatch, planTaskNudges, planIdleRetry, planIdleStaffing } from '../src/host/pmo.js'

const room = (tasks = {}) => ({ id: 'r1', members: ['admin', 'worker', 'qa'], admin: 'admin', tasks })
const task = (overrides = {}) => ({ id: 't1', botId: 'worker', goal: 'Fix bug', status: 'active', updatedAt: Date.now(), ...overrides })

// ── planDispatch ───────────────────────────────────────────────────────────

test('planDispatch: 责任人不在回合时返回 dispatch 计划', () => {
  const r = room({ t1: task() })
  const plans = planDispatch(r, { isInTurn: () => false })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].kind, 'dispatch')
  assert.equal(plans[0].botId, 'worker')
})

test('planDispatch: 责任人在回合时不补派', () => {
  const r = room({ t1: task() })
  const plans = planDispatch(r, { isInTurn: id => id === 'worker' })
  assert.equal(plans.length, 0)
})

test('planDispatch: 超出补派次数限制时不再补派', () => {
  const r = room({ t1: task({ _dispatches: 3, _lastDispatchAt: Date.now() - 120_000 }) })
  const plans = planDispatch(r, { isInTurn: () => false })
  assert.equal(plans.length, 0)
})

test('planDispatch: 距上次补派不足 60s 时不补派', () => {
  const r = room({ t1: task({ _dispatches: 1, _lastDispatchAt: Date.now() - 10_000 }) })
  const plans = planDispatch(r, { isInTurn: () => false })
  assert.equal(plans.length, 0)
})

test('planDispatch: 终态任务不补派', () => {
  const r = room({ t1: task({ status: 'done' }) })
  const plans = planDispatch(r, { isInTurn: () => false })
  assert.equal(plans.length, 0)
})

test('applyDispatch: 递增计数和时间戳', () => {
  const t = task()
  const before = Date.now()
  applyDispatch(t)
  assert.equal(t._dispatches, 1)
  assert.ok(t._lastDispatchAt >= before)
})

// ── planTaskNudges ─────────────────────────────────────────────────────────

test('planTaskNudges: 无空闲返回 null', () => {
  assert.equal(planTaskNudges(task(), { threadIdleMs: 0, stateIdleMs: 0 }), null)
})

test('planTaskNudges: threadIdle >= 5min → heartbeat', () => {
  assert.equal(planTaskNudges(task(), { threadIdleMs: 5 * 60_000, stateIdleMs: 0 }), 'heartbeat')
})

test('planTaskNudges: stateIdle >= 15min → escalate', () => {
  assert.equal(planTaskNudges(task(), { threadIdleMs: 0, stateIdleMs: 15 * 60_000 }), 'escalate')
})

test('planTaskNudges: stateIdle >= 30min → stall（优先于 escalate）', () => {
  assert.equal(planTaskNudges(task(), { threadIdleMs: 20 * 60_000, stateIdleMs: 30 * 60_000 }), 'stall')
})

test('planTaskNudges: 终态任务返回 null', () => {
  assert.equal(planTaskNudges(task({ status: 'done' }), { threadIdleMs: 60 * 60_000, stateIdleMs: 60 * 60_000 }), null)
})

// ── planIdleRetry ──────────────────────────────────────────────────────────

test('planIdleRetry: 看板空 + pmoChecked=false → 立即重试（首次）', () => {
  const result = planIdleRetry(room(), { pmoChecked: false, retryCount: 0 })
  assert.equal(result.shouldRetry, true)
  assert.equal(result.delayMs, 0)
})

test('planIdleRetry: 看板空 + pmoChecked=true + retryCount=0 → 0ms', () => {
  const result = planIdleRetry(room(), { pmoChecked: true, retryCount: 0 })
  assert.equal(result.shouldRetry, true)
  assert.equal(result.delayMs, 0)
})

test('planIdleRetry: 指数退避 retryCount=1 → 10min', () => {
  const result = planIdleRetry(room(), { pmoChecked: true, retryCount: 1 })
  assert.equal(result.delayMs, 10 * 60_000)
})

test('planIdleRetry: 指数退避 retryCount=4 → 80min（封顶前）', () => {
  const result = planIdleRetry(room(), { pmoChecked: true, retryCount: 4 })
  assert.equal(result.delayMs, 10 * 60_000 * Math.pow(2, 3))
})

test('planIdleRetry: 看板有活时不重试', () => {
  const r = room({ t1: task() })
  assert.equal(planIdleRetry(r, { pmoChecked: true }).shouldRetry, false)
})

// ── planIdleStaffing ───────────────────────────────────────────────────────

test('planIdleStaffing: 有活跃无人认领任务时派给空闲成员', () => {
  const r = room({ t1: task() })
  const { plans } = planIdleStaffing(r, { isInTurn: () => false })
  assert.ok(plans.length >= 1)
  assert.equal(plans[0].kind, 'assign')
  assert.equal(plans[0].taskId, 't1')
})

test('planIdleStaffing: 所有成员在回合时不派活', () => {
  const r = room({ t1: task() })
  const result = planIdleStaffing(r, { isInTurn: () => true })
  assert.equal(result.plans.length, 0)
})

test('planIdleStaffing: 看板空时不派活', () => {
  const result = planIdleStaffing(room(), { isInTurn: () => false })
  assert.equal(result.plans.length, 0)
})

test('planIdleStaffing: 同一签名未超 TTL 时返回 skip=true', () => {
  const r = room({ t1: task() })
  const { sign } = planIdleStaffing(r, { isInTurn: () => false, lastSign: '', lastSignAt: 0 })
  const result = planIdleStaffing(r, { isInTurn: () => false, lastSign: sign, lastSignAt: Date.now() })
  assert.equal(result.skip, true)
})

test('planIdleStaffing: 同一签名超 TTL 时重新派', () => {
  const r = room({ t1: task() })
  const { sign } = planIdleStaffing(r, { isInTurn: () => false })
  const result = planIdleStaffing(r, { isInTurn: () => false, lastSign: sign, lastSignAt: Date.now() - 3 * 60 * 60_000 })
  assert.ok(!result.skip)
  assert.ok(result.plans.length >= 1)
})
