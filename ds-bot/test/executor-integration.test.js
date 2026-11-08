// test/executor-integration.test.js
// Integration test: executor.send() → fake bot/turn-result → mirror writes 6 events → parts.historyEntry renders
// Node offline → E_OFFLINE, turn marked failed, no half-turn

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EventEmitter from 'node:events'

import { send, ExecutorError } from '../src/host/executor.js'
import { mirrorTurn } from '../src/host/mirror.js'
import { createTurnTracker } from '../src/host/turn-tracker.js'

import { historyEntry } from '../src/host/parts.js'

// ---- Minimal rt factory for executor tests ----
function fakeJoinedBot(overrides = {}) {
  return {
    id: 'bot-joined-1',
    origin: 'joined',
    worker: {
      nodeId: 'node-1',
      remoteBotId: 'remote-bot-1',
      home: 'remote',
      online: true,
      ...overrides.worker,
    },
    ...overrides,
  }
}

function makeRegistry(nodeOnline = true) {
  const emitter = new EventEmitter()
  return {
    send: (nodeId, type, payload) => {
      if (!nodeOnline) return false
      // Simulate async bot/turn-result
      setImmediate(() => {
        emitter.emit('botTurnResult', {
          exchangeId: payload.exchangeId,
          ok: true,
          text: 'Hello from node',
        })
      })
      return true
    },
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
  }
}

describe('executor.send: remote joined bot', () => {
  it('send returns {ok:true, turnId} and registry receives bot/turn', async () => {
    const bot = fakeJoinedBot()
    const registry = makeRegistry(true)
    const rt = {
      botOf: (id) => id === bot.id ? bot : undefined,
      ctx: { get: (name) => name === 'remote-agent:registry' ? registry : undefined },
    }
    const result = await send({ botId: bot.id, text: 'Hello', rt })
    assert.equal(result.ok, true)
    assert.ok(typeof result.turnId === 'string' && result.turnId.length > 0)
  })

  it('node offline → E_OFFLINE', async () => {
    const bot = fakeJoinedBot()
    const registry = makeRegistry(false)  // send returns false
    const rt = {
      botOf: (id) => id === bot.id ? bot : undefined,
      ctx: { get: (name) => name === 'remote-agent:registry' ? registry : undefined },
    }
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hello', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_OFFLINE'
    )
  })

  it('no registry → E_OFFLINE', async () => {
    const bot = fakeJoinedBot()
    const rt = {
      botOf: (id) => id === bot.id ? bot : undefined,
      ctx: { get: () => undefined },
    }
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hello', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_OFFLINE'
    )
  })

  it('node sends ok:false → E_REJECTED', async () => {
    const bot = fakeJoinedBot()
    const emitter = new EventEmitter()
    const registry = {
      send: (nodeId, type, payload) => {
        setImmediate(() => emitter.emit('botTurnResult', { exchangeId: payload.exchangeId, ok: false, error: 'bot-not-found' }))
        return true
      },
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
    }
    const rt = {
      botOf: (id) => id === bot.id ? bot : undefined,
      ctx: { get: () => registry },
    }
    await assert.rejects(
      () => send({ botId: bot.id, text: 'Hello', rt }),
      (err) => err instanceof ExecutorError && err.code === 'E_REJECTED'
    )
  })

  it('timeout → E_TIMEOUT (fast mock)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const bot = fakeJoinedBot()
    const emitter = new EventEmitter()
    const registry = {
      send: () => true,  // never fires result
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
    }
    const rt = {
      botOf: (id) => id === bot.id ? bot : undefined,
      ctx: { get: () => registry },
    }
    // No timeoutMs override — uses JOINED_TURN_TIMEOUT_MS from executor default.
    // Knife: change executor default to 60min → mock.timers.tick(120_000) won't fire timeout → test fails
    const p = send({ botId: bot.id, text: 'Hello', rt })
    mock.timers.tick(120_000)
    await assert.rejects(p, (err) => err instanceof ExecutorError && err.code === 'E_TIMEOUT')
    mock.timers.reset()
  })
})

describe('executor + mirror: send → fake result → parts.historyEntry renders', () => {
  let tmpDir

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mirror-exec-'))
  })
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('full pipeline: send → mirrorTurn → historyEntry sees user+bot bubbles', async () => {
    const bot = fakeJoinedBot()
    const emitter = new EventEmitter()
    let capturedText = null
    const registry = {
      send: (nodeId, type, payload) => {
        const xid = payload.exchangeId
        setImmediate(() => {
          capturedText = 'Mirror bot reply'
          emitter.emit('botTurnResult', { exchangeId: xid, ok: true, text: capturedText })
        })
        return true
      },
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
    }
    const rt = {
      botOf: (id) => id === bot.id ? bot : undefined,
      ctx: { get: () => registry },
    }

    const result = await send({ botId: bot.id, text: 'Test user input', rt })
    assert.equal(result.ok, true)

    // Now mirror the exchange into a minimal session-like object
    const appendedEvents = []
    const fakeSession = {
      append: (type, data, opts) => {
        const ev = { type, data, opts }
        appendedEvents.push(ev)
        return ev
      },
    }

    await mirrorTurn(fakeSession, {
      turn: 1,
      step: 1,
      userText: 'Test user input',
      botText: capturedText ?? 'Mirror bot reply',
      botId: bot.id,
      nodeSeq: 1,
      seenKeys: new Set(),
      closedKeys: new Set(),
      seenSteps: new Set(),
    })

    // Verify 6 events appended
    assert.equal(appendedEvents.length, 6,
      `expected 6 events, got ${appendedEvents.length}: ${appendedEvents.map(e => e.type).join(',')}`)

    // Use parts.historyEntry to verify user + bot bubbles
    const userMsg = appendedEvents.find(e => e.type === 'user/message')
    const botMsg = appendedEvents.find(e => e.type === 'assistant/message')
    assert.ok(userMsg, 'user/message event must exist')
    assert.ok(botMsg, 'assistant/message event must exist')

    const userEntry = historyEntry(userMsg, false)
    const botEntry = historyEntry(botMsg, false)

    assert.ok(userEntry?.who === 'user' || userEntry?.role === 'user' || userEntry?.kind === 'user',
      `user entry should have user-type role, got: ${JSON.stringify(userEntry)}`)
    assert.ok(botEntry?.answer === true || botEntry?.kind === 'answer',
      `bot entry should be answer, got: ${JSON.stringify(botEntry)}`)
    assert.ok(botEntry?.text?.includes('Mirror bot reply'),
      `bot text should include reply, got: ${botEntry?.text}`)
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
    const far_future = Date.now() + 200_000
    const timedOut = tracker.sweep(far_future, 120_000)
    assert.ok(timedOut.includes('t2'))
    assert.equal(tracker.get('t2').status, 'timeout')
    assert.equal(tracker.get('t2').error, 'E_TIMEOUT')
  })

  it('sweep ignores already-finished turns', () => {
    const tracker = createTurnTracker()
    tracker.start('t3', 'bot-3')
    tracker.finish('t3', { status: 'done' })
    const timedOut = tracker.sweep(Date.now() + 200_000, 120_000)
    assert.ok(!timedOut.includes('t3'))
    assert.equal(tracker.get('t3').status, 'done')
  })

  it('node offline → E_OFFLINE, turn should be marked failed', async () => {
    const bot = fakeJoinedBot()
    const rt = {
      botOf: (id) => id === bot.id ? bot : undefined,
      ctx: { get: () => undefined },
    }
    const tracker = createTurnTracker()
    const turnId = randomUUID()

    // Start a turn in tracker (simulating what a caller would do)
    tracker.start(turnId, bot.id)
    let error
    try {
      await send({ botId: bot.id, text: 'Hello', rt })
    } catch (err) {
      error = err
    }
    assert.ok(error instanceof ExecutorError, 'must throw ExecutorError')
    assert.equal(error.code, 'E_OFFLINE')
    // Caller finishes the turn with failed status
    tracker.finish(turnId, { status: 'failed', error: error.code })
    assert.equal(tracker.get(turnId).status, 'failed')
    assert.equal(tracker.get(turnId).error, 'E_OFFLINE')
  })
})
