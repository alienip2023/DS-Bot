// M3: joined-page — open remote Bot's conversation via bot/history RPC.
// Both the hub side (joinedChatPage → sends frame → waits for botHistoryResult)
// and the node side (createBotPageReceiver → calls rt.chatPage → returns page).
import test from 'node:test'
import assert from 'node:assert/strict'
import { joinedChatPage, createBotPageReceiver, exposeBotPageReceiver } from '../src/host/joined-page.js'

// ── stub helpers ──────────────────────────────────────────────────────────────

function makeRegistry({ online = true, sendOk = true, resultPayload } = {}) {
  const listeners = {}
  const sent = []
  const registry = {
    nodes: new Map([['n1', { nodeId: 'n1', online, lastSeen: 0 }]]),
    send(nodeId, type, data) { sent.push({ nodeId, type, data }); return sendOk },
    on(event, fn) { (listeners[event] = listeners[event] ?? []).push(fn) },
    off(event, fn) { if (listeners[event]) listeners[event] = listeners[event].filter(l => l !== fn) },
    emit(event, payload) { (listeners[event] ?? []).forEach(l => l(payload)) },
  }
  // Auto-emit result after send (synchronous in tests)
  const origSend = registry.send.bind(registry)
  registry.send = (nodeId, type, data) => {
    const ok = origSend(nodeId, type, data)
    if (type === 'bot/history' && resultPayload !== undefined) {
      setImmediate(() => registry.emit('botHistoryResult', { requestId: data.requestId, ...resultPayload }))
    }
    return ok
  }
  return { registry, sent }
}

function makeRt({ nodeOnline = true, hasRegistry = true, sendOk = true, resultPayload } = {}) {
  const { registry, sent } = makeRegistry({ online: nodeOnline, sendOk, resultPayload })
  const ctx = { get: (name) => name === 'remote-agent:registry' ? (hasRegistry ? registry : undefined) : undefined }
  const rt = {
    ctx,
    state: { bots: {} },
    botOf(id) { return this.state.bots[id] },
    joinedHistoryTimeoutMs: 5000,
  }
  rt.joinedChatPage = (botId, cursor) => joinedChatPage(rt, botId, cursor)
  const botId = 'joined:n1:session-abc'
  rt.state.bots[botId] = { id: botId, origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'session-abc', home: 'remote', online: true } }
  return { rt, registry, sent, botId }
}

// ── hub side tests ─────────────────────────────────────────────────────────────

test('1. happy path: joined bot → sends bot/history frame and returns items', async () => {
  const items = [{ kind: 'user', text: 'hello', seq: 1 }, { kind: 'bot', text: '2+2=4', seq: 2 }]
  const { rt, sent, botId } = makeRt({ resultPayload: { ok: true, sessionId: 'session-abc', items, cursor: null } })
  const page = await rt.joinedChatPage(botId)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'bot/history')
  assert.equal(sent[0].data.remoteBotId, 'session-abc')
  assert.deepEqual(page.items, items)
  assert.equal(page.sessionId, 'session-abc')
  assert.equal(page.cursor, null)
})

test('2. node offline → returns offline item, no frame sent', async () => {
  const { rt, sent, botId } = makeRt({ nodeOnline: false })
  const page = await rt.joinedChatPage(botId)
  assert.equal(sent.length, 0, 'must not send to offline node')
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].kind, 'bot')
  assert.match(page.items[0].text, /离线/)
  assert.equal(page.cursor, null)
})

test('3. registry absent → returns offline item', async () => {
  const { rt, sent, botId } = makeRt({ hasRegistry: false })
  const page = await rt.joinedChatPage(botId)
  assert.equal(sent.length, 0)
  assert.equal(page.items[0].kind, 'bot')
  assert.match(page.items[0].text, /不可用|离线|无法/)
})

test('4. node returns ok:false → returns error item', async () => {
  const { rt, botId } = makeRt({ resultPayload: { ok: false, error: 'bot-history-no-receiver' } })
  const page = await rt.joinedChatPage(botId)
  assert.equal(page.items[0].kind, 'bot')
  assert.match(page.items[0].text, /bot-history-no-receiver|无法/)
  assert.equal(page.cursor, null)
})

test('5. send returns false → returns offline item', async () => {
  const { rt, botId } = makeRt({ sendOk: false })
  const page = await rt.joinedChatPage(botId)
  assert.match(page.items[0].text, /桥已断|离线|无法/)
})

// ── node side tests ────────────────────────────────────────────────────────────

function makeNodeRt(chatPageResult) {
  const provided = {}
  const ctx = {
    provide(name, impl) { provided[name] = impl },
    provided,
  }
  const rt = {
    ctx,
    chatPage: async (botId, cursor) => {
      if (chatPageResult instanceof Error) throw chatPageResult
      return chatPageResult
    },
  }
  exposeBotPageReceiver(ctx, createBotPageReceiver(rt))
  return { rt, ctx: ctx }
}

test('6. node receiver calls rt.chatPage and returns page', async () => {
  const items = [{ kind: 'user', text: 'hi', seq: 1 }]
  const { ctx } = makeNodeRt({ sessionId: 'session-abc', items, cursor: null })
  const receiver = ctx.provided['remote-agent:bot-page']
  assert.equal(typeof receiver, 'function', 'receiver must be registered')
  const result = await receiver({ remoteBotId: 'session-abc', cursor: null })
  assert.equal(result.ok, true)
  assert.deepEqual(result.items, items)
  assert.equal(result.sessionId, 'session-abc')
})

test('7. node receiver: missing remoteBotId → error', async () => {
  const { ctx } = makeNodeRt({ sessionId: 's', items: [], cursor: null })
  const receiver = ctx.provided['remote-agent:bot-page']
  const result = await receiver({ remoteBotId: '' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bot-history-remoteBotId-missing')
})

test('8. node receiver: chatPage throws → ok:false error', async () => {
  const { ctx } = makeNodeRt(new Error('not found'))
  const receiver = ctx.provided['remote-agent:bot-page']
  const result = await receiver({ remoteBotId: 'session-x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /bot-history-failed: /)
})


// ── channel.js routing test ──────────────────────────────────────────────────────
// Goes through the real channel.js installed route (installChannel + route.fetch).
// Knife: remove the joined-shadow branch in channel.js case 'chat' → this goes red.
import { install as installChannel } from '../src/host/channel.js'

function makeChannelRtForChat() {
  let chatPageCalls = 0
  let joinedChatPageCalls = 0
  const items = [{ kind: 'user', text: 'remote hello' }]
  let route = null
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    effect: (execute) => { execute() },
    set() {},
    provide() {},
    tools: { register: () => () => {}, guard: () => () => {}, schemas: () => [] },
    systemPrompt: { section: () => () => {} },
    connection: { fetch: { register(r) { route = r; return () => {} } } },
    llm: { listProviders: () => [] },
    logger: { warn() {} },
  }
  const state = { bots: {}, rooms: {}, exchanges: [], questions: {}, agents: {}, secretRequests: {}, prefs: {}, mainBotIds: [] }
  const rt = {
    ctx,
    state,
    botOf(id) { return this.state.bots[id] },
    async load() {},
    save: async () => {},
    readOnly: () => undefined,
    refresh: async () => {},
    catalog: async () => {},
    loadSecrets: async () => {},
    cachedCatalog: () => [],
    cachedDefault: () => undefined,
    reasoningOf: () => undefined,
    providersView: async () => ({}),
    secretsView: () => ({}),
    capabilityLibraryView: () => ({}),
    activityView: () => ({}),
    workView: () => ({}),
    roomWorkView: () => ({}),
    approvalsView: () => ({}),
    waitingView: () => ({}),
    turnsView: () => ({}),
    memoryNews: () => ({}),
    memoryReviews: () => ({}),
    connectorsView: () => ({}),
    capabilityStatusesView: () => ({}),
    selfOf: () => undefined,
    thinkingOf: async () => undefined,
    warn() {},
    noteFailure() {},
    chatOf(botId) { const bot = this.state.bots[botId]; return bot?.sessionId ?? botId },
    async chatPage() { chatPageCalls++; return { sessionId: 'local-s', items: [{ kind: 'user', text: 'local page' }], cursor: null } },
    joinedChatPage() { joinedChatPageCalls++; return Promise.resolve({ sessionId: 'remote-s', items, cursor: null }) },
    joinedHistoryTimeoutMs: 5000,
  }
  state.bots['joined:n1:session-abc'] = { id: 'joined:n1:session-abc', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'session-abc', home: 'remote' } }
  state.bots['local-bot'] = { id: 'local-bot', origin: 'local', sessionId: 'local-s' }
  installChannel(rt)
  const call = async (endpoint, payload) => {
    const response = await route.fetch({
      json: async () => ({ endpoint, payload }),
      signal: new AbortController().signal,
    })
    return response.json()
  }
  return { call, getChatPageCalls: () => chatPageCalls, getJoinedChatPageCalls: () => joinedChatPageCalls }
}

test('9. channel chat route: joined shadow → joinedChatPage, local bot → chatPage', async () => {
  const { call, getChatPageCalls, getJoinedChatPageCalls } = makeChannelRtForChat()
  // joined shadow → must route to joinedChatPage
  const joinedRes = await call('chat', { botId: 'joined:n1:session-abc' })
  assert.equal(joinedRes.ok, true)
  assert.equal(getJoinedChatPageCalls(), 1, 'joinedChatPage must be called for joined shadow')
  assert.equal(getChatPageCalls(), 0, 'chatPage must NOT be called for joined shadow')
  assert.deepEqual(joinedRes.value.items, [{ kind: 'user', text: 'remote hello' }])
  // local bot → must route to chatPage
  const localRes = await call('chat', { botId: 'local-bot' })
  assert.equal(getChatPageCalls(), 1, 'chatPage must be called for local bot')
  assert.equal(getJoinedChatPageCalls(), 1, 'joinedChatPage must NOT be called for local bot')
  assert.deepEqual(localRes.value.items, [{ kind: 'user', text: 'local page' }])
})

// ── Test 10: real NodeRegistry event path ─────────────────────────────────────
// Knife: change the event name in listenBotHistoryResult → test red.
// Uses real NodeRegistry from the sibling dsh-remote-agent checkout.
import { NodeRegistry } from '/Users/kjclaw/Library/Application Support/dsh-desktop/harness/bot/workspace/roster-join-3/dsh-remote-agent/lib/hub/node-registry.js'
import { HUB_TO_NODE, NODE_TO_HUB } from '/Users/kjclaw/Library/Application Support/dsh-desktop/harness/bot/workspace/roster-join-3/dsh-remote-agent/lib/protocol.js'

test('10. joinedChatPage: real NodeRegistry.emit botHistoryResult → items returned correctly', async () => {
  const relay = { ready: true, send: () => true }
  const registry = new NodeRegistry({ log() {}, relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0, e2e: null })

  const ITEMS = [{ kind: 'user', text: '2+2=4', seq: 1 }, { kind: 'bot', text: 'yes', seq: 2 }]
  const ctx = { get: (name) => name === 'remote-agent:registry' ? registry : undefined }
  const rt = {
    ctx,
    state: { bots: {} },
    botOf(id) { return this.state.bots[id] },
    joinedHistoryTimeoutMs: 2000,
  }
  const botId = 'joined:n1:session-real'
  rt.state.bots[botId] = { id: botId, origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'session-real', home: 'remote' } }

  // Intercept registry.send to capture requestId and auto-emit the result
  const origSend = registry.send.bind(registry)
  registry.send = (nid, type, data) => {
    setImmediate(() => registry.emit('botHistoryResult', { requestId: data.requestId, ok: true, sessionId: 'session-real', items: ITEMS, cursor: null }))
    return true
  }

  const page = await joinedChatPage(rt, botId, null)
  assert.equal(page.sessionId, 'session-real')
  assert.deepEqual(page.items, ITEMS, 'items must match what registry emitted')
  assert.equal(page.cursor, null)
  registry.send = origSend
})
