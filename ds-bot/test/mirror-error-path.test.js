// test/mirror-error-path.test.js — mirror.js error path semantics
// Error writes {kind:'error'}; success writes {kind:'completed'}; after error,
// (botId,nodeSeq) marked closed → retry returns {skipped:true, reason:'already-closed'}
import assert from "node:assert/strict"
import { test } from "node:test"
import { Context } from "@deepseek-ai/cordis"
import { SessionId } from "@deepseek-ai/dsh-session"
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit"
import { mirrorTurn } from "../src/host/mirror.js"

test("error path: assistant append throws → turn/end has {kind:'error'}", async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const session = ctx.sessions.create(SessionId("err-path-1"), {})
  await new Promise(r => setImmediate(r))

  // Make assistant/message append throw by replacing append with a failing one after 3 calls
  let callCount = 0
  const origAppend = session.append.bind(session)
  session.append = (type, data, opts) => {
    callCount++
    if (callCount === 4) throw new Error("boom on assistant/message")
    return origAppend(type, data, opts)
  }

  const seenKeys = new Set()
  const closedKeys = new Set()
  const seenSteps = new Set()

  await assert.rejects(
    mirrorTurn(session, {
      turn: 1, userText: "hi", botText: "bye",
      botId: "b1", nodeSeq: 1, seenKeys, closedKeys, seenSteps,
    }),
    /boom on assistant\/message/
  )

  // Log types: turn/start, step/start, user/message, (assistant throws), step/end, turn/end
  const types = Array.from(session.log).map(e => e.type)
  assert.ok(types.includes("turn/start"), "must have turn/start")
  assert.ok(types.includes("user/message"), "must have user/message")
  assert.ok(!types.includes("assistant/message"), "must NOT have assistant/message (it threw)")
  assert.ok(types.includes("turn/end"), "must have turn/end (error path writes it)")

  // turn/end reason must be {kind:'error'}
  const turnEnd = Array.from(session.log).find(e => e.type === "turn/end")
  assert.equal(turnEnd?.data?.reason?.kind, "error", "turn/end reason.kind must be 'error'")
  assert.ok(turnEnd?.data?.reason?.error?.message, "turn/end must have error.message")

  // (botId, nodeSeq) must be marked closed
  assert.ok(closedKeys.has("b1:1"), "closedKeys must contain b1:1 after error")

  await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
})

// NOTE: This test simulates a retry by pre-populating closedKeys (as if a previous error run closed
// the nodeSeq). In production, if closedKeys is NOT passed by the caller, the already-closed guard
// won't fire and a retry would proceed. Always pass closedKeys to mirrorTurn to enable idempotency.
test("error path: retry after error returns {skipped:true, reason:'already-closed'}", async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const session = ctx.sessions.create(SessionId("err-path-2"), {})
  await new Promise(r => setImmediate(r))

  const seenKeys = new Set()
  const closedKeys = new Set()
  const seenSteps = new Set()

  // Pre-mark as closed (simulating a previous error)
  closedKeys.add("b1:1")

  const result = await mirrorTurn(session, {
    turn: 1, userText: "hi", botText: "bye",
    botId: "b1", nodeSeq: 1, seenKeys, closedKeys, seenSteps,
  })

  assert.equal(result.skipped, true, "retry must be skipped")
  assert.equal(result.reason, "already-closed", "reason must be 'already-closed'")

  // Log must be empty — nothing was written
  assert.equal(session.log.length, 0, "no events written on already-closed skip")

  await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
})

test("success path: turn/end has {kind:'completed'}", async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const session = ctx.sessions.create(SessionId("success-path-1"), {})
  await new Promise(r => setImmediate(r))

  const seenKeys = new Set()
  const closedKeys = new Set()
  const seenSteps = new Set()

  const result = await mirrorTurn(session, {
    turn: 1, userText: "hello", botText: "world",
    botId: "b1", nodeSeq: 1, seenKeys, closedKeys, seenSteps,
  })
  assert.equal(result.skipped, false)

  const turnEnd = Array.from(session.log).find(e => e.type === "turn/end")
  assert.equal(turnEnd?.data?.reason?.kind, "completed", "success turn/end must be {kind:'completed'}")

  await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
})
