import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as rosterJoin from '../src/host/roster-join.js'
// Pre-load mirror.js so dynamic import('./mirror.js') inside migrateLegacyJoined resolves from cache (microtask)
import '../src/host/mirror.js'

describe('S23: auto-migration on first roster event', () => {
  it('S23-migrate-on-roster: migrateLegacyJoined triggered once on first roster, not again on second', async () => {
    // Knife: delete `if (!_migrated)` guard → second roster calls joinedChatPage again → RED
    const bot = {
      id: 'bot-j1', origin: 'joined',
      worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' },
      sessionId: null, mirrorWatermark: 0,
    }
    const emitter = new EventEmitter()
    const registry = {
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
      __rosterJoin: false,
    }

    let joinedChatPageCalls = 0
    const sessions = new Map()
    const rt = {
      ctx: {
        get: (key) => key === 'remote-agent:registry' ? registry : undefined,
        on: () => {}, off: () => {},
      },
      state: { bots: { 'bot-j1': bot } },
      warn: () => {},
      save: async () => {},
      botOf: (id) => rt.state.bots[id],
      updateBySessionId: () => {},
      // joinedChatPage spy: each migrateLegacyJoined call fetches at least 1 page
      joinedChatPage: async () => { joinedChatPageCalls++; return { items: [], cursor: null } },
      createSession: async (title) => {
        const sid = 'auto-sid-1'
        bot.sessionId = sid
        sessions.set(sid, { sessionId: sid, log: [], append: () => {} })
        return sid
      },
      resolveAgent: async (sid) => ({ session: sessions.get(sid) ?? { sessionId: sid, log: [], append: () => {} } }),
    }

    rosterJoin.install(rt)

    // First roster event → triggers migrateLegacyJoined → joinedChatPage called
    emitter.emit('roster', { nodes: {} })
    await new Promise(r => setTimeout(r, 50))

    const callsAfterFirst = joinedChatPageCalls
    assert.ok(callsAfterFirst >= 1, `migrateLegacyJoined must fetch pages on first roster (calls=${callsAfterFirst})`)

    // Second roster event → must NOT trigger migrateLegacyJoined again
    emitter.emit('roster', { nodes: {} })
    await new Promise(r => setTimeout(r, 50))

    assert.equal(joinedChatPageCalls, callsAfterFirst,
      `second roster must NOT re-trigger migration (before=${callsAfterFirst}, after=${joinedChatPageCalls})`)
  })

  it('S23-migrate-deferred: migration deferred via setTimeout(0) — not direct call', async () => {
    // Knife: change setTimeout(...,0) back to direct call → setTimeout spy not called → RED
    const bot = {
      id: 'bot-j2', origin: 'joined',
      worker: { nodeId: 'n2', remoteBotId: 'rb2', home: 'remote' },
      sessionId: null, mirrorWatermark: 0,
    }
    const emitter = new EventEmitter()
    const registry = {
      on: (ev, fn) => emitter.on(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
      __rosterJoin: false,
    }

    let joinedChatPageCalls = 0
    const sessions = new Map()
    const rt = {
      ctx: {
        get: (key) => key === 'remote-agent:registry' ? registry : undefined,
        on: () => {}, off: () => {},
      },
      state: { bots: { 'bot-j2': bot } },
      warn: () => {},
      save: async () => {},
      botOf: (id) => rt.state.bots[id],
      updateBySessionId: () => {},
      joinedChatPage: async () => { joinedChatPageCalls++; return { items: [], cursor: null } },
      createSession: async () => {
        const sid = 'def-sid-1'
        bot.sessionId = sid
        sessions.set(sid, { sessionId: sid, log: [], append: () => {} })
        return sid
      },
      resolveAgent: async (sid) => ({ session: sessions.get(sid) ?? { sessionId: sid, log: [], append: () => {} } }),
    }

    // Spy on setTimeout to verify deferral mechanism
    const origSetTimeout = global.setTimeout
    let setTimeoutCalls = 0
    global.setTimeout = function(fn, delay, ...args) {
      setTimeoutCalls++
      return origSetTimeout(fn, delay, ...args)
    }

    try {
      rosterJoin.install(rt)

      // Emit roster — synchronously, setTimeout should be called for deferral
      emitter.emit('roster', { nodes: {} })
      assert.ok(setTimeoutCalls >= 1, 'migrate must be deferred via setTimeout (not direct call)')

      // Wait for deferred migrate to complete
      await new Promise(r => setTimeout(r, 200))
      assert.ok(joinedChatPageCalls >= 1, `migrateLegacyJoined must run after setTimeout deferral (calls=${joinedChatPageCalls})`)
    } finally {
      global.setTimeout = origSetTimeout
    }
  })
})
