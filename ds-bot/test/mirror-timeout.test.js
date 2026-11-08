// test/mirror-timeout.test.js
// Verify that listenBotTurnResult uses JOINED_TURN_TIMEOUT_MS as default
// and that the timeout fires after exactly that many milliseconds.
// Knife: change JOINED_TURN_TIMEOUT_MS back to 60*60*1000 → test goes red.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import { mock } from 'node:test'
import { listenBotTurnResult, JOINED_TURN_TIMEOUT_MS } from '../src/host/joined-turn.js'

describe('listenBotTurnResult: timeout behavior', () => {
  after(() => mock.timers.reset())

  it('JOINED_TURN_TIMEOUT_MS is 120_000 (2 minutes)', () => {
    assert.equal(JOINED_TURN_TIMEOUT_MS, 120_000)
  })

  it('does not settle at 119999ms', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const handlers = {}
    const fakeRegistry = {
      on: (event, fn) => { handlers[event] = fn },
      off: (event, fn) => { if (handlers[event] === fn) delete handlers[event] },
    }
    const { pending } = listenBotTurnResult(fakeRegistry, 'ex-1', 'node-1', JOINED_TURN_TIMEOUT_MS)
    let settled = false
    pending.then(() => { settled = true })

    mock.timers.tick(119_999)
    // Allow microtask queue to drain
    await Promise.resolve()
    assert.equal(settled, false, 'should not have settled at 119999ms')
    mock.timers.reset()
  })

  it('settles with undefined at exactly 120000ms (timeout)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const handlers = {}
    const fakeRegistry = {
      on: (event, fn) => { handlers[event] = fn },
      off: (event, fn) => { if (handlers[event] === fn) delete handlers[event] },
    }
    const { pending } = listenBotTurnResult(fakeRegistry, 'ex-2', 'node-1', JOINED_TURN_TIMEOUT_MS)

    mock.timers.tick(120_000)
    const result = await pending
    assert.equal(result, undefined, 'timeout should resolve with undefined')
    mock.timers.reset()
  })
})
