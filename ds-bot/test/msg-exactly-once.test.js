import assert from 'node:assert/strict'
import { test } from 'node:test'
import { seen } from '../src/host/exchange-dedup.js'

test('first call is false, second is true', () => {
  assert.equal(seen('ex-pair-1'), false)
  assert.equal(seen('ex-pair-1'), true)
})

test('a replayed exchangeId renders once', () => {
  let count = 0
  for (const frame of ['ex-replay-1', 'ex-replay-1', 'ex-replay-1']) if (!seen(frame)) count++
  assert.equal(count, 1)
})

test('a fresh exchangeId is not lost', () => {
  assert.equal(seen('ex-fresh-1'), false)
})
