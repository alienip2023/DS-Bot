// test/mirror-gate1.test.js — S1 gate 1: store-owned session via ctx.sessions.create + mirror writes
// Verifies: ctx.sessions.create (real SessionStore) → mirrorTurn 4 steps →
// events persist in store-owned session → event shapes match parts.js displayItems expectations.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mirrorTurn } from '../src/host/mirror.js'

/**
 * Verify event shapes that parts.js displayItems can render.
 * parts.js:1421: turn/start → data.turn number
 * parts.js:1427: assistant/message → data.message.content array with text block
 * parts.js:1480: user/message → data.content array + data.source.kind==='user'
 */
function assertRenderable(events) {
  const turnStart = events.find(e => e.type === 'turn/start')
  assert.ok(turnStart, 'must have turn/start')
  assert.ok(typeof turnStart.data.turn === 'number', 'turn/start data.turn must be number (parts.js:1421)')

  const userEv = events.find(e => e.type === 'user/message')
  assert.ok(userEv, 'must have user/message')
  assert.ok(Array.isArray(userEv.data.content), 'user/message data.content must be array (parts.js:1480)')
  assert.ok(userEv.data.content.some(b => b?.type === 'text' && typeof b.text === 'string'), 'must have text block')
  assert.equal(userEv.data.source?.kind, 'user', 'source.kind must be user (parts.js:1488)')

  const botEv = events.find(e => e.type === 'assistant/message')
  assert.ok(botEv, 'must have assistant/message')
  assert.ok(Array.isArray(botEv.data.message?.content), 'assistant/message data.message.content must be array (parts.js:1427)')
  assert.ok(botEv.data.message.content.some(b => b?.type === 'text' && typeof b.text === 'string'), 'must have text block in bot message')

  const turnEnd = events.find(e => e.type === 'turn/end')
  assert.ok(turnEnd, 'must have turn/end')
  assert.ok(typeof turnEnd.data.turn === 'number', 'turn/end data.turn must be number')
}

// session.log is an array of event objects (the full log, all event types)
function logEvents(session) {
  return Array.from(session.log)
}

async function makeStoreSession(ctx, id) {
  // ctx.sessions.create: prepare + effect(enter + announce) atomically
  const session = ctx.sessions.create(SessionId(id), { meta: { title: id } })
  // Wait for the ctx.effect (enter + announce) to complete before appending
  await new Promise(r => setImmediate(r))
  return session
}

test('gate1: store-owned session + mirror 4 steps → events persist → renderable', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)

  // 1. Create a store-owned session via ctx.sessions.create (real SessionStore)
  const session = await makeStoreSession(ctx, 'gate1-persist')
  assert.ok(session, 'session must exist')
  assert.equal(typeof session.append, 'function', 'session.append must be available')
  assert.equal(ctx.sessions.get(session.id), session, 'session must be live in store (store-owned)')

  // 2. Mirror 4 steps
  const seenKeys = new Set()
  const seenSteps = new Set()
  const result = await mirrorTurn(session, {
    turn: 1,
    userText: 'Hello from mirror',
    botText: 'Hi, mirror reply',
    botId: 'bot-test',
    nodeSeq: 42,
    seenKeys,
    seenSteps,
  })
  assert.equal(result.skipped, false, 'first write not skipped')

  // 3. Verify 4 events in session log
  const events = logEvents(session)
  const types = events.map(e => e.type)
  assert.ok(types.includes('turn/start'), `must have turn/start; got: ${types}`)
  assert.ok(types.includes('user/message'), 'must have user/message')
  assert.ok(types.includes('assistant/message'), 'must have assistant/message')
  assert.ok(types.includes('turn/end'), 'must have turn/end')

  // 4. Verify event shapes match parts.js displayItems expectations
  assertRenderable(events)

  // 5. Persistence: session still retrievable after flush
  await ctx.sessions.flush(session)
  const reloaded = ctx.sessions.get(session.id)
  assert.ok(reloaded, 'session must still be in store after flush')
  const eventsAfter = logEvents(reloaded)
  assert.equal(eventsAfter.length, events.length, 'event count must match after flush+reload')
  assertRenderable(eventsAfter)

  await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
})

test('gate1: (botId, nodeSeq) idempotency — duplicate skipped', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const session = await makeStoreSession(ctx, 'gate1-dedup-nodeseq')

  const seenKeys = new Set()
  const seenSteps = new Set()

  const r1 = await mirrorTurn(session, { turn: 1, userText: 'A', botText: 'B', botId: 'b1', nodeSeq: 1, seenKeys, seenSteps })
  const r2 = await mirrorTurn(session, { turn: 2, userText: 'C', botText: 'D', botId: 'b1', nodeSeq: 1, seenKeys, seenSteps })

  assert.equal(r1.skipped, false)
  assert.equal(r2.skipped, true, 'same (botId, nodeSeq) must be skipped')
  assert.equal(r2.reason, 'already-written:nodeSeq')

  await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
})

test('gate1: (turn, step) idempotency — duplicate step skipped', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const session = await makeStoreSession(ctx, 'gate1-dedup-step')

  const seenKeys = new Set()
  const seenSteps = new Set()

  const r1 = await mirrorTurn(session, { turn: 1, userText: 'A', botText: 'B', botId: 'b1', nodeSeq: 1, seenKeys, seenSteps })
  const r2 = await mirrorTurn(session, { turn: 1, userText: 'C', botText: 'D', botId: 'b1', nodeSeq: 2, seenKeys, seenSteps })

  assert.equal(r1.skipped, false)
  assert.equal(r2.skipped, true, 'same (turn, step) must be skipped')
  assert.equal(r2.reason, 'already-written:step')

  await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
})
