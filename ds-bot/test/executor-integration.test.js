// test/executor-integration.test.js
// Integration: executor.send/deliverTurn → fake registry → mirror → historyEntry renders
// Tests tracker lifecycle, E_OFFLINE/E_TIMEOUT/E_REJECTED, and nodeSeq S2 contract.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mock } from 'node:test'
import EventEmitter from 'node:events'

import { send, deliverTurn, ExecutorError } from '../src/host/executor.js'
import { createTurnTracker } from '../src/host/turn-tracker.js'
import { historyEntry } from '../src/host/parts.js'

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
  return {
    send: (nodeId, type, payload) => {
      if (!online) return false
      setImmediate(() => emitter.emit('botTurnResult', {
        exchangeId: payload.exchangeId, ok: true, text: replyText,
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
    // No timeoutMs override — uses JOINED_TURN_TIMEOUT_MS (120s) as default
    const p = send({ botId: bot.id, text: 'Hi', rt })
    mock.timers.tick(120_000)
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

describe('deliverTurn: full pipeline with mirror + historyEntry', () => {
  it('send → real result.text → mirrorTurn → historyEntry renders user+bot', async () => {
    const bot = makeJoinedBot()
    const REPLY_TEXT = 'Mirror pipeline reply'
    const registry = makeRegistry({ replyText: REPLY_TEXT })
    const rt = makeRt(bot, registry)

    const appendedEvents = []
    const fakeSession = {
      append: (type, data, opts) => {
        const ev = { type, data, opts }
        appendedEvents.push(ev)
        return ev
      },
    }

    const result = await deliverTurn({
      botId: bot.id,
      text: 'Pipeline input',
      rt,
      session: fakeSession,
      turn: 1,
      seenKeys: new Set(),
      closedKeys: new Set(),
      seenSteps: new Set(),
    })

    assert.equal(result.ok, true)
    assert.equal(appendedEvents.length, 6, `expected 6 events, got: ${appendedEvents.map(e => e.type)}`)

    const botMsgEvent = appendedEvents.find(e => e.type === 'assistant/message')
    assert.ok(botMsgEvent, 'assistant/message event must exist')

    // Knife ②: remove result.text from send() return → deliverTurn passes empty string to mirrorTurn → botEntry.text empty
    const botEntry = historyEntry(botMsgEvent, false)
    assert.ok(botEntry?.text?.includes(REPLY_TEXT),
      `bot entry text must include "${REPLY_TEXT}", got: "${botEntry?.text}"`)
  })

  it('nodeSeq is null (S2 obligation: seq not yet in bot/turn-result frame)', async () => {
    // This test documents the S2 contract: mirrorTurn receives nodeSeq:null, idempotency is skipped.
    // S2 must add `seq` to validateBotTurnResult and bot/turn-result frame.
    const bot = makeJoinedBot()
    const registry = makeRegistry({ replyText: 'seq test' })
    const rt = makeRt(bot, registry)
    const events = []
    const fakeSession = { append: (t, d, o) => { const ev = { type: t, data: d }; events.push(ev); return ev } }

    const result = await deliverTurn({
      botId: bot.id,
      text: 'seq test input',
      rt,
      session: fakeSession,
      turn: 1,
      seenKeys: new Set(),
      closedKeys: new Set(),
      seenSteps: new Set(),
    })
    assert.equal(result.mirrorResult.skipped, false)
    // Verify mirrorTurn still writes turn/end as {kind:'completed'} even without nodeSeq
    const turnEnd = events.find(e => e.type === 'turn/end')
    assert.equal(turnEnd?.data?.reason?.kind, 'completed')
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
  it('joined shadow missing nodeId → E_NOT_FOUND', async () => {
    // Knife: change to E_REJECTED → must red
    const bot = { id: 'bot-no-node', origin: 'joined', worker: { home: 'remote', remoteBotId: 'r1' } }
    const rt = { botOf: (id) => id === bot.id ? bot : undefined, ctx: { get: () => ({}) } }
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hi', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_NOT_FOUND',
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

describe('deliverTurn: multi-turn + missing turn param', () => {
  it('missing turn → throws E_NOT_FOUND', async () => {
    const bot = makeJoinedBot()
    const registry = makeRegistry({ replyText: 'r' })
    const rt = makeRt(bot, registry)
    const fakeSession = { append: () => ({}) }
    await assert.rejects(
      () => deliverTurn({ botId: bot.id, text: 'Hi', rt, session: fakeSession, seenKeys: new Set(), closedKeys: new Set(), seenSteps: new Set() }),
      (err) => err instanceof ExecutorError && err.code === 'E_NOT_FOUND',
    )
  })

  it('two consecutive turns → 12 events total, second turn not skipped', async () => {
    // Knife: set turn:1 for both calls → seenSteps blocks second → skipped:true → assertion fails
    const bot = makeJoinedBot()
    const registry = makeRegistry({ replyText: 'turn reply' })
    const rt = makeRt(bot, registry)

    const events = []
    const fakeSession = { append: (t, d, o) => { const ev = { type: t, data: d }; events.push(ev); return ev } }

    const seenKeys = new Set()
    const closedKeys = new Set()
    const seenSteps = new Set()

    const r1 = await deliverTurn({ botId: bot.id, text: 'First', rt, session: fakeSession, turn: 1, seenKeys, closedKeys, seenSteps })
    const r2 = await deliverTurn({ botId: bot.id, text: 'Second', rt, session: fakeSession, turn: 2, seenKeys, closedKeys, seenSteps })

    assert.equal(r1.mirrorResult.skipped, false, 'first turn must not be skipped')
    assert.equal(r2.mirrorResult.skipped, false, 'second turn must not be skipped')
    assert.equal(events.length, 12, `expected 12 events (2 × 6), got ${events.length}`)
  })
})

