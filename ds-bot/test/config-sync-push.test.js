// Tests for the change-detection loop in src/host/config-source.js and for the fail-closed
// model selection of a Bot the main created. The settings, llm and remote-agent services are
// fakes, but install()/desiredModel()/the node receiver are the real product code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { install } from '../src/host/config-source.js'

const KEY_A = 'sk-AAAA-secret-value-1111'
const KEY_B = 'sk-BBBB-secret-value-2222'
const PROFILES = {
  alpha: { api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'm1', name: 'Model 1' }, { id: 'm2' }] },
  beta: { api: 'anthropic-messages', apiKeyEnv: 'BETA_KEY', models: [{ id: 'b1', name: 'B One' }] },
  nokey: { api: 'openai-completions', baseURL: 'https://n.example', apiKeyEnv: 'NOKEY_KEY', models: [{ id: 'n1' }] },
}

const flush = () => new Promise(resolve => setImmediate(resolve))

// One hub runtime: a real credentials file, fake settings/llm services, a fake registry whose
// nodes are just ids, and a fake config-sync service that records every sendPush.
function makeWorld({ nodes = ['n1'], send = () => true } = {}) {
  const warns = []
  const pushes = []
  const acks = []
  const profiles = JSON.parse(JSON.stringify(PROFILES))
  const home = mkdtempSync(join(tmpdir(), 'cfgsync-'))
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  ALPHA_KEY: ' + JSON.stringify(KEY_A) + '\n  BETA_KEY: ' + JSON.stringify(KEY_B) + '\n')
  const store = Object.create(null)
  const ctx = {
    get: name => store[name],
    llm: {
      listConfigurableProviders: () => Object.keys(profiles).map(id => ({ provider: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id] })),
    },
  }
  store.settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles } }] }
  const rt = { ctx, dshHome: home, warn: (...args) => warns.push(format(...args)), defaultBotModel: async () => 'alpha/m1' }
  const service = {
    source: null,
    setSource(fn) { service.source = fn },
    sendPush(nodeId) { pushes.push(nodeId); return send(nodeId) },
  }
  store['remote-agent:config-sync'] = service
  store['remote-agent:registry'] = {
    onlineNodes: () => nodes.map(nodeId => ({ nodeId })),
    getNode: () => undefined,
    on: (event, fn) => { if (event === 'configAck') acks.push(fn) },
  }
  return { rt, store, service, pushes, acks, warns, profiles }
}

// install() ticks immediately and every 5s. Reaching t=5000 first settles the fingerprint the
// first round pushed, so a test that changes something afterwards sees exactly that change.
async function settle(t, world) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  install(world.rt)
  await flush()
  t.mock.timers.tick(5_000)
  await flush()
  world.pushes.length = 0
}

test('A1 a changed default model is pushed within the next tick', async (t) => {
  const world = makeWorld()
  await settle(t, world)
  world.rt.defaultBotModel = async () => 'alpha/m2'
  t.mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(world.pushes, ['n1'])
  const payload = world.service.source('n1')
  assert.equal(payload.defaultModel, 'alpha/m2', 'the source the node reads carries the new default')
})

test('A2 the same payload pushes nothing, however many ticks pass', async (t) => {
  const world = makeWorld()
  await settle(t, world)
  for (let i = 0; i < 3; i += 1) { t.mock.timers.tick(5_000); await flush() }
  assert.deepEqual(world.pushes, [], 'no change, no push')
})

test('A3 two nodes get one push each, and no push storm follows the stable payload', async (t) => {
  const world = makeWorld({ nodes: ['n1', 'n2'] })
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  install(world.rt)
  await flush()
  world.pushes.length = 0
  t.mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(world.pushes, ['n1', 'n2'], 'each node pushed once')
  world.pushes.length = 0
  for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(5_000); await flush() }
  assert.deepEqual(world.pushes, [], 'a payload that did not change is not pushed again')
})

test('A4 a failing push is retried after 5s, 15s and 60s, then the node is stale', async (t) => {
  const world = makeWorld({ send: () => false })
  await settle(t, world)
  t.mock.timers.tick(5_000)   // t=10000: first retry (5s after the failure at 5000)
  await flush()
  t.mock.timers.tick(5_000)   // t=15000: still inside the 15s backoff
  await flush()
  t.mock.timers.tick(10_000)  // t=25000: second retry
  await flush()
  assert.deepEqual(world.pushes, ['n1', 'n1'], 'retried at 5s and 15s, not on every tick')
  t.mock.timers.tick(60_000)  // t=85000: third retry
  await flush()
  assert.equal(world.pushes.length, 3)
  assert.deepEqual(world.rt.configSyncStatus('n1'), { configStale: true, appliedRevision: null, lastError: 'push-failed' })
})

test('A5 a provider added on the main reaches the node payload and triggers a push', async (t) => {
  const world = makeWorld()
  await settle(t, world)
  world.profiles.gamma = { api: 'openai-completions', baseURL: 'https://g.example/v1', apiKeyEnv: 'GAMMA_KEY', models: [{ id: 'g1' }] }
  writeFileSync(join(world.rt.dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  ALPHA_KEY: ' + JSON.stringify(KEY_A) + '\n  BETA_KEY: ' + JSON.stringify(KEY_B) + '\n  GAMMA_KEY: ' + JSON.stringify('sk-GAMMA-secret-3333') + '\n')
  t.mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(world.pushes, ['n1'])
  assert.deepEqual(world.service.source('n1').providers.map(p => p.id), ['alpha', 'beta', 'gamma'])
})

test('A6 a provider without a key is left out of the payload, and a key added later pushes it', async (t) => {
  const world = makeWorld()
  await settle(t, world)
  assert.deepEqual(world.service.source('n1').providers.map(p => p.id), ['alpha', 'beta'], 'nokey is not pushed half-made')
  world.profiles.nokey.apiKeyEnv = 'ALPHA_KEY'
  t.mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(world.pushes, ['n1'])
  assert.deepEqual(world.service.source('n1').providers.map(p => p.id), ['alpha', 'beta', 'nokey'])
})

// ── Receipts ───────────────────────────────────────────────────────────────
// A schema 2 node answers every push. A refusal is a failure like a frame that never left:
// same 5s/15s/60s backoff, same stale mark after the third, and the payload is pushed again
// inside the same fingerprint. A schema 1 node never answers, so the send itself is its
// confirmation.

const receipt = (world, ev) => { for (const fn of world.acks) fn(ev) }

// A node that announced config-sync/2 answers every push with a receipt; the schema 1 fixture
// above never does.
const v2World = (options = {}) => {
  const world = makeWorld(options)
  world.store['remote-agent:registry'].getNode = () => ({ hello: { caps: ['config-sync/2'] } })
  return world
}

test('B1 a refused receipt retries at 5s, 15s and 60s, and the third marks the node stale', async (t) => {
  const world = v2World()
  await settle(t, world)
  receipt(world, { nodeId: 'n1', ok: false, error: 'config-sync-refused' })
  t.mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(world.pushes, ['n1'], 'first retry 5s after the refusal')
  receipt(world, { nodeId: 'n1', ok: false, error: 'config-sync-refused' })
  t.mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(world.pushes, ['n1'], 'nothing before the 15s backoff')
  t.mock.timers.tick(10_000)
  await flush()
  assert.deepEqual(world.pushes, ['n1', 'n1'], 'second retry 15s after the second refusal')
  receipt(world, { nodeId: 'n1', ok: false, error: 'config-sync-refused' })
  assert.deepEqual(world.rt.configSyncStatus('n1'), { configStale: true, appliedRevision: null, lastError: 'config-sync-refused' }, 'three refusals mark it stale')
  t.mock.timers.tick(5_000)
  await flush()
  assert.equal(world.pushes.length, 2, 'nothing before the 60s backoff')
  t.mock.timers.tick(55_000)
  await flush()
  assert.equal(world.pushes.length, 3, 'a stale node is still retried, once per 60s')
})

test('B2 a refusal on one node leaves an applied node untouched', async (t) => {
  const world = v2World({ nodes: ['n1', 'n2'] })
  await settle(t, world)
  receipt(world, { nodeId: 'n2', ok: true, appliedRevision: 7 })
  receipt(world, { nodeId: 'n1', ok: false, error: 'config-sync-refused' })
  t.mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(world.pushes, ['n1'], 'only the refused node is pushed again')
  assert.deepEqual(world.rt.configSyncStatus('n2'), { configStale: false, appliedRevision: 7, lastError: null })
})

test('B3 a later accepted receipt clears stale, records the revision and ends the retries', async (t) => {
  const world = v2World()
  await settle(t, world)
  receipt(world, { nodeId: 'n1', ok: false, error: 'config-sync-refused' })
  t.mock.timers.tick(5_000)
  await flush()
  receipt(world, { nodeId: 'n1', ok: false, error: 'config-sync-refused' })
  t.mock.timers.tick(15_000)
  await flush()
  receipt(world, { nodeId: 'n1', ok: false, error: 'config-sync-refused' })
  assert.equal(world.rt.configSyncStatus('n1').configStale, true)
  receipt(world, { nodeId: 'n1', ok: true, appliedRevision: 12 })
  assert.deepEqual(world.rt.configSyncStatus('n1'), { configStale: false, appliedRevision: 12, lastError: null }, 'the accepted receipt settles the node')
  const sent = world.pushes.length
  for (let i = 0; i < 4; i += 1) { t.mock.timers.tick(5_000); await flush() }
  assert.equal(world.pushes.length, sent, 'an applied node is not pushed again')
})

test('B4 a schema 1 node counts as applied when the push leaves, so no receipt is awaited', async (t) => {
  const world = makeWorld()
  world.store['remote-agent:registry'].getNode = () => ({ hello: { caps: [] } })
  await settle(t, world)
  for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(5_000); await flush() }
  assert.deepEqual(world.pushes, [], 'an old node is never retried for a receipt it cannot send')
  assert.equal(world.rt.configSyncStatus('n1').configStale, false)
  world.rt.defaultBotModel = async () => 'alpha/m2'
  t.mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(world.pushes, ['n1'], 'a real change still reaches it once')
  for (let i = 0; i < 3; i += 1) { t.mock.timers.tick(5_000); await flush() }
  assert.deepEqual(world.pushes, ['n1'], 'and it is not pushed again')
})
