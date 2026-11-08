import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as channel from '../src/host/channel.js'
import * as joinedTurn from '../src/host/joined-turn.js'

/**
 * Build a minimal rt that both channel.install and joinedTurn.install can use.
 * Wires: registry (in-memory, emits botTurnResult), session/agent, botOf/bySessionId.
 */
function makeInstallRt(bot) {
  const sent = []
  const createSessionCalls = []
  const handleJoinedTurnCalls = []
  const appendedEvents = []
  const sessions = new Map()
  const bySessionIdMap = new Map([[bot.id, bot]])
  const botOfMap = new Map([[bot.id, bot]])
  const emitter = new EventEmitter()

  const registry = {
    nodes: new Map([[bot.worker.nodeId, { online: true }]]),
    send: (nodeId, type, payload) => {
      sent.push({ nodeId, type, payload })
      if (type === 'bot/turn') {
        setImmediate(() => emitter.emit('botTurnResult', {
          exchangeId: payload.exchangeId,
          ok: true,
          text: 'pong',
          seq: 1,
        }))
      }
      return true
    },
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
  }

  const effectCleanups = []
  const rt = {
    ctx: {
      provide: () => {},
      get: (key) => key === 'remote-agent:registry' ? registry : undefined,
      sessionController: {
        prompt: async () => { throw new Error('sessionController.prompt must NOT be called for joined bots') },
      },
      effect: (fn) => { const r = fn(); effectCleanups.push(typeof r === 'function' ? r : null) },
      connection: { fetch: { register: () => () => {} } },
      on: () => {},
      off: () => {},
    },
    state: { revision: 1, bots: {} },
    _parts: {},
    load: async () => {},
    refresh: async () => {},
    writes: () => false,
    botOf: (id) => botOfMap.get(id),
    bySessionId: (sid) => bySessionIdMap.get(sid),
    updateBySessionId: (botId, oldSid, newSid) => {
      if (oldSid) bySessionIdMap.delete(oldSid)
      if (newSid) bySessionIdMap.set(newSid, botOfMap.get(botId))
    },
    chatOf: (id) => botOfMap.get(id)?.sessionId ?? id,
    createSession: async (title) => {
      createSessionCalls.push(title)
      const sid = 'created-session-0'
      const session = { sessionId: sid, events: appendedEvents, append: (t, d) => appendedEvents.push({ t, d }) }
      sessions.set(sid, session)
      bot.sessionId = sid
      return sid
    },
    resolveAgent: async (sessionId) => {
      let s = sessions.get(sessionId)
      if (!s) { s = { sessionId, events: appendedEvents, append: (t, d) => appendedEvents.push({ t, d }) }; sessions.set(sessionId, s) }
      return { session: s }
    },
    chatPage: async (sid) => ({ sessionId: sid, items: [], cursor: null }),
    joinedChatPage: async () => { throw new Error('joinedChatPage must NOT be called') },
    save: async () => {},
    pastOwners: new Map(),
    roomOf: () => undefined,
    sessionOfRoom: () => undefined,
    ensureCapabilities: async () => {},
    warn: () => {},
    load: async () => {},
    _handleJoinedTurnSpy: handleJoinedTurnCalls,
  }

  return { rt, sent, createSessionCalls, handleJoinedTurnCalls, appendedEvents }
}

describe('S22-install: module install order — channel then joinedTurn', () => {
  it('S22-install-order: channel.install then joinedTurn.install → sendUser goes through mirror session, NOT handleJoinedTurn', async () => {
    // Knife: add wrapSendUser(rt) back to joinedTurn.install → rt.sendUser overwrapped →
    //        createSessionCalls.length === 0 and handleJoinedTurnCalls.length > 0 → test fails
    const bot = {
      id: 'bot-j1',
      origin: 'joined',
      worker: { nodeId: 'node-1', remoteBotId: 'rb-1', home: 'remote', online: true, lastSeen: null },
      sessionId: null,
    }
    const { rt, sent, createSessionCalls, handleJoinedTurnCalls } = makeInstallRt(bot)

    // Install both modules in the real order from index.js
    channel.install(rt)
    joinedTurn.install(rt)

    // Spy on rt.handleJoinedTurn (set by joinedTurn.install)
    const realHandleJoinedTurn = rt.handleJoinedTurn
    rt.handleJoinedTurn = (...args) => {
      handleJoinedTurnCalls.push(args)
      return realHandleJoinedTurn(...args)
    }

    // Fire sendUser as the user would
    await rt.sendUser({ sessionId: bot.id, content: [{ type: 'text', text: 'ping' }], requestId: 'req-1' })

    assert.equal(createSessionCalls.length, 1, 'createSession must be called exactly once (mirror session created)')
    assert.equal(sent.filter(f => f.type === 'bot/turn').length, 1, 'bot/turn must reach the registry')
    assert.equal(handleJoinedTurnCalls.length, 0, 'handleJoinedTurn must NOT be invoked (old wrapSendUser path)')
  })
})
