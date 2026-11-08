// test/mirror-gate1.test.js — S1 gate 1: store-owned session + mirror writes + real disk persistence
// Approach:
// 1. Mount dsh-session-persistence-jsonl with a mkdtemp root
// 2. Create persistence handle (registers writer in tracker) + in-memory session
// 3. mirrorTurn writes 6 events; flush drains them to disk via session/event + session/flush
// 4. Read back from a NEW ctx with the same root — assert parts.js historyEntry maps user+bot bubbles
//
// Knife: change user/message data to {turn, message: um} (wrong shape) → user historyEntry goes red.
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
import { historyEntry } from "../src/host/parts.js"

test("gate1: real jsonl persistence — write 6 events, flush, reload, historyEntry maps user+bot bubbles", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirror-gate1-"))
  try {
    const BOT_TEXT = "Hi, mirror reply"
    const USER_TEXT = "Hello mirror"
    let writtenEvents = 0

    // --- WRITE PHASE ---
    {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(applyJsonl, { root, compression: "none" })
      const persistence = ctx.get("sessionPersistence")
      assert.ok(persistence, "sessionPersistence service must be available")

      const id = SessionId("gate1-mirror")
      const header = { version: 4, id, createdAt: Date.now(), isSeeded: false }
      // Create persistence handle FIRST — registers writer so session/event routes to disk
      const handle = await persistence.create(header)

      const session = ctx.sessions.create(id, { meta: { title: "gate1-mirror" } })
      await new Promise(r => setImmediate(r))

      const seenKeys = new Set()
      const closedKeys = new Set()
      const seenSteps = new Set()
      const result = await mirrorTurn(session, {
        turn: 1, userText: USER_TEXT, botText: BOT_TEXT,
        botId: "bot-test", nodeSeq: 42, seenKeys, closedKeys, seenSteps,
      })
      assert.equal(result.skipped, false, "first write must not be skipped")
      writtenEvents = session.log.length
      assert.ok(writtenEvents >= 4, "must have at least 4 events")

      const flushed = await ctx.sessions.flush(session)
      assert.equal(flushed, true, "flush must return true (jsonl durability listener participated)")

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

      // Use real parts.js historyEntry to map reloaded events — this is what the UI does
      const entries = events.map(ev => historyEntry(ev, false)).filter(Boolean)
      const userEntry = entries.find(e => e.who === "user")
      const botEntry = entries.find(e => e.answer === true)

      assert.ok(userEntry, "must have a user historyEntry (who: 'user')")
      assert.ok(userEntry.text?.includes(USER_TEXT), `user text must include '${USER_TEXT}'`)
      assert.ok(botEntry, "must have a bot historyEntry (answer: true)")
      assert.equal(botEntry.text, BOT_TEXT, `bot text must be '${BOT_TEXT}'`)

      await handle2.close()
      await ctx2[Symbol.asyncDispose]?.() ?? ctx2.dispose?.()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("gate1: (botId, nodeSeq) idempotency — duplicate nodeSeq skipped", async () => {
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
})

test("gate1: (turn, step) idempotency — duplicate step skipped", async () => {
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
})
