// A Bot the main manages fails a turn on a model or a key the main chose. DSH names the
// route (NO_ADAPTER / MISSING_CREDENTIAL); the repair card must speak the main's codes, and
// it must come from a real failed turn, which is what these tests drive. The prompt keeps
// exactly one refusal of its own: the thinking level DSH would silently drop.
import test from 'node:test'
import assert from 'node:assert/strict'
import { install as installModels } from '../src/host/models.js'
import { install as installTurns } from '../src/host/turns.js'

const PROVIDERS = {
  deepseek: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro' }],
  ollama: [{ id: 'kimi-k3' }],
}

function world({ missing = [], providers = PROVIDERS } = {}) {
  let listener
  const prompts = []
  const failures = []
  const ctx = {
    llm: {
      listProviders: () => Object.keys(providers).map(id => ({ id })),
      listModels: async id => providers[id],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }),
    },
    get: () => undefined,
    on: (name, fn) => { if (name === 'session/event') listener = fn },
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    sessionController: { prompt: async (request) => { prompts.push(request); return 'ran' } },
  }
  const rt = {
    ctx,
    state: { bots: {}, exchangeTurns: {}, questions: {} },
    warn: () => {},
    save: async () => {},
    missingKeys: async () => new Set(missing),
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map(),
    botOf: id => rt.state.bots[id],
    selfOf: id => id,
    deliver: async () => {},
    noteFailure: entry => failures.push(entry),
    switchJobs: () => [],
    userWrote: () => {},
  }
  installModels(rt)
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data, session = { id }) => listener({ ...session, id }, { type, seq: ++seq, data })
  return { rt, prompts, failures, emit }
}

async function failTurn({ rt, emit }, id, code, message = 'route failed') {
  // A failed turn must not list the catalog to know which card to show.
  emit(id, 'turn/start', { turn: 1 })
  emit(id, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code, message } } })
}

test('a managed Bot whose main dropped the model records and blocks E_BOT_MODEL_UNAVAILABLE', async () => {
  const w = world()
  w.rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'gone/model', managedBy: 'hub' }
  await failTurn(w, 'b1', 'NO_ADAPTER')
  assert.equal(w.rt.state.bots.b1.blocked?.code, 'E_BOT_MODEL_UNAVAILABLE', 'the repair card reads this code')
  assert.equal(w.failures.length, 1)
  assert.equal(w.failures[0].code, 'E_BOT_MODEL_UNAVAILABLE', 'the diagnostics record the code the card shows')
})

test('a provider whose key the main lost maps MISSING_CREDENTIAL to E_BOT_MODEL_NO_KEY', async () => {
  const w = world({ missing: ['deepseek'] })
  w.rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'deepseek/deepseek-v4-pro', managedBy: 'hub' }
  await failTurn(w, 'b1', 'MISSING_CREDENTIAL', 'no API key for provider deepseek')
  assert.equal(w.rt.state.bots.b1.blocked?.code, 'E_BOT_MODEL_NO_KEY')
})

test('a failure already coded E_BOT_MODEL_NO_KEY is never replaced', async () => {
  const w = world()
  w.rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'deepseek/deepseek-v4-pro', managedBy: 'hub' }
  await failTurn(w, 'b1', 'E_BOT_MODEL_NO_KEY', 'the main has no key')
  assert.equal(w.rt.state.bots.b1.blocked?.code, 'E_BOT_MODEL_NO_KEY')
})

test('with a cold catalog both route codes still map, and no failed turn lists it', async () => {
  const w = world()
  assert.equal(w.rt.cachedCatalog().length, 0, 'nothing has listed the catalog in this process')
  w.rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'gone/model', managedBy: 'hub' }
  w.rt.state.bots.b2 = { id: 'b2', name: 'Keyless Bot', model: 'deepseek/deepseek-v4-pro', managedBy: 'hub' }
  await failTurn(w, 'b1', 'NO_ADAPTER')
  await failTurn(w, 'b2', 'MISSING_CREDENTIAL', 'no API key for provider deepseek')
  assert.equal(w.rt.state.bots.b1.blocked?.code, 'E_BOT_MODEL_UNAVAILABLE')
  assert.equal(w.rt.state.bots.b2.blocked?.code, 'E_BOT_MODEL_NO_KEY')
  assert.equal(w.rt.cachedCatalog().length, 0, 'the failed turns never listed the catalog')
})

test('a Bot the main put on a local agent keeps the route code', async () => {
  const w = world()
  w.rt.isLocalAgentRef = ref => typeof ref === 'string' && ref.startsWith('local-codex-cli/')
  w.rt.state.bots.b1 = { id: 'b1', name: 'Local Agent Bot', model: 'local-codex-cli/gpt-5', managedBy: 'hub' }
  await failTurn(w, 'b1', 'NO_ADAPTER')
  assert.equal(w.rt.state.bots.b1.blocked, undefined, 'a local agent route is not the main model card')
  assert.equal(w.failures[0].code, 'NO_ADAPTER')
})

test('a Bot made on this machine keeps the route code and gets no managed card', async () => {
  const w = world()
  w.rt.state.bots.b1 = { id: 'b1', name: 'Local Bot', model: 'gone/model' }
  await failTurn(w, 'b1', 'NO_ADAPTER')
  assert.equal(w.rt.state.bots.b1.blocked, undefined, 'NO_ADAPTER is not a blocking code')
  assert.equal(w.failures[0].code, 'NO_ADAPTER', 'the local Bot is not mapped')
})

test('the prompt refuses only a thinking level the model does not serve, as a structured error', async () => {
  const w = world()
  w.rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'deepseek/deepseek-v4-pro', effort: 'max', managedBy: 'hub' }
  await assert.rejects(w.rt.ctx.sessionController.prompt({ sessionId: 'b1' }), error => {
    assert.equal(error.code, 'E_BOT_EFFORT_UNAVAILABLE')
    assert.equal(error.isDSHRemoteError, true, 'the gateway passes a remote error through instead of gateway/internal')
    return true
  })
  assert.equal(w.prompts.length, 0, 'the model call never ran')
})

test('a model the main dropped no longer stops the prompt: the turn itself fails', async () => {
  const w = world()
  w.rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'gone/model', managedBy: 'hub' }
  assert.equal(await w.rt.ctx.sessionController.prompt({ sessionId: 'b1' }), 'ran')
  assert.equal(w.prompts.length, 1)
})

// §49's other half: a route that resolves models but refuses every generation reports
// HOSTED_ENGINE_ROUTE. The main's Bot must show the same "model unavailable" card, and the
// route must still be marked from the raw code — the card's mapped code no longer names it.
test('a managed Bot on a route that is not a model endpoint shows the main\'s code and marks the route', async () => {
  const w = world({ providers: { ...PROVIDERS, m3probe: [{ id: 'ling-mini' }] } })
  w.rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'm3probe/ling-mini', managedBy: 'hub' }
  const session = { id: 'b1', requestHeader: () => ({ config: { provider: 'm3probe', model: 'ling-mini' } }) }
  const refused = []
  const real = w.rt.routeRefused
  let refusal
  w.rt.routeRefused = async (ref, bot) => { refused.push(ref); refusal = real(ref, bot); return refusal }
  w.emit('b1', 'turn/start', { turn: 1 }, session)
  w.emit('b1', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'HOSTED_ENGINE_ROUTE', message: 'not a model endpoint' } } }, session)
  assert.equal(w.rt.state.bots.b1.blocked?.code, 'E_BOT_MODEL_UNAVAILABLE', 'the card speaks the main\'s code')
  assert.equal(w.failures[0].code, 'E_BOT_MODEL_UNAVAILABLE')
  assert.deepEqual(refused, ['m3probe/ling-mini'], 'the raw code still triggers the route refusal')
  // The refusal itself runs after the turn returned by design: wait for it, so the model
  // assertion below cannot pass just because the rewrite had not happened yet.
  await refusal
  assert.equal(w.rt.state.bots.b1.model, 'm3probe/ling-mini', 'the main still owns the model it chose')
  assert.equal((await w.rt.catalog({ fresh: true })).some(entry => entry.ref === 'm3probe/ling-mini'), false, 'the route stays out of the catalog')
  // The route is marked, not rewritten: a later turn that falls through to NO_ADAPTER
  // still shows the main's card, and the route is refused only once.
  w.emit('b1', 'turn/start', { turn: 2 }, session)
  w.emit('b1', 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: 'no adapter for route m3probe/ling-mini' } } }, session)
  assert.equal(w.failures[1].code, 'E_BOT_MODEL_UNAVAILABLE')
  assert.deepEqual(refused, ['m3probe/ling-mini'])
})
