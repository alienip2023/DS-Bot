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

function world({ missing = [] } = {}) {
  let listener
  const prompts = []
  const failures = []
  const ctx = {
    llm: {
      listProviders: () => Object.keys(PROVIDERS).map(id => ({ id })),
      listModels: async id => PROVIDERS[id],
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
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { rt, prompts, failures, emit }
}

async function failTurn({ rt, emit }, id, code, message = 'route failed') {
  // The mapping reads the catalog as last listed; a cold cache changes no card.
  await rt.catalog()
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
