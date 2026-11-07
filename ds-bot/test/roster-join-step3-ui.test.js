// Behavioral tests for the channel UI layer: create-bot nodeId routing and bot-create-targets.
// No createRuntime import — constructs a fake rt directly, as in roster-join-step3.test.js,
// following the api() helper pattern from thinking.test.js.
// Knife requirement: delete the nodeId branch in channel.js → tests fail on behavior, not source regex.
import test from 'node:test'
import assert from 'node:assert/strict'
import { install as installChannel } from '../src/host/channel.js'
import { install as installJoinedCreate } from '../src/host/joined-create.js'

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

// ── Knife test: delete the nodeId branch → tests fail on behavior, not source regex ──
test('create-bot with nodeId routes to createBotOnNode and does not call local createBot', async () => {
  const { call, reg, localCreated } = makeRt({ nodes: [{ nodeId: 'node-x', hostname: 'worker-1' }] })

  const res = await call('create-bot', { nodeId: 'node-x', name: 'RemoteAlpha', role: '工' })
  assert.equal(res.ok, true, `create-bot with nodeId failed: ${JSON.stringify(res.error)}`)

  // A bot/create frame must have been sent via the registry (nodeId branch active)
  const sent = reg._sent.find(s => s.type === 'bot/create')
  assert.ok(sent, '没有向 registry 发出 bot/create 帧 — nodeId 分支没生效')
  assert.equal(sent.nodeId, 'node-x')

  // Local createBot must NOT have been called
  assert.equal(localCreated.length, 0,
    'local createBot should not be called when nodeId is provided')
})

test('create-bot with unknown nodeId returns error and writes no shadow row', async () => {
  const { call, rt } = makeRt({ nodes: [{ nodeId: 'node-x', hostname: 'worker-1' }] })

  const res = await call('create-bot', { nodeId: 'node-unknown', name: 'Ghost', role: '' })
  assert.equal(res.ok, false, 'should fail for unknown node')

  const joinedBots = Object.values(rt.state.bots).filter(b => b.origin === 'joined')
  assert.equal(joinedBots.length, 0, '不应有影子行')
})

test('create-bot without createBotOnNode returns bot-create-unavailable', async () => {
  const { rt, call } = makeRt({ nodes: [{ nodeId: 'node-x', hostname: 'worker-1' }] })
  // Remove createBotOnNode to simulate remote-agent absent
  delete rt.createBotOnNode

  const res = await call('create-bot', { nodeId: 'node-x', name: 'Ghost' })
  assert.equal(res.ok, false)
  assert.ok(
    (res.error?.message ?? '').includes('bot-create-unavailable') || res.error === 'bot-create-unavailable',
    `expected bot-create-unavailable, got: ${JSON.stringify(res.error)}`
  )
})

test('bot-create-targets returns online nodes from registry', async () => {
  const { call } = makeRt({ nodes: [{ nodeId: 'node-a', hostname: 'machine-a' }, { nodeId: 'node-b', hostname: 'machine-b' }] })

  const res = await call('bot-create-targets', {})
  assert.equal(res.ok, true)
  assert.ok(Array.isArray(res.value))
  assert.equal(res.value.length, 2)
  assert.ok(res.value.map(n => n.nodeId).includes('node-a'))
  assert.ok(res.value.map(n => n.nodeId).includes('node-b'))
})

test('bot-create-targets returns empty array when no nodes online', async () => {
  const { call } = makeRt({ nodes: [] })

  const res = await call('bot-create-targets', {})
  assert.equal(res.ok, true)
  assert.deepEqual(res.value, [])
})

test('create-bot without nodeId creates a local Bot', async () => {
  const { call } = makeRt({ nodes: [] })

  const res = await call('create-bot', { name: 'LocalBot', role: '助手' })
  assert.equal(res.ok, true, `local create-bot failed: ${JSON.stringify(res.error)}`)
  assert.ok(res.value?.id, 'should return bot id')
})
