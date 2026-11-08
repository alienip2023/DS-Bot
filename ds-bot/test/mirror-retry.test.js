// test/mirror-retry.test.js — behavioral test: accounting-after-write + retry recovery
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mirrorTurn } from '../src/host/mirror.js'

async function makeStoreSession(ctx, id) {
  const session = ctx.sessions.create(SessionId(id), { meta: { title: id } })
  await new Promise(r => setImmediate(r))
  return session
}

test('step-3 throw → turn/end still written (finally), retry succeeds', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const session = await makeStoreSession(ctx, 'retry-step3')
  const seenKeys = new Set()
  const seenSteps = new Set()

  // Patch session.append to throw on the 3rd call (assistant/message)
  let appendCount = 0
  const realAppend = session.append.bind(session)
  session.append = (type, ...args) => {
    appendCount++
    if (appendCount === 3) throw new Error('simulated assistant/message failure')
    return realAppend(type, ...args)
  }

  // First call throws on step 3 — turn/end should still be written (finally)
  await assert.rejects(
    () => mirrorTurn(session, { turn: 1, userText: 'hi', botText: 'bot', botId: 'b1', nodeSeq: 1, seenKeys, seenSteps }),
    /simulated assistant/,
    'should propagate the throw'
  )

  // turn/end must have been written despite the throw (finally block)
  const typesAfterThrow = Array.from(session.log).map(e => e.type)
  assert.ok(typesAfterThrow.includes('turn/end'), 'turn/end must be written even after step-3 throw')

  // Accounting is AFTER write — keys not recorded because step 3 threw before we got there
  assert.equal(seenKeys.size, 0, 'seenKeys must be empty (accounting not reached)')
  assert.equal(seenSteps.size, 0, 'seenSteps must be empty (accounting not reached)')

  // Restore real append
  session.append = realAppend

  // Retry with same params — should succeed now
  const result = await mirrorTurn(session, { turn: 1, userText: 'hi', botText: 'bot', botId: 'b1', nodeSeq: 1, seenKeys, seenSteps })
  assert.equal(result.skipped, false, 'retry should succeed')
  assert.equal(seenKeys.size, 1, 'seenKeys should record after success')
  assert.equal(seenSteps.size, 1, 'seenSteps should record after success')

  await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
})

test('successful write prevents retry (idempotency holds)', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const session = await makeStoreSession(ctx, 'retry-idem')
  const seenKeys = new Set()
  const seenSteps = new Set()

  const r1 = await mirrorTurn(session, { turn: 2, userText: 'a', botText: 'b', botId: 'bot', nodeSeq: 5, seenKeys, seenSteps })
  assert.equal(r1.skipped, false, 'first write succeeds')

  const r2 = await mirrorTurn(session, { turn: 2, userText: 'a', botText: 'b', botId: 'bot', nodeSeq: 5, seenKeys, seenSteps })
  assert.equal(r2.skipped, true, 'same (botId, nodeSeq) skipped after accounting')
})
