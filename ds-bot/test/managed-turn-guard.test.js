// A Bot the main manages is stopped at the prompt when the model or level the main chose is
// no longer served here. The check is the real one in turns.js, installed together with the
// real models module; the session controller is a fake that records what reached it.
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
    noteFailure: () => {},
    switchJobs: () => [],
    userWrote: () => {},
  }
  installModels(rt)
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { rt, prompts, emit }
}

const rejectsWith = (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.code, code)
  return true
})

test('a managed Bot whose model left the catalog is stopped before any model call', async () => {
  const { rt, prompts, emit } = world()
  rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'gone/model', managedBy: 'hub' }
  await rejectsWith(rt.ctx.sessionController.prompt({ sessionId: 'b1' }), 'E_BOT_MODEL_UNAVAILABLE')
  assert.equal(prompts.length, 0, 'the model call never ran')
  emit('b1', 'turn/start', { turn: 1 })
  emit('b1', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_BOT_MODEL_UNAVAILABLE', message: 'gone' } } })
  assert.equal(rt.state.bots.b1.blocked?.code, 'E_BOT_MODEL_UNAVAILABLE', 'the repair card reads this code, and turn-error.js gives it the "did not fall back" line')
})

test('a provider that lost its key stops a managed Bot with E_BOT_MODEL_NO_KEY, not the local key card', async () => {
  const { rt, prompts } = world({ missing: ['deepseek'] })
  rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'deepseek/deepseek-v4-pro', managedBy: 'hub' }
  await rejectsWith(rt.ctx.sessionController.prompt({ sessionId: 'b1' }), 'E_BOT_MODEL_NO_KEY')
  assert.equal(prompts.length, 0)
})

test('a thinking level the model does not serve stops a managed Bot with E_BOT_EFFORT_UNAVAILABLE', async () => {
  const { rt, prompts } = world()
  rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'deepseek/deepseek-v4-pro', effort: 'max', managedBy: 'hub' }
  await rejectsWith(rt.ctx.sessionController.prompt({ sessionId: 'b1' }), 'E_BOT_EFFORT_UNAVAILABLE')
  assert.equal(prompts.length, 0)
})

test('the check runs for a Thread and a group Session too, wherever the session resolves to the Bot', async () => {
  const { rt, prompts } = world()
  rt.state.bots.b1 = { id: 'b1', name: 'Node Bot', model: 'gone/model', managedBy: 'hub' }
  rt.selfOf = id => (id.startsWith('group-') || id.startsWith('thread-') ? 'b1' : id)
  for (const sessionId of ['b1', 'thread-b1', 'group-ops']) {
    await rejectsWith(rt.ctx.sessionController.prompt({ sessionId }), 'E_BOT_MODEL_UNAVAILABLE')
  }
  assert.equal(prompts.length, 0)
})

test('a Bot made on this machine keeps its old fallback and still runs', async () => {
  const { rt, prompts } = world({ missing: ['deepseek'] })
  rt.state.bots.local = { id: 'local', name: 'Local', model: 'gone/model', appliedModel: 'ollama/kimi-k3' }
  assert.equal(await rt.ctx.sessionController.prompt({ sessionId: 'local' }), 'ran')
  assert.equal(prompts.length, 1, 'a local Bot is not refused')
})
