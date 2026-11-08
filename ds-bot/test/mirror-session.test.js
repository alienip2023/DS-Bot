import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ensureMirrorSession } from '../src/host/mirror.js'
import { joinedShadow } from '../src/host/roster-join.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeJoinedBot(overrides = {}) {
  return {
    id: 'bot-joined-s22',
    origin: 'joined',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true, lastSeen: null },
    sessionId: null,
    ...overrides,
  }
}

function makeRt(bot, overrides = {}) {
  const created = []
  const saves = []
  const botOfMap = new Map([[bot.id, bot]])
  const bySessionIdMap = new Map()
  const sessions = new Map()

  const rt = {
    ctx: { get: () => undefined },
    state: { revision: 1 },
    botOf: (id) => botOfMap.get(id),
    bySessionId: (sid) => bySessionIdMap.get(sid),
    updateBySessionId: (botId, oldSid, newSid) => {
      if (oldSid) bySessionIdMap.delete(oldSid)
      if (newSid) bySessionIdMap.set(newSid, botOfMap.get(botId))
    },
    chatOf: (botId) => botOfMap.get(botId)?.sessionId ?? botId,
    createSession: async (title) => {
      const sid = 'mirror-sid-' + created.length
      created.push(sid)
      sessions.set(sid, { sessionId: sid, append: () => {} })
      return sid
    },
    resolveAgent: async (sessionId) => {
      let session = sessions.get(sessionId)
      if (!session) { session = { sessionId, append: () => {} }; sessions.set(sessionId, session) }
      return { session }
    },
    save: async () => { saves.push(Date.now()) },
    warn: () => {},
    ...overrides,
  }
  return { rt, created, saves, botOfMap, bySessionIdMap, sessions }
}

// ── S22: ensureMirrorSession ─────────────────────────────────────────────────

describe('S22: ensureMirrorSession', () => {
  it('S22-ensure-create: bot.sessionId set + saved after create', async () => {
    // Knife: delete `bot.sessionId = sessionId` → bot.sessionId stays null → fails
    const bot = makeJoinedBot()
    const { rt, created, saves } = makeRt(bot)
    const session = await ensureMirrorSession(rt, bot)
    assert.ok(session !== null && typeof session === 'object', 'returns non-null session')
    assert.equal(created.length, 1, 'creates exactly one session')
    assert.ok(typeof bot.sessionId === 'string' && bot.sessionId !== '', 'bot.sessionId must be set')
    assert.equal(bot.sessionId, created[0], 'bot.sessionId matches created session id')
    assert.equal(saves.length, 1, 'save called exactly once')
  })

  it('S22-ensure-reuse: early return when bot.sessionId already set', async () => {
    // Knife: delete early-return check → always creates session → created.length=1 → fails
    const bot = makeJoinedBot({ sessionId: 'existing-sid' })
    const { rt, created, saves } = makeRt(bot)
    const session = await ensureMirrorSession(rt, bot)
    assert.ok(session !== null && typeof session === 'object', 'returns non-null session')
    assert.equal(created.length, 0, 'must NOT create a new session when sessionId exists')
    assert.equal(saves.length, 0, 'must NOT call save when sessionId exists')
    assert.equal(bot.sessionId, 'existing-sid', 'sessionId must remain unchanged')
  })

  it('S22-ensure-index: bySessionId updated so mirror sid resolves to bot', async () => {
    // Knife: delete rt.updateBySessionId call → bySessionId map not updated → found===undefined → fails
    const bot = makeJoinedBot()
    const { rt } = makeRt(bot)
    await ensureMirrorSession(rt, bot)
    const found = rt.bySessionId(bot.sessionId)
    assert.ok(found !== undefined, 'bySessionId must find bot by mirror session id')
    assert.equal(found.id, bot.id, 'found bot id must match original bot id')
    // Also: joinedShadow(bot) === true confirms channel.js will route to deliverTurn
    assert.equal(joinedShadow(bot), true, 'joinedShadow must be true for this bot')
  })

  it('S22-ensure-no-session: createSession throws → code no-session, bot.sessionId not set', async () => {
    // Knife: catch error silently instead of rethrowing → no rejection → test fails
    const bot = makeJoinedBot()
    const { rt } = makeRt(bot, { createSession: async () => { throw new Error('disk full') } })
    await assert.rejects(
      () => ensureMirrorSession(rt, bot),
      (err) => {
        assert.equal(err.code, 'no-session', 'error code must be no-session')
        return true
      }
    )
    assert.equal(bot.sessionId, null, 'bot.sessionId must remain null on failure')
  })
})

// ── channel-level tests via createSendUser ───────────────────────────────────

import { createSendUser, createChatPageRoute } from '../src/host/channel.js'
import { EventEmitter } from 'node:events'

function makeJoinedBotFull(overrides = {}) {
  return {
    id: 'bot-j1',
    origin: 'joined',
    worker: { nodeId: 'node-1', remoteBotId: 'rb-1', home: 'remote', online: true, lastSeen: null },
    sessionId: null,
    ...overrides,
  }
}

function makeChannelRt(bot, registryOptions = {}) {
  const { replyText = 'pong', replySeq = 5, sendFails = false } = registryOptions
  const sent = []        // bot/turn frames sent to registry
  const appendedEvents = []
  const sessions = new Map()
  const created = []
  const saves = []
  const bySessionIdMap = new Map()
  const botOfMap = new Map([[bot.id, bot]])
  const prompts = []     // sessionController.prompt calls
  const emitter = new EventEmitter()

  // Fake registry: captures sent frames, emits botTurnResult
  const registry = {
    nodes: new Map([['node-1', { online: true }]]),
    send: (nodeId, type, payload) => {
      if (sendFails) return false
      sent.push({ nodeId, type, payload })
      if (type === 'bot/turn') {
        setImmediate(() => emitter.emit('botTurnResult', {
          exchangeId: payload.exchangeId,
          ok: true,
          text: replyText,
          seq: replySeq,
        }))
      }
      return true
    },
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
  }

  const rt = {
    ctx: {
      get: (key) => key === 'remote-agent:registry' ? registry : undefined,
      sessionController: { prompt: async (args) => { prompts.push(args) } },
    },
    state: { revision: 1 },
    botOf: (id) => botOfMap.get(id),
    bySessionId: (sid) => bySessionIdMap.get(sid),
    updateBySessionId: (botId, oldSid, newSid) => {
      if (oldSid) bySessionIdMap.delete(oldSid)
      if (newSid) bySessionIdMap.set(newSid, botOfMap.get(botId))
    },
    chatOf: (botId) => botOfMap.get(botId)?.sessionId ?? botId,
    createSession: async (title) => {
      const sid = 'msid-' + created.length
      created.push(sid)
      const session = { sessionId: sid, events: appendedEvents, append: (t, d) => appendedEvents.push({ t, d }) }
      sessions.set(sid, session)
      return sid
    },
    resolveAgent: async (sessionId) => {
      let session = sessions.get(sessionId)
      if (!session) { session = { sessionId, events: appendedEvents, append: (t, d) => appendedEvents.push({ t, d }) }; sessions.set(sessionId, session) }
      return { session }
    },
    chatPage: async (sessionId, cursor) => ({ sessionId, items: [{ kind: 'bot', text: 'local', sessionId }], cursor: null }),
    joinedChatPage: async (botId, cursor) => {
      throw new Error('joinedChatPage must NOT be called in S2-2')
    },
    save: async () => { saves.push(1) },
    pastOwners: new Map(),
    roomOf: () => undefined,
    sessionOfRoom: () => undefined,
    ensureCapabilities: async () => {},
    warn: () => {},
    turnTracker: { start: () => {}, finish: () => {} },
  }
  return { rt, sent, appendedEvents, created, saves, prompts, bySessionIdMap, botOfMap, registry }
}

describe('S22: channel sendUser routing (via createSendUser)', () => {
  it('S22-send-routes-executor: joined bot → bot/turn sent once, mirror events written', async () => {
    // Knife: delete `if (joinedBot) { ... }` block in createSendUser → falls through to sessionController.prompt → sent=[],prompts=[1] → fail
    const bot = makeJoinedBotFull()
    const { rt, sent, appendedEvents, prompts } = makeChannelRt(bot)
    const sendUser = createSendUser(rt)
    await sendUser({ sessionId: bot.id, content: [{ type: 'text', text: 'ping' }] })
    assert.equal(sent.filter(f => f.type === 'bot/turn').length, 1, 'bot/turn must be sent exactly once')
    assert.equal(prompts.length, 0, 'sessionController.prompt must NOT be called for joined bot')
    const userMsgs = appendedEvents.filter(e => e.t === 'user/message')
    const asstMsgs = appendedEvents.filter(e => e.t === 'assistant/message')
    assert.equal(userMsgs.length, 1, 'mirror must write exactly 1 user/message')
    assert.equal(asstMsgs.length, 1, 'mirror must write exactly 1 assistant/message')
  })

  it('S22-by-session: mirror sessionId resolves to joined bot via bySessionId', async () => {
    // Knife: delete `joinedShadow(rt.bySessionId(ref)) ? rt.bySessionId(ref)` branch → falls through to original path → prompts=[1] → fail
    const bot = makeJoinedBotFull({ sessionId: 'mirror-sess-1' })
    const { rt, sent, prompts, bySessionIdMap } = makeChannelRt(bot)
    // Simulate that bySessionIdMap already has the mirror session mapped to bot
    bySessionIdMap.set('mirror-sess-1', bot)
    const sendUser = createSendUser(rt)
    await sendUser({ sessionId: 'mirror-sess-1', content: [{ type: 'text', text: 'hi' }] })
    assert.equal(sent.filter(f => f.type === 'bot/turn').length, 1, 'bot/turn must be sent via bySessionId lookup')
    assert.equal(prompts.length, 0, 'sessionController.prompt must NOT be called')
  })

  it('S22-chat-page-local: joined bot with sessionId returns local chatPage, no joinedChatPage', async () => {
    // Knife: delete joinedShadow branch in createChatPageRoute → falls through to rt.chatPage(botId) → wrong sessionId
    const bot = makeJoinedBotFull({ sessionId: 'local-sid-99' })
    const { rt } = makeChannelRt(bot)
    const chatPageCalled = []
    rt.chatPage = async (sid) => { chatPageCalled.push(sid); return { sessionId: sid, items: [{ kind: 'bot', text: 'local' }], cursor: null } }
    const joinedChatPageCalled = []
    rt.joinedChatPage = async () => { joinedChatPageCalled.push(1); return { sessionId: 'remote', items: [], cursor: null } }
    rt.load = async () => {}
    const route = createChatPageRoute(rt)
    const result = await route({ botId: bot.id, cursor: undefined })
    assert.ok(result.items.length > 0, 'local chatPage should return items')
    assert.equal(chatPageCalled.length, 1, 'chatPage should be called once')
    assert.equal(chatPageCalled[0], 'bot-j1', 'chatPage must be called with bot.id not sessionId')
    assert.equal(joinedChatPageCalled.length, 0, 'joinedChatPage must NOT be called')
  })

  it('S22-no-session: createSession throws → sendUser rejects code no-session, no bot/turn', async () => {
    // Knife: catch error in ensureMirrorSession silently → no rejection → test fails (prompts=0, no rejection)
    const bot = makeJoinedBotFull()
    const { rt, sent } = makeChannelRt(bot)
    rt.createSession = async () => { throw new Error('disk full') }
    const sendUser = createSendUser(rt)
    await assert.rejects(
      () => sendUser({ sessionId: bot.id, content: [{ type: 'text', text: 'hi' }] }),
      (err) => {
        assert.equal(err.code, 'no-session', 'error must have code no-session')
        assert.match(err.message, /creation failed/, 'error message must mention creation failed')
        return true
      }
    )
    assert.equal(sent.filter(f => f.type === 'bot/turn').length, 0, 'bot/turn must NOT be sent when session creation fails')
  })


  it('S22-chatpage-botid: createChatPageRoute calls rt.chatPage with bot.id, not sessionId', async () => {
    // Knife: change rt.chatPage(chatBot.id) back to rt.chatPage(chatBot.sessionId) → wrong arg → red
    const bot = makeJoinedBotFull({ sessionId: 'sess-xyz-99' })
    const { rt } = makeChannelRt(bot)
    const chatPageArgs = []
    rt.chatPage = async (arg) => { chatPageArgs.push(arg); return { sessionId: arg, items: [{ kind: 'bot', text: 'x' }], cursor: null } }
    rt.load = async () => {}
    const route = createChatPageRoute(rt)
    await route({ botId: bot.id })
    assert.equal(chatPageArgs.length, 1)
    assert.equal(chatPageArgs[0], 'bot-j1', 'rt.chatPage must receive bot.id, not sessionId')
    assert.notEqual(chatPageArgs[0], 'sess-xyz-99', 'must NOT pass sessionId')
  })
  it('S22-chat-page-empty: joined bot with null sessionId returns empty page, no chatPage call', async () => {
    // Knife: delete empty-session branch in createChatPageRoute → falls through to rt.chatPage(botId) → wrong
    const bot = makeJoinedBotFull({ sessionId: null })
    const { rt } = makeChannelRt(bot)
    const chatPageCalled = []
    rt.chatPage = async (sid) => { chatPageCalled.push(sid); return { sessionId: sid, items: [], cursor: null } }
    rt.load = async () => {}
    const route = createChatPageRoute(rt)
    const result = await route({ botId: bot.id, cursor: undefined })
    assert.equal(result.items.length, 0, 'empty page should have no items')
    assert.equal(result.cursor, null, 'empty page cursor should be null')
    assert.equal(chatPageCalled.length, 0, 'rt.chatPage must NOT be called when sessionId is null')
  })

  it('S22-resolve-fail: createSession succeeds but resolveAgent throws → code no-session', async () => {
    // Knife: remove resolveAgent try/catch wrapper → raw error propagates without code → test fails
    const bot = makeJoinedBotFull()
    const { rt, sent } = makeChannelRt(bot)
    rt.resolveAgent = async () => { throw new Error('agent gone') }
    const sendUser = createSendUser(rt)
    await assert.rejects(
      () => sendUser({ sessionId: bot.id, content: [{ type: 'text', text: 'hi' }] }),
      (err) => {
        assert.equal(err.code, 'no-session', 'error must have code no-session')
        assert.match(err.message, /resolve failed/, 'error message must mention resolve failed')
        return true
      }
    )
    assert.equal(sent.filter(f => f.type === 'bot/turn').length, 0, 'bot/turn must NOT be sent when resolveAgent fails')
  })
})
