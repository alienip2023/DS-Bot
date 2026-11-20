import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyLlmFailure, retryDecision, nextRequestAttempt } from '../src/host/failure-policy.js'
import { turnFailure } from '../src/host/turns.js'

test('429 带 quota 字样仍是 rate_limit', () => {
  const error = { status: 429, code: 'QUOTA', message: 'Insufficient quota for this rate window' }
  assert.deepEqual(classifyLlmFailure(error), { kind: 'rate_limit', retryable: true })
  assert.equal(turnFailure(error).code, 'RATE_LIMIT')
})

test('classifies HTTP and coded LLM failures without changing the error', () => {
  const cases = [
    [{ status: 429 }, 'rate_limit', true],
    [{ code: 'RATE_LIMIT' }, 'rate_limit', true],
    [{ status: 402 }, 'billing', false],
    [{ code: 'ACCOUNT_QUOTA' }, 'billing', false],
    [new Error('insufficient balance'), 'billing', false],
    [{ status: 401 }, 'auth', false],
    [{ status: 403 }, 'auth', false],
    [{ code: 'MISSING_CREDENTIAL' }, 'auth', false],
    [{ status: 503 }, 'server', true],
    [{ code: 'SERVER' }, 'server', true],
    [{ code: 'EMPTY_RESPONSE' }, 'server', true],
    [{ code: 'TIMEOUT' }, 'network', true],
    [{ code: 'TRANSPORT' }, 'network', true],
    [{ code: 'STREAM_CLOSED' }, 'network', true],
    [{ status: 400 }, 'unknown', false],
    [null, 'unknown', false],
  ]
  for (const [error, kind, retryable] of cases) {
    assert.deepEqual(classifyLlmFailure(error && Object.freeze(error)), { kind, retryable }, `${error?.code ?? error?.status ?? error}`)
  }
})

// ── retryDecision ──────────────────────────────────────────────────────────

test('retryDecision: rate_limit 直接 stop，不管有无 fallback', () => {
  const f = { kind: 'rate_limit', retryable: true }
  assert.equal(retryDecision(f, { fallback: ['p/m2'] }, 1).action, 'stop')
  assert.equal(retryDecision(f, {}, 1).action, 'stop')
  assert.equal(retryDecision(f, {}, 1).reason, 'rate_limit')
})

test('retryDecision: 有 fallback 时 fallback 优先于预算', () => {
  const f = { kind: 'server', retryable: true }
  const result = retryDecision(f, { fallback: ['p/m2', 'p/m3'], maxAttempts: 1 }, 1)
  assert.equal(result.action, 'fallback')
  assert.equal(result.fallbackRef, 'p/m2')
})

test('retryDecision: fallback 耗尽后用最后一个', () => {
  const f = { kind: 'server', retryable: true }
  const result = retryDecision(f, { fallback: ['p/m2'], fallbackIndex: 5 }, 6)
  assert.equal(result.action, 'fallback')
  assert.equal(result.fallbackRef, 'p/m2')
})

test('retryDecision: 无 fallback + retryable + 在预算内 → retry', () => {
  const f = { kind: 'network', retryable: true }
  const result = retryDecision(f, { maxAttempts: 3 }, 1)
  assert.equal(result.action, 'retry')
})

test('retryDecision: 无 fallback + retryable + 超预算 → stop', () => {
  const f = { kind: 'network', retryable: true }
  assert.equal(retryDecision(f, { maxAttempts: 3 }, 3).action, 'stop')
  assert.equal(retryDecision(f, { maxAttempts: 3 }, 4).action, 'stop')
})

test('retryDecision: 不可重试失败 → stop', () => {
  const f = { kind: 'auth', retryable: false }
  assert.equal(retryDecision(f, {}, 1).action, 'stop')
  assert.equal(retryDecision(f, { fallback: [] }, 1).action, 'stop')
})

test('retryDecision: null failure 不崩溃', () => {
  assert.equal(retryDecision(null, {}, 1).action, 'stop')
  assert.equal(retryDecision(undefined, {}, 1).action, 'stop')
})

// ── nextRequestAttempt ─────────────────────────────────────────────────────

test('nextRequestAttempt: 首次调用返回 1', () => {
  const store = new Map()
  assert.equal(nextRequestAttempt(store, 'sa'), 1)
})

test('nextRequestAttempt: 窗口内连续失败累加', () => {
  const store = new Map()
  assert.equal(nextRequestAttempt(store, 'sa'), 1)
  assert.equal(nextRequestAttempt(store, 'sa'), 2)
  assert.equal(nextRequestAttempt(store, 'sa'), 3)
})

test('nextRequestAttempt: success=true 清零', () => {
  const store = new Map()
  nextRequestAttempt(store, 'sa')
  nextRequestAttempt(store, 'sa')
  assert.equal(nextRequestAttempt(store, 'sa', { success: true }), 0)
  assert.equal(nextRequestAttempt(store, 'sa'), 1, '清零后重新从 1 开始')
})

test('nextRequestAttempt: 窗口过期后重置', () => {
  const store = new Map()
  store.set('sa', { count: 5, windowStart: Date.now() - 11 * 60 * 1000 })
  assert.equal(nextRequestAttempt(store, 'sa', { windowMs: 10 * 60 * 1000 }), 1, '窗口过期重置')
})

test('nextRequestAttempt: 不同 session 独立计数', () => {
  const store = new Map()
  nextRequestAttempt(store, 'sa')
  nextRequestAttempt(store, 'sa')
  assert.equal(nextRequestAttempt(store, 'sb'), 1, 'sb 独立从 1 开始')
  assert.equal(nextRequestAttempt(store, 'sa'), 3, 'sa 继续累加')
})

