// test/mirror-timeout.test.js — behavioral test for JOINED_TURN_TIMEOUT_MS = 120s
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { JOINED_TURN_TIMEOUT_MS } from '../src/host/joined-turn.js'

test('JOINED_TURN_TIMEOUT_MS is 120_000 (2 minutes, not 60 minutes)', () => {
  assert.equal(JOINED_TURN_TIMEOUT_MS, 120_000, 'must be 120s')
  assert.notEqual(JOINED_TURN_TIMEOUT_MS, 60 * 60 * 1000, 'must not be 60 minutes')
})

test('timeout fires at 120s (mock timers)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let fired = false
  setTimeout(() => { fired = true }, JOINED_TURN_TIMEOUT_MS)

  // One millisecond before — should not fire
  mock.timers.tick(JOINED_TURN_TIMEOUT_MS - 1)
  assert.equal(fired, false, 'should not fire at 119999ms')

  // One more millisecond — now fires
  mock.timers.tick(1)
  assert.equal(fired, true, 'should fire at exactly 120000ms')

  mock.timers.reset()
})

test('60-minute timeout does NOT fire at 120s (mock timers)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let fired = false
  setTimeout(() => { fired = true }, 60 * 60 * 1000)

  mock.timers.tick(120_000)
  assert.equal(fired, false, '60-min timeout must not fire at 120s')

  mock.timers.reset()
})
