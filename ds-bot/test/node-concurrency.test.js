// Per-node task concurrency: the default, the push/apply path, the refusal retries,
// the old-node fallback, and the settings endpoint.
import test from 'node:test'
import assert from 'node:assert/strict'
import { install as installChannel } from '../src/host/channel.js'
import { install as installNodeConfig, nodeConcurrencyView, setNodeConcurrency, validConcurrency } from '../src/host/node-config.js'

function makeRegistry(nodes = []) {
  const listeners = new Map()
  const sent = []
  let deliver = true
  const registry = {
    sent,
    setDeliver: value => { deliver = value },
    onlineNodes: () => nodes,
    send: (nodeId, type, data) => { sent.push({ nodeId, type, data }); return deliver },
    on: (name, fn) => { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list) },
    off: (name, fn) => { const list = listeners.get(name) ?? []; const at = list.indexOf(fn); if (at !== -1) list.splice(at, 1) },
    emit: (name, payload) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload) },
  }
  return registry
}

function makeRt({ nodes = [] } = {}) {
  const registry = makeRegistry(nodes)
  let saves = 0
  const rt = {
    state: {},
    saves: () => saves,
    save: async () => { saves += 1 },
    load: async () => {},
    ctx: { get: key => (key === 'remote-agent:registry' ? registry : undefined) },
  }
  installNodeConfig(rt)
  return { rt, registry }
}

const flush = async (rounds = 12) => { for (let i = 0; i < rounds; i += 1) await Promise.resolve() }

test('a node that was never set runs its own default of 8', async () => {
  const { rt } = makeRt({ nodes: [{ nodeId: 'n1', hello: { hostname: 'machine-1' }, queue: { running: 2, queued: 3, maxConcurrent: 8, starved: false } }] })
  const view = await nodeConcurrencyView(rt)
  assert.equal(view.defaultConcurrency, 8)
  assert.equal(view.legacyConcurrency, 4)
  assert.equal(view.nodes.length, 1)
  assert.equal(view.nodes[0].hostname, 'machine-1')
  assert.equal(view.nodes[0].status, 'unknown')
  assert.deepEqual(view.nodes[0].queue, { running: 2, queued: 3, maxConcurrent: 8, starved: false })
})

test('setting 12 sends the frame and reports the value the node applied', async () => {
  const { rt, registry } = makeRt({ nodes: [{ nodeId: 'n1', hello: { hostname: 'machine-1' }, queue: null }] })
  const pending = setNodeConcurrency(rt, 'n1', 12)
  await flush()
  assert.equal(registry.sent.length, 1)
  assert.equal(registry.sent[0].type, 'node/config')
  assert.equal(registry.sent[0].data.maxConcurrent, 12)
  assert.equal(registry.sent[0].data.nodeId, 'n1')
  registry.emit('nodeConfigResult', { requestId: registry.sent[0].data.requestId, nodeId: 'n1', ok: true, maxConcurrent: 12 })
  const view = await pending
  assert.equal(view.status, 'applied')
  assert.equal(view.appliedMaxConcurrent, 12)
  assert.equal(rt.state.nodeLimits.n1.maxConcurrent, 12)
  assert.ok(rt.saves() >= 2, 'the saved value is on disk before the node answers')
})

test('an old node that never answers is reported as unsupported and keeps 4', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, registry } = makeRt({ nodes: [{ nodeId: 'old', hello: { hostname: 'old-box' } }] })
  const pending = setNodeConcurrency(rt, 'old', 12)
  await flush()
  assert.equal(registry.sent.length, 1)
  t.mock.timers.tick(5000)
  const view = await pending
  assert.equal(view.status, 'unsupported')
  assert.equal(view.appliedMaxConcurrent, 4)
  assert.equal(view.lastError, 'node-config-no-answer')
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(registry.sent.length, 1, 'a node that cannot answer is not retried forever')
})

test('a refusal is retried at 5s and 15s, then stays as a failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { rt, registry } = makeRt({ nodes: [{ nodeId: 'n1' }] })
  const pending = setNodeConcurrency(rt, 'n1', 33)
  await flush()
  registry.emit('nodeConfigResult', { requestId: registry.sent[0].data.requestId, ok: false, error: 'node-config-node-mismatch' })
  const view = await pending
  assert.equal(view.status, 'refused')
  await flush()
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(registry.sent.length, 2, 'the first retry goes out 5s later')
  registry.emit('nodeConfigResult', { requestId: registry.sent[1].data.requestId, ok: false, error: 'node-config-node-mismatch' })
  await flush()
  t.mock.timers.tick(15000)
  await flush()
  assert.equal(registry.sent.length, 3, 'the second retry goes out 15s later')
  registry.emit('nodeConfigResult', { requestId: registry.sent[2].data.requestId, ok: false, error: 'node-config-node-mismatch' })
  await flush()
  await flush()
  const last = await nodeConcurrencyView(rt)
  assert.equal(last.nodes[0].status, 'error')
  assert.equal(last.nodes[0].lastError, 'node-config-node-mismatch')
  t.mock.timers.tick(120000)
  await flush()
  assert.equal(registry.sent.length, 3, 'three attempts, then stop')
})

test('a limit outside 1–64 is refused before anything is sent', async () => {
  const { rt, registry } = makeRt({ nodes: [{ nodeId: 'n1' }] })
  assert.equal(validConcurrency(1), 1)
  assert.equal(validConcurrency(64), 64)
  assert.equal(validConcurrency(0), undefined)
  assert.equal(validConcurrency(65), undefined)
  assert.equal(validConcurrency('12'), undefined)
  await assert.rejects(() => setNodeConcurrency(rt, 'n1', 65), error => error.code === 'bot/invalid')
  await assert.rejects(() => setNodeConcurrency(rt, 'n1', 0), error => error.code === 'bot/invalid')
  assert.equal(registry.sent.length, 0)
})

test('the settings endpoint reads the node list and refuses a bad limit', async () => {
  const registry = makeRegistry([{ nodeId: 'n1', hello: { hostname: 'machine-1' }, queue: { running: 1, queued: 0, maxConcurrent: 8, starved: false } }])
  const state = { revision: 0, bots: {}, rooms: {}, mainBotIds: [], nodeLimits: {} }
  let route = null
  const ctx = {
    logger: { warn() {}, info() {} },
    get: key => (key === 'remote-agent:registry' ? registry : undefined),
    on: () => () => {},
    effect: fn => { fn() },
    set() {},
    tools: { register: () => () => {}, guard: () => () => {}, schemas: () => [] },
    systemPrompt: { section: () => () => {} },
    connection: { fetch: { register(r) { route = r; return () => {} } } },
    llm: { listProviders: () => [] },
  }
  const rt = {
    ctx, state, cachedCatalog: () => [], cachedDefault: () => undefined,
    secretsView: () => ({}), archivesView: () => ({}),
    load: async () => {}, bootstrap: async () => {}, loadSecrets: async () => {}, save: async () => {},
    refresh: async () => {}, readOnly: () => undefined, noteFailure: () => {},
  }
  installNodeConfig(rt)
  installChannel(rt)
  const call = async (endpoint, payload) => (await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })).json()

  const read = await call('node-config', {})
  assert.equal(read.ok, true)
  assert.equal(read.value.defaultConcurrency, 8)
  assert.equal(read.value.nodes[0].nodeId, 'n1')
  assert.equal(read.value.nodes[0].maxConcurrent, null)

  const bad = await call('node-config', { nodeId: 'n1', maxConcurrent: 99 })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bot/invalid')
  assert.equal(registry.sent.length, 0, 'an invalid limit never reaches the node')
})

test('a saved limit is pushed again when the node comes back', async () => {
  const { rt, registry } = makeRt({ nodes: [{ nodeId: 'n1' }] })
  rt.state.nodeLimits = { n1: { maxConcurrent: 12, appliedMaxConcurrent: 12, status: 'applied' } }
  registry.emit('nodeOnline', { nodeId: 'n1' })
  await flush()
  assert.equal(registry.sent.length, 1, 'a reconnect re-applies the saved value')
  assert.equal(registry.sent[0].data.maxConcurrent, 12)

  // A node that already said it does not know the frame is not asked again on
  // every reconnect; only a new save may try.
  rt.state.nodeLimits.n2 = { maxConcurrent: 6, status: 'unsupported' }
  registry.emit('nodeOnline', { nodeId: 'n2' })
  await flush()
  assert.equal(registry.sent.length, 1)
})
