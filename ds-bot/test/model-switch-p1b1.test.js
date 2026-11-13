// P1b-1: joined Bot model switching — ds-bot side tests.
// All tests call the REAL production functions; no logic is duplicated inline.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { joinedUpdateBot, createBotUpdateReceiver } from '../src/host/joined-page.js'
import { mapNodeModel, install as installChannel } from '../src/host/channel.js'

// ── P1: joinedUpdateBot shadow sync ───────────────────────────────────────────

function makeRegistry(opts = {}) {
  const listeners = {}
  return {
    sends: [],
    send(nodeId, type, data) { this.sends.push({ nodeId, type, data }); return opts.sendReturn ?? true },
    on(event, fn) {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(fn)
    },
    off(event, fn) {
      if (listeners[event]) listeners[event] = listeners[event].filter(l => l !== fn)
    },
    emit(event, payload) { for (const fn of listeners[event] ?? []) fn(payload) },
    onlineNodes() { return opts.online ?? [{ nodeId: 'n1' }] },
  }
}

function makeRt(registry, bot) {
  const bots = { [bot.id]: bot }
  return {
    state: { bots },
    botOf: (id) => bots[id],
    ctx: { get: (key) => key === 'remote-agent:registry' ? registry : undefined },
    botUpdateTimeoutMs: 200,
    save: async () => {},
  }
}

describe('P1b1: joinedUpdateBot shadow sync', () => {
  it('P1-sync-appliedModel: successful bot/update writes model AND appliedModel on shadow', async () => {
    // Knife: remove bot.appliedModel = result.model in joined-page.js:183 → appliedModel undefined → RED
    const bot = { id: 'joined:n1:rb1', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } }
    const registry = makeRegistry()
    const rt = makeRt(registry, bot)
    // Fire the result asynchronously after send is called
    const origSend = registry.send.bind(registry)
    registry.send = function(nodeId, type, data) {
      const r = origSend(nodeId, type, data)
      if (type === 'bot/update') {
        setImmediate(() => registry.emit('botUpdateResult', { requestId: data.requestId, ok: true, model: 'openai/gpt-4o', effort: null }))
      }
      return r
    }
    const result = await joinedUpdateBot(rt, 'joined:n1:rb1', { model: 'openai/gpt-4o' })
    assert.equal(result.ok, true, 'update must succeed')
    assert.equal(bot.model, 'openai/gpt-4o', 'bot.model must be set')
    assert.equal(bot.appliedModel, 'openai/gpt-4o', 'bot.appliedModel must also be set')
    assert.equal(bot.worker.model, 'openai/gpt-4o', 'bot.worker.model must be set')
  })

  it('P1-sync-null-model: null model result does not overwrite existing model', async () => {
    // Knife: remove null guard in joined-page.js:179 → bot.model becomes null → RED
    const bot = {
      id: 'joined:n1:rb2', origin: 'joined',
      model: 'existing/model', appliedModel: 'existing/model',
      worker: { nodeId: 'n1', remoteBotId: 'rb2', home: 'remote', model: 'existing/model' },
    }
    const registry = makeRegistry()
    const rt = makeRt(registry, bot)
    const origSend = registry.send.bind(registry)
    registry.send = function(nodeId, type, data) {
      const r = origSend(nodeId, type, data)
      if (type === 'bot/update') {
        setImmediate(() => registry.emit('botUpdateResult', { requestId: data.requestId, ok: true, model: null, effort: null }))
      }
      return r
    }
    const result = await joinedUpdateBot(rt, 'joined:n1:rb2', { model: null, effort: null, instructions: 'hi', workDir: null })
    assert.equal(result.ok, true, 'update must succeed')
    assert.equal(bot.model, 'existing/model', 'bot.model must NOT be overwritten with null')
    assert.equal(bot.appliedModel, 'existing/model', 'appliedModel must NOT be overwritten with null')
  })
})

// ── P2: createBotUpdateReceiver model validation ────────────────────────────────

describe('P1b1: createBotUpdateReceiver model validation', () => {
  function makeReceiverRt(catalogModels, llmProviders) {
    return {
      updateBot: async (remoteBotId, patch) => ({ model: patch.model, effort: patch.effort ?? null, instructions: null, workDir: null }),
      ctx: {
        get(key) {
          if (key === 'remote-agent:node-policy') {
            return { models: catalogModels }
          }
          if (key === 'llm') {
            return llmProviders !== undefined ? {
              listProviders: () => llmProviders.map(id => ({ id })),
            } : undefined
          }
          return undefined
        },
      },
    }
  }

  it('P2-validate-known: model in node catalog passes', async () => {
    // Knife: remove knownRefs.has(modelRef) check → all refs pass → RED when unknown also passes
    const rt = makeReceiverRt([{ provider: 'openai', id: 'gpt-4o', ref: 'openai/gpt-4o' }], ['openai'])
    const accept = createBotUpdateReceiver(rt)
    const r = await accept({ remoteBotId: 'rb1', model: 'openai/gpt-4o', effort: null, instructions: null, workDir: null })
    assert.equal(r.ok, true, 'model in catalog must be accepted')
  })

  it('P2-validate-unknown: model not in node catalog is rejected', async () => {
    // Knife: remove bot-update-model-not-on-node return → unknown model passes → RED
    const rt = makeReceiverRt([{ provider: 'openai', id: 'gpt-4o', ref: 'openai/gpt-4o' }], ['openai'])
    const accept = createBotUpdateReceiver(rt)
    const r = await accept({ remoteBotId: 'rb1', model: 'openai/gpt-9000', effort: null, instructions: null, workDir: null })
    assert.equal(r.ok, false, 'unknown model must be rejected')
    assert.match(r.error, /not-on-node/, 'error must mention not-on-node')
  })

  it('P2-validate-empty-catalog: null catalog falls back to llm provider check', async () => {
    // Knife: remove fallback provider check → null catalog always rejects → RED
    const rt = makeReceiverRt(null, ['openai'])
    const accept = createBotUpdateReceiver(rt)
    const r = await accept({ remoteBotId: 'rb1', model: 'openai/gpt-4o', effort: null, instructions: null, workDir: null })
    assert.equal(r.ok, true, 'null catalog must fall back to provider check and pass for known provider')
  })

  it('P2-empty-catalog-unknown-provider: null catalog rejects a provider the node does not have', async () => {
    // Knife: turn `if (knownRefs === null)` into `if (false)` → fallback skipped → accepted → RED
    const rt = makeReceiverRt(null, ['openai'])
    const accept = createBotUpdateReceiver(rt)
    const r = await accept({ remoteBotId: 'rb1', model: 'anthropic/claude-3', effort: null, instructions: null, workDir: null })
    assert.equal(r.ok, false, 'unknown provider must be rejected when catalog is null')
    assert.match(r.error, /model-unknown/, 'error must mention model-unknown')
  })

  it('P2-empty-catalog-no-llm: null catalog with no llm service rejects instead of throwing', async () => {
    // Knife: drop the `!llm || typeof llm.listProviders !== 'function'` guard → TypeError → RED
    const rt = makeReceiverRt(null, undefined)
    const accept = createBotUpdateReceiver(rt)
    const r = await accept({ remoteBotId: 'rb1', model: 'openai/gpt-4o', effort: null, instructions: null, workDir: null })
    assert.equal(r.ok, false, 'no llm fallback must fail closed')
    assert.match(r.error, /model-unknown/, 'error must mention model-unknown')
  })

  it('P2-validate-empty-array: empty array catalog rejects all models', async () => {
    // Knife: treat [] same as null → empty list incorrectly passes all → RED
    // [] means the node reported zero models, so nothing is valid
    const rt = makeReceiverRt([], ['openai'])
    const accept = createBotUpdateReceiver(rt)
    const r = await accept({ remoteBotId: 'rb1', model: 'openai/gpt-4o', effort: null, instructions: null, workDir: null })
    assert.equal(r.ok, false, 'empty catalog must reject all models')
    assert.match(r.error, /not-on-node/, 'must report not-on-node')
  })
})

// ── P3: mapNodeModel efforts passthrough ────────────────────────────────────────

describe('P1b1: mapNodeModel efforts passthrough', () => {
  it('P3-efforts-passthrough: model with efforts gets efforts[] in output', () => {
    // Knife: remove efforts mapping in channel.js mapNodeModel → efforts [] → RED
    const m = { ref: 'openai/gpt-4o', provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }
    const out = mapNodeModel(m)
    assert.equal(out.ref, 'openai/gpt-4o')
    assert.equal(out.efforts.length, 2, 'efforts must be present')
    assert.equal(out.efforts[0].id, 'low')
    assert.equal(out.efforts[1].name, 'High')
  })

  it('P3-no-efforts: model without efforts gets empty array', () => {
    // Knife: remove Array.isArray guard → undefined.map throws → RED
    const m = { ref: 'openai/gpt-4o', provider: 'openai', id: 'gpt-4o', name: 'GPT-4o' }
    const out = mapNodeModel(m)
    assert.deepEqual(out.efforts, [], 'missing efforts must produce empty array')
  })

  it('P3-effort-name-fallback: effort without a name uses its id', () => {
    // Knife: `name: e.name ?? e.id` → `name: e.name` → undefined → RED
    const m = {
      ref: 'openai/gpt-4o', provider: 'openai', id: 'gpt-4o', name: 'GPT-4o',
      efforts: [{ id: 'low' }, { id: 'high', name: 'High' }],
    }
    const out = mapNodeModel(m)
    assert.equal(out.efforts[0].name, 'low', 'effort name must fall back to its id')
    assert.equal(out.efforts[1].name, 'High', 'explicit effort name must be kept')
  })
})

// ── P4: the real bot-create-targets endpoint wiring ────────────────────────────
// Goes through install(rt) and the registered route, so it fails if the endpoint
// stops calling mapNodeModel (e.g. an inline map that drops efforts).

function makeChannelRt(nodes) {
  const registry = { onlineNodes: () => nodes, send: () => true, on() {}, off() {} }
  const state = { revision: 0, bots: {}, rooms: {}, mainBotIds: [] }
  let route = null
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (key) => key === 'remote-agent:registry' ? registry : undefined,
    on: () => () => {},
    effect: (fn) => { fn() },
    set() {},
    tools: { register: () => () => {}, guard: () => () => {}, schemas: () => [] },
    systemPrompt: { section: () => () => {} },
    connection: { fetch: { register(r) { route = r; return () => {} } } },
    llm: { listProviders: () => [] },
  }
  const rt = {
    ctx, state,
    cachedCatalog: () => [], cachedDefault: () => undefined,
    secretsView: () => ({}), archivesView: () => ({}),
    load: async () => {}, bootstrap: async () => {}, loadSecrets: async () => {}, save: async () => {},
    refresh: async () => {}, readOnly: () => undefined,
    noteFailure: () => {},
  }
  installChannel(rt)
  const call = async (endpoint, payload) => (await route.fetch({
    json: async () => ({ endpoint, payload }),
    signal: new AbortController().signal,
  })).json()
  return { rt, call }
}

describe('P1b1: bot-create-targets endpoint maps node models', () => {
  it('P4-endpoint-targets: endpoint returns the mapped models with efforts', async () => {
    // Knife: replace n.models.map(mapNodeModel) with an inline map that drops efforts → RED
    const { call } = makeChannelRt([{
      nodeId: 'node-a',
      hostname: 'machine-a',
      models: [
        { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', efforts: [{ id: 'low', name: 'Low' }] },
        { provider: 'openai', id: 'o3', name: 'o3' },
      ],
      defaultModel: { provider: 'openai', id: 'gpt-4o' },
    }])
    const res = await call('bot-create-targets', {})
    assert.equal(res.ok, true, 'endpoint must succeed: ' + JSON.stringify(res.error))
    assert.equal(res.value.length, 1)
    const node = res.value[0]
    assert.equal(node.nodeId, 'node-a')
    assert.equal(node.models.length, 2, 'both node models must be mapped')
    assert.equal(node.models[0].ref, 'openai/gpt-4o', 'ref must be built by the mapper')
    assert.deepEqual(node.models[0].efforts, [{ id: 'low', name: 'Low' }], 'efforts must survive the endpoint')
    assert.deepEqual(node.models[1].efforts, [], 'model without efforts must get []')
    assert.equal(node.configStale, false, 'a node with no sync state is not stale')
    assert.equal(node.appliedRevision, null, 'no applied revision yet')
  })

  it('P4-endpoint-sync: the entry reports the config state the push loop tracks', async () => {
    // Knife: drop configStale/appliedRevision from the map → both assertions below go red.
    const { rt, call } = makeChannelRt([{ nodeId: 'node-a', hostname: 'machine-a', models: [], defaultModel: null }])
    rt.configSyncStatus = nodeId => (nodeId === 'node-a' ? { configStale: true, appliedRevision: 7, lastError: 'push-failed' } : undefined)
    const res = await call('bot-create-targets', {})
    assert.equal(res.ok, true)
    assert.equal(res.value[0].configStale, true, 'a stale node is reported as stale')
    assert.equal(res.value[0].appliedRevision, 7, 'the revision the node acknowledged is passed through')
  })
})
