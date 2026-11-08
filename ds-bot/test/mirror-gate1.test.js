// test/mirror-gate1.test.js — S1 gate 1: store-owned session + mirror writes + persistence
// Uses mountAgentLoopTestDependencies for real SessionStore (ctx.sessions)
// Persistence: register session/flush listener to prove flush dispatches to durability backend
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mirrorTurn } from '../src/host/mirror.js'

function logEvents(session) { return Array.from(session.log) }

function assertRenderable(events) {
  const turnStart = events.find(e => e.type === 'turn/start')
  assert.ok(turnStart, 'must have turn/start')
  assert.ok(typeof turnStart.data.turn === 'number', 'turn/start data.turn must be number (parts.js:1421)')

  const userEv = events.find(e => e.type === 'user/message')
  assert.ok(userEv, 'must have user/message')
  assert.ok(Array.isArray(userEv.data.content), 'user/message data.content must be array (parts.js:1480)')
  assert.ok(userEv.data.content.some(b => b?.type === 'text'), 'must have text block')
  assert.equal(userEv.data.source?.kind, 'user', 'source.kind must be user (parts.js:1488)')

  const botEv = events.find(e => e.type === 'assistant/message')
  assert.ok(botEv, 'must have assistant/message')
  assert.ok(Array.isArray(botEv.data.message?.content), 'assistant/message data.message.content must be array (parts.js:1427)')
  assert.ok(botEv.data.message.content.some(b => b?.type === 'text'), 'must have text in bot message')

  const turnEnd = events.find(e => e.type === 'turn/end')
  assert.ok(turnEnd, 'must have turn/end')
}

async function makeStoreSession(ctx, id) {
  const session = ctx.sessions.create(SessionId(id), { meta: { title: id } })
  await new Promise(r => setImmediate(r))
  return session
}

test('gate1: store-owned session + mirror 4 steps → events persist → renderable', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)

  // Register a session/flush durability listener to prove flush is store-owned
  let flushedSession = null
  ctx.on('session/flush', (session) => { flushedSession = session })

  const session = await makeStoreSession(ctx, 'gate1-persist')
  assert.ok(session, 'session must exist')
  assert.equal(typeof session.append, 'function', 'session.append must be available')
  // Prove store-owned: ctx.sessions.get returns the same live object
  assert.equal(ctx.sessions.get(session.id), session, 'session must be live in store')

  const seenKeys = new Set()
  const seenSteps = new Set()
  const result = await mirrorTurn(session, {
    turn: 1, userText: 'Hello from mirror', botText: 'Hi, mirror reply',
    botId: 'bot-test', nodeSeq: 42, seenKeys, seenSteps,
  })
  assert.equal(result.skipped, false, 'first write not skipped')

  const events = logEvents(session)
  assert.equal(events.filter(e => ['turn/start','user/message','assistant/message','turn/end'].includes(e.type)).length, 4,
    'must have exactly 4 mirror events')
  assertRenderable(events)

  // Flush — listener fires (proves store-owned session going through durability chain)
  const flushed = await ctx.sessions.flush(session)
  // flushed === true iff at least one durability listener participated
  assert.equal(flushed, true, 'flush must return true — at least one listener participated (store-owned)')
  assert.equal(flushedSession, session, 'flush listener received our session')

  // Session is still live in store after flush
  const stillLive = ctx.sessions.get(session.id)
  assert.ok(stillLive, 'session must still be in store after flush')
  const eventsAfter = logEvents(stillLive)
  assertRenderable(eventsAfter)
  assert.equal(eventsAfter.length, events.length, 'event count must be stable after flush')

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
  assert.equal(r2.skipped, true, 'same (turn, step=1) must be skipped')
  assert.equal(r2.reason, 'already-written:step')

  await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
})
