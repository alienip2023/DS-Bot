// A node older than ra 0.10.1-fork.76 has no `memory-sync/1`, so a Bot created on it
// must not default to federation: the node would drop the field and the shadow row
// would describe a backend the node never runs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotOnNode, install as installJoinedCreate } from '../src/host/joined-create.js'

function registryWith(caps) {
  const listeners = new Map()
  const sent = []
  const on = (name, fn) => { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)).add(fn) }
  const off = (name, fn) => { listeners.get(name)?.delete(fn) }
  const emit = (name, payload) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload) }
  const send = (nodeId, type, data) => {
    sent.push({ nodeId, type, data })
    if (type === 'bot/create') setTimeout(() => emit('botCreateResult', { requestId: data.requestId, ok: true, remoteBotId: 'rb1', name: data.name }), 0)
    return true
  }
  return { sent, on, off, send, onlineNodes: () => [{ nodeId: 'n1', models: null, caps }] }
}

function runtime(caps) {
  const registry = registryWith(caps)
  const rt = { state: {}, ctx: { get: name => (name === 'remote-agent:registry' ? registry : undefined) }, botCreateTimeoutMs: 200, save: async () => {}, botOf(id) { return this.state.bots?.[id] } }
  return { rt, registry }
}

const create = (rt, extra = {}) => createBotOnNode(rt, { nodeId: 'n1', name: 'Scout', role: '', modelRef: null, ...extra })

test('an old node gets no memoryConfig and the shadow row is not federated', async () => {
  const { rt, registry } = runtime(['bot-create/1'])
  const result = await create(rt)
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(registry.sent[0].data, 'memoryConfig'), false, 'the frame carries no backend')
  assert.equal(Object.hasOwn(rt.state.bots[result.id], 'memoryConfig'), false, 'the shadow row is not federated')
})

test('a node that announces memory-sync/1 still defaults to federation', async () => {
  const { rt, registry } = runtime(['memory-sync/1'])
  const result = await create(rt)
  assert.equal(result.ok, true)
  assert.deepEqual(registry.sent[0].data.memoryConfig, { backend: 'federation' })
  assert.deepEqual(rt.state.bots[result.id].memoryConfig, { backend: 'federation' })
})

test('an explicit backend is sent to both an old and a new node', async () => {
  for (const caps of [['bot-create/1'], ['memory-sync/1']]) {
    for (const backend of ['file', 'none']) {
      const { rt, registry } = runtime(caps)
      const result = await create(rt, { memoryConfig: { backend } })
      assert.equal(result.ok, true)
      assert.deepEqual(registry.sent[0].data.memoryConfig, { backend }, `${caps} takes an explicit ${backend}`)
    }
  }
})

import { install as installChannel } from '../src/host/channel.js'

// Fake registry with configurable online nodes and auto-reply botCreateResult.
function makeRegistry(nodes = []) {
  const listeners = {}
  return {
    _sent: [],
    _nodes: nodes.slice(),
    onlineNodes() { return this._nodes.slice() },
    send(nid, type, data) {
      this._sent.push({ nodeId: nid, type, data })
      Promise.resolve().then(() => {
        ;(listeners['botCreateResult'] ?? []).forEach(fn => fn({
          requestId: data.requestId,
          ok: true,
          remoteBotId: 'remote-bot-1',
          name: data.name,
          role: data.role ?? '',
        }))
      })
      return true
    },
    on(name, fn) { (listeners[name] ??= []).push(fn) },
    off(name, fn) { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn) },
    emit(name, payload) { (listeners[name] ?? []).forEach(f => f(payload)) },
  }
}

// Minimal rt following thinking.test.js api() pattern.
function makeRt({ nodes = [] } = {}) {
  const reg = makeRegistry(nodes)
  const localCreated = []
  const state = { revision: 0, bots: {}, rooms: {}, exchanges: [], questions: {}, agents: {}, secretRequests: {}, prefs: {}, mainBotIds: [] }
  let route = null
  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) { return name === 'remote-agent:registry' ? reg : undefined },
    on: () => () => {},
    effect: execute => { execute() },
    set() {},
    tools: { register: () => () => {}, guard: () => () => {}, schemas: () => [] },
    systemPrompt: { section: () => () => {} },
    connection: { fetch: { register(r) { route = r; return () => {} } } },
    llm: { listProviders: () => [] },
  }
  const rt = {
    ctx,
    state,
    botCreateTimeoutMs: 500,
    save: async () => {},
    refresh: async () => {},
    readOnly: () => undefined,
    load: async () => {},
    bootstrap: async () => {},
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
    // Fake local createBot
    async createBot(opts) {
      const id = `local-${opts.name ?? 'bot'}`
      localCreated.push(opts)
      state.bots[id] = { id, name: opts.name, role: opts.role ?? '' }
      return state.bots[id]
    },
  }
  // Wire createBotOnNode via joined-create install
  installJoinedCreate(rt)
  installChannel(rt)

  const call = async (endpoint, payload) => {
    const response = await route.fetch({
      json: async () => ({ endpoint, payload }),
      signal: new AbortController().signal,
    })
    return response.json()
  }

  return { rt, reg, call, localCreated }
}


test('bot-create-targets reports federates from the node caps', async () => {
  const { call } = makeRt({ nodes: [
    { nodeId: 'old', hostname: 'old-box', caps: ['bot-create/1'] },
    { nodeId: 'new', hostname: 'new-box', hello: { caps: ['memory-sync/1', 'bot-create/1'] } },
    { nodeId: 'bare', hostname: 'bare-box' },
  ] })
  const res = await call('bot-create-targets', {})
  assert.equal(res.ok, true, JSON.stringify(res.error))
  const byId = Object.fromEntries(res.value.map(n => [n.nodeId, n.federates]))
  assert.equal(byId.old, false, 'a node without memory-sync/1 does not federate')
  assert.equal(byId.new, true, 'a node that announces memory-sync/1 federates')
  assert.equal(byId.bare, false, 'a node with no caps at all does not federate')
})
