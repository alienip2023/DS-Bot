import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyLlmFailure } from '../src/host/failure-policy.js'
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
