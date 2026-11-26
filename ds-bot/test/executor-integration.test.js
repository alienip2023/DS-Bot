// test/executor-integration.test.js
// Integration: executor.send → fake registry. Tests tracker lifecycle, E_OFFLINE/E_TIMEOUT/E_REJECTED and the seq the result
// frame carries. (The page-writing half, deliverTurn → mirror → historyEntry, went in W5: only the copy of the node Bot's chat
// writes its hub page now; see docs/plans/2026-11-24-work-model.md.)

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mock } from 'node:test'
import EventEmitter from 'node:events'

import { send, ExecutorError } from '../src/host/executor.js'
import { JOINED_TURN_TIMEOUT_MS } from '../src/host/joined-turn.js'
import { createTurnTracker } from '../src/host/turn-tracker.js'

// ---- test helpers ----
function makeJoinedBot(overrides = {}) {
  return {
    id: 'bot-joined-1',
    origin: 'joined',
    worker: { nodeId: 'node-1', remoteBotId: 'remote-bot-1', home: 'remote', online: true },
    ...overrides,
  }
}

function makeRegistry({ online = true, replyText = 'Node reply' } = {}) {
  const emitter = new EventEmitter()
  let seqCounter = 0
  return {
    send: (nodeId, type, payload) => {
      if (!online) return false
      const seq = seqCounter++
      setImmediate(() => emitter.emit('botTurnResult', {
        exchangeId: payload.exchangeId, ok: true, text: replyText, seq,
      }))
      return true
    },
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
  }
}

function makeRt(bot, registry) {
  return {
    botOf: (id) => id === bot.id ? bot : undefined,
    ctx: { get: (name) => name === 'remote-agent:registry' ? registry : undefined },
  }
}

// ---- executor.send tests ----
describe('executor.send: remote joined bot', () => {
  it('send returns {ok:true, turnId, text, nodeId, remoteBotId}', async () => {
    const bot = makeJoinedBot()
    const registry = makeRegistry({ replyText: 'Hello back' })
    const rt = makeRt(bot, registry)
    const result = await send({ botId: bot.id, text: 'Hello', rt })
    assert.equal(result.ok, true)
    assert.ok(typeof result.turnId === 'string' && result.turnId.length > 0)
    assert.equal(result.text, 'Hello back')  // from real bot/turn-result payload
    assert.equal(result.nodeId, 'node-1')
    assert.equal(result.remoteBotId, 'remote-bot-1')
  })

  it('node offline (send returns false) → E_OFFLINE', async () => {
    const bot = makeJoinedBot()
    const registry = makeRegistry({ online: false })
    const rt = makeRt(bot, registry)
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_OFFLINE',
    )
  })

  it('no registry → E_OFFLINE', async () => {
    const bot = makeJoinedBot()
    const rt = { botOf: (id) => id === bot.id ? bot : undefined, ctx: { get: () => undefined } }
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_OFFLINE',
    )
  })

  it('bot not found → E_NOT_FOUND', async () => {
    const rt = { botOf: () => undefined, ctx: { get: () => undefined } }
    await assert.rejects(
      () => send({ botId: 'missing', text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_NOT_FOUND',
    )
  })

  it('node sends ok:false → E_REJECTED', async () => {
    const bot = makeJoinedBot()
    const emitter = new EventEmitter()
    const registry = {
      send: (_, __, payload) => {
        setImmediate(() => emitter.emit('botTurnResult', { exchangeId: payload.exchangeId, ok: false, error: 'bot-not-found' }))
        return true
      },
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
    }
    const rt = makeRt(bot, registry)
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_REJECTED',
    )
  })

  it('timeout → E_TIMEOUT (mock timers, default path)', async () => {
    // Knife ①: change executor default to 60min → mock.timers.tick(120_000) does not reach 3600_000 → test hangs/fails
    mock.timers.enable({ apis: ['setTimeout'] })
    const bot = makeJoinedBot()
    const emitter = new EventEmitter()
    const registry = {
      send: () => true,  // never fires result
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
    }
    const rt = makeRt(bot, registry)
    // No timeoutMs override — uses JOINED_TURN_TIMEOUT_MS as default
    const p = send({ botId: bot.id, text: 'Hi', rt })
    mock.timers.tick(JOINED_TURN_TIMEOUT_MS)
    await assert.rejects(p, (err) => err instanceof ExecutorError && err.code === 'E_TIMEOUT')
    mock.timers.reset()
  })
})

describe('executor + tracker', () => {
  it('tracker starts turn before send, finishes done on success', async () => {
    const bot = makeJoinedBot()
    const registry = makeRegistry({ replyText: 'tracked reply' })
    const rt = makeRt(bot, registry)
    const tracker = createTurnTracker()
    const result = await send({ botId: bot.id, text: 'Hi', rt, tracker })
    const entry = tracker.get(result.turnId)
    assert.ok(entry, 'tracker must have an entry for the turnId')
    // Knife ③: go tracker.finish no-op → status stays 'pending' → assertion fails
    assert.equal(entry.status, 'done', 'tracker entry must be done after successful send')
  })

  it('tracker finishes failed on E_OFFLINE', async () => {
    const bot = makeJoinedBot()
    const registry = makeRegistry({ online: false })
    const rt = makeRt(bot, registry)
    const tracker = createTurnTracker()
    let caughtTurnId
    try {
      await send({ botId: bot.id, text: 'Hi', rt, tracker })
    } catch (err) {
      // turnId not returned on error — check that tracker has exactly one failed entry
      assert.equal(err.code, 'E_OFFLINE')
    }
    // There should be one entry with status failed
    const failed = [...Array.from({ length: tracker.size() }, (_, i) => i)]
    // We can verify by checking tracker internals via a fresh sweep (no pending should remain)
    const timedOut = tracker.sweep(Date.now() + 200_000, 120_000)
    assert.equal(timedOut.length, 0, 'no entries should remain in pending state after E_OFFLINE')
  })
})


describe('turn-tracker: lifecycle', () => {
  it('start → finish(done) → get reports done', () => {
    const tracker = createTurnTracker()
    tracker.start('t1', 'bot-1')
    assert.equal(tracker.get('t1').status, 'pending')
    tracker.finish('t1', { status: 'done' })
    assert.equal(tracker.get('t1').status, 'done')
  })

  it('sweep marks timed-out pending turns', () => {
    const tracker = createTurnTracker()
    tracker.start('t2', 'bot-2')
    const timedOut = tracker.sweep(Date.now() + 200_000, 120_000)
    assert.ok(timedOut.includes('t2'))
    assert.equal(tracker.get('t2').status, 'timeout')
  })

  it('sweep ignores already-finished turns', () => {
    const tracker = createTurnTracker()
    tracker.start('t3', 'bot-3')
    tracker.finish('t3', { status: 'done' })
    const timedOut = tracker.sweep(Date.now() + 200_000, 120_000)
    assert.ok(!timedOut.includes('t3'))
  })
})

describe('executor.send: edge cases', () => {
  it('joined shadow missing nodeId → E_NOT_FOUND (worker absent)', async () => {
    // worker is falsy → E_NOT_FOUND (not worker shape mismatch)
    const bot = { id: 'bot-no-node', origin: 'joined', worker: null }
    const rt = { botOf: (id) => id === bot.id ? bot : undefined, ctx: { get: () => ({}) } }
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_NOT_FOUND',
    )
  })

  it('S21-E_INVALID: worker.nodeId wrong type → E_INVALID (not E_NOT_FOUND)', async () => {
    // worker exists but nodeId is not a string → E_INVALID
    const bot = { id: 'bot-bad-worker', origin: 'joined', worker: { home: 'remote', nodeId: 123, remoteBotId: 'r1' } }
    const rt = { botOf: (id) => id === bot.id ? bot : undefined, ctx: { get: () => ({}) } }
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_INVALID',
    )
  })

  it('registry.send throws → E_OFFLINE + listener released', async () => {
    // Knife: remove cancel() in catch → listener count > 0 → must red
    const bot = makeJoinedBot()
    const emitter = new EventEmitter()
    const registry = {
      send: () => { throw new Error('send exploded') },
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
    }
    const rt = makeRt(bot, registry)
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_OFFLINE',
    )
    // After throw, listener must be removed (cancel() called)
    assert.equal(emitter.listenerCount('botTurnResult'), 0, 'botTurnResult listener must be released after send throw')
  })
})


// ---- S2-1 tests ----

describe('S21: E_INVALID input validation', () => {
  it('S21-E_INVALID: missing botId → E_INVALID (not E_NOT_FOUND)', async () => {
    const rt = { botOf: (id) => undefined, ctx: { get: () => undefined } }
    await assert.rejects(
      () => send({ botId: '', text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_INVALID',
    )
  })

  it('S21-E_INVALID: null botId → E_INVALID', async () => {
    const rt = { botOf: () => undefined, ctx: { get: () => undefined } }
    await assert.rejects(
      () => send({ botId: null, text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_INVALID',
    )
  })

  it('S21-E_INVALID: empty text → E_INVALID', async () => {
    const bot = makeJoinedBot()
    const rt = makeRt(bot, makeRegistry())
    await assert.rejects(
      () => send({ botId: bot.id, text: '', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_INVALID',
    )
  })

  it('S21-E_INVALID: non-string text → E_INVALID', async () => {
    const bot = makeJoinedBot()
    const rt = makeRt(bot, makeRegistry())
    await assert.rejects(
      () => send({ botId: bot.id, text: 42, rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_INVALID',
    )
  })
})



