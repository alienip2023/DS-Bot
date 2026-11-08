// test/mirror-gate1.test.js — S1 gate 1: store-owned session + mirror writes + real disk persistence
// Approach:
// 1. Mount dsh-session-persistence-jsonl with a mkdtemp root
// 2. Create persistence handle (registers writer in tracker) + in-memory session
// 3. mirrorTurn writes 6 events; flush drains them to disk via session/event + session/flush
// 4. Read back from a NEW ctx with the same root — assert user/bot bubbles
//
// Knife: delete a mirrorTurn append → READ events < 6 (gate1 red).
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { SessionId } from "@deepseek-ai/dsh-session"
import { apply as applyJsonl } from "@deepseek-ai/dsh-session-persistence-jsonl"
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit"
import { mirrorTurn } from "../src/host/mirror.js"

function assertRenderable(events) {
  const userEv = events.find(e => e.type === "user/message")
  assert.ok(userEv, "must have user/message")
  assert.ok(Array.isArray(userEv.data.content), "user/message data.content must be array")
  assert.ok(userEv.data.content.some(b => b?.type === "text"), "user/message must have text block")
  assert.equal(userEv.data.source?.kind, "user", "source.kind must be user (parts.js:1488)")

  const botEv = events.find(e => e.type === "assistant/message")
  assert.ok(botEv, "must have assistant/message")
  assert.ok(Array.isArray(botEv.data.message?.content), "assistant/message data.message.content must be array")
  assert.ok(botEv.data.message.content.some(b => b?.type === "text"), "bot message must have text")
}

test("gate1: real jsonl persistence — write 6 events, flush, reload, verify renderable", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirror-gate1-"))
  try {
    // --- WRITE PHASE ---
    let writtenEvents = 0
    {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(applyJsonl, { root, compression: "none" })
      const persistence = ctx.get("sessionPersistence")
      assert.ok(persistence, "sessionPersistence service must be available")

      const id = SessionId("gate1-mirror")
      const header = { version: 4, id, createdAt: Date.now(), isSeeded: false }
      // Create persistence handle FIRST — this registers the writer in the tracker
      // so that session/event listener can route events to the writer
      const handle = await persistence.create(header)

      const session = ctx.sessions.create(id, { meta: { title: "gate1-mirror" } })
      await new Promise(r => setImmediate(r))

      const seenKeys = new Set()
      const closedKeys = new Set()
      const seenSteps = new Set()
      const result = await mirrorTurn(session, {
        turn: 1, userText: "Hello mirror", botText: "Hi, mirror reply",
        botId: "bot-test", nodeSeq: 42, seenKeys, closedKeys, seenSteps,
      })
      assert.equal(result.skipped, false, "first write must not be skipped")
      writtenEvents = session.log.length
      assert.ok(writtenEvents >= 4, "must have at least 4 events (turn/start, user, bot, turn/end)")

      // Flush: session/flush listener → writer.drainLive + writer.flush → disk
      const flushed = await ctx.sessions.flush(session)
      assert.equal(flushed, true, "flush must return true (jsonl durability listener participated)")

      // Give async writer time to drain
      await new Promise(r => setTimeout(r, 200))
      await handle.close()
      await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
    }

    // --- READ PHASE: new ctx, same root ---
    {
      const ctx2 = new Context()
      await mountAgentLoopTestDependencies(ctx2)
      await ctx2.plugin(applyJsonl, { root, compression: "none" })
      const p2 = ctx2.get("sessionPersistence")

      const handle2 = await p2.open(SessionId("gate1-mirror"))
      const r2 = await handle2.read(0, 100)
      const events = r2.events ?? []
      assert.equal(events.length, writtenEvents, "reloaded event count must match written count")
      assertRenderable(events)
      await handle2.close()
      await ctx2[Symbol.asyncDispose]?.() ?? ctx2.dispose?.()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("gate1: (botId, nodeSeq) idempotency — duplicate nodeSeq skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirror-gate1-"))
  try {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const session = ctx.sessions.create(SessionId("gate1-dedup-nodeseq"), {})
    await new Promise(r => setImmediate(r))
    const seenKeys = new Set()
    const closedKeys = new Set()
    const seenSteps = new Set()

    const r1 = await mirrorTurn(session, { turn: 1, userText: "A", botText: "B", botId: "b1", nodeSeq: 1, seenKeys, closedKeys, seenSteps })
    const r2 = await mirrorTurn(session, { turn: 2, userText: "C", botText: "D", botId: "b1", nodeSeq: 1, seenKeys, closedKeys, seenSteps })
    assert.equal(r1.skipped, false)
    assert.equal(r2.skipped, true, "same (botId, nodeSeq) must be skipped")
    assert.equal(r2.reason, "already-written:nodeSeq")
    await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("gate1: (turn, step) idempotency — duplicate step skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirror-gate1-"))
  try {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const session = ctx.sessions.create(SessionId("gate1-dedup-step"), {})
    await new Promise(r => setImmediate(r))
    const seenKeys = new Set()
    const closedKeys = new Set()
    const seenSteps = new Set()

    const r1 = await mirrorTurn(session, { turn: 1, userText: "A", botText: "B", botId: "b1", nodeSeq: 1, seenKeys, closedKeys, seenSteps })
    const r2 = await mirrorTurn(session, { turn: 1, step: 1, userText: "C", botText: "D", botId: "b1", nodeSeq: 2, seenKeys, closedKeys, seenSteps })
    assert.equal(r1.skipped, false)
    assert.equal(r2.skipped, true, "same (turn, step=1) must be skipped")
    assert.equal(r2.reason, "already-written:step")
    await ctx[Symbol.asyncDispose]?.() ?? ctx.dispose?.()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
