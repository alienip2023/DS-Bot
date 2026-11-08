// test/store-assembly.test.js — verify all rt fields are wired after install(rt) + load()
// Knife: delete any field from Object.assign(rt, ...) → corresponding assertion goes red.
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { install } from "../src/host/store.js"

test("rt assembly: all 10 restored fields are present after install + load", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "store-assembly-"))
  try {
    const state = {
      version: 1,
      mainBotIds: [],
      bots: {
        "bot-joined-1": {
          id: "bot-joined-1",
          name: "TestJoined",
          role: "",
          origin: "joined",
          sessionId: "session-1",
          segments: [{ sessionId: "session-2", title: "old part" }],
          worker: {
            nodeId: "node-1",
            remoteBotId: "session-r1",
            hostname: "node-1",
            home: "remote",
            online: false,
          },
          createdAt: Date.now(),
        },
      },
      rooms: {},
      agents: {},
      capabilities: { items: {} },
      exchanges: [],
      exchangeTurns: {},
      works: {},
      requests: {},
      questions: {},
      views: {},
      closedCards: {},
      prefs: {},
      switching: {},
      revision: 0,
      privateArchives: [],
    }
    writeFileSync(join(tmpHome, "state.json"), JSON.stringify(state))

    const ctx = {
      effect: () => {},
      on: () => {},
      emit: () => {},
      emitAsync: async () => {},
    }
    const rt = {
      ctx,
      home: tmpHome,
      statePath: join(tmpHome, "state.json"),
      warn: () => {},
    }
    rt.retitleRoom = async () => {}
    rt.ctx.sessionTitle = { rename: async () => {} }

    install(rt)
    await rt.load()

    // Assert all 10 restored fields exist
    assert.ok(rt.chatOwners instanceof Map, "chatOwners must be a Map")
    assert.equal(typeof rt.groupOwners, "object", "groupOwners must be an object")
    assert.ok(rt.roomOwners instanceof Map, "roomOwners must be a Map")
    assert.ok(rt.pastOwners instanceof Map, "pastOwners must be a Map")
    assert.equal(typeof rt.groupSessionsOf, "function", "groupSessionsOf must be a function")
    assert.equal(typeof rt.dropGroupSession, "function", "dropGroupSession must be a function")
    assert.equal(typeof rt.retireGroupSession, "function", "retireGroupSession must be a function")
    assert.equal(typeof rt.findBot, "function", "findBot must be a function")
    assert.equal(typeof rt.findRooms, "function", "findRooms must be a function")
    assert.equal(typeof rt.isAdminOf, "function", "isAdminOf must be a function")

    // Also verify bySessionId is still wired
    assert.equal(typeof rt.bySessionId, "function", "bySessionId must be a function")
    assert.equal(typeof rt.botOf, "function", "botOf must be a function")
    assert.equal(typeof rt.chatOf, "function", "chatOf must be a function")

    // Verify bySessionId works for the joined bot's sessionId
    const bot = rt.bySessionId("session-1")
    assert.ok(bot, "bySessionId(session-1) should return the joined bot")
    assert.equal(bot.id, "bot-joined-1", "bot id must match")
  } finally {
    rmSync(tmpHome, { recursive: true, force: true })
  }
})
