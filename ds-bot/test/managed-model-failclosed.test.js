// A Bot the main created runs the model and thinking level the main chose, or stops with a
// code the repair card shows. It never silently falls back; a Bot made on the node itself
// still does, so single-machine use is unchanged. The node receiver is exercised through its
// real entry point (createBotCreateReceiver), not by calling desiredModel alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../src/host/models.js'
import { createBotCreateReceiver } from '../src/host/joined-create.js'

const PROVIDERS = {
  deepseek: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro' }],
  ollama: [{ id: 'kimi-k3' }],
}

function world({ missing = [], efforts = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } = {}) {
  const ctx = {
    llm: {
      listProviders: () => Object.keys(PROVIDERS).map(id => ({ id })),
      listModels: async id => PROVIDERS[id],
      resolveModelInfo: async () => (efforts === undefined ? undefined : { reasoning: { efforts, defaultEffort: 'low' } }),
    },
    get: () => undefined,
  }
  const rt = { ctx, state: { bots: {} }, warn: () => {}, missingKeys: async () => new Set(missing) }
  install(rt)
  return rt
}

const rejectsWith = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code)
  return true
})

test('A7 a managed Bot whose model is gone fails closed instead of running another model', async () => {
  const rt = world()
  await rejectsWith(rt.desiredModel({ model: 'gone/model', managedBy: 'hub' }), 'E_BOT_MODEL_UNAVAILABLE')
  assert.equal(await rt.desiredModel({ model: 'deepseek/deepseek-v4-pro', managedBy: 'hub' }), 'deepseek/deepseek-v4-pro')
})

test('A7b a managed Bot whose provider lost its key fails with E_BOT_MODEL_NO_KEY', async () => {
  const rt = world({ missing: ['deepseek'] })
  await rejectsWith(rt.desiredModel({ model: 'deepseek/deepseek-v4-pro', managedBy: 'hub' }), 'E_BOT_MODEL_NO_KEY')
  assert.equal(await rt.desiredModel({ model: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro', 'a local Bot keeps its own model')
})

test('A8 a managed Bot whose thinking level is not served fails instead of running the default level', async () => {
  const rt = world()
  await rejectsWith(rt.desiredEffort({ model: 'deepseek/deepseek-v4-pro', effort: 'max', managedBy: 'hub' }, 'deepseek/deepseek-v4-pro'), 'E_BOT_EFFORT_UNAVAILABLE')
  assert.equal(await rt.desiredEffort({ model: 'deepseek/deepseek-v4-pro', effort: 'low', managedBy: 'hub' }, 'deepseek/deepseek-v4-pro'), 'low')
})

test('A9 a Bot made on the node itself keeps the old fallback', async () => {
  const rt = world({ missing: ['deepseek'] })
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'ollama/kimi-k3' }), 'ollama/kimi-k3', 'falls back to the last model it ran on')
  assert.equal(await rt.desiredModel({ model: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro', 'its own model stays its own')
  assert.equal(await rt.desiredEffort({ model: 'deepseek/deepseek-v4-pro', effort: 'max' }, 'deepseek/deepseek-v4-pro'), undefined, 'an unknown level is ignored, not fatal')
})

test('A7c a managed Bot whose route cannot be applied is blocked, and the card lifts when it can', async () => {
  const rt = world()
  const saves = []
  Object.assign(rt, {
    state: { bots: {}, threads: {} },
    save: async () => { saves.push(1) },
    chatOf: () => 'session-1',
    groupSessionsOf: () => [],
  })
  rt.ctx.sessionController = { selectModel: async () => ({ selected: { provider: 'deepseek', model: 'deepseek-v4-pro' } }) }
  const bot = { id: 'b1', name: 'Node Bot', model: 'gone/model', managedBy: 'hub' }
  await rejectsWith(rt.applyModel(bot), 'E_BOT_MODEL_UNAVAILABLE')
  assert.deepEqual({ code: bot.blocked?.code }, { code: 'E_BOT_MODEL_UNAVAILABLE' }, 'the repair card reads this code')
  assert.equal(saves.length, 1, 'the block is on disk')
  bot.model = 'deepseek/deepseek-v4-pro'
  await rt.applyModel(bot)
  assert.equal(bot.blocked, undefined, 'the block lifts once the route applies')
})

test('A8b a managed Bot with no chosen thinking level applies its model without one', async () => {
  const rt = world()
  const routes = []
  Object.assign(rt, {
    state: { bots: {}, threads: {} },
    save: async () => {},
    chatOf: () => 'session-1',
    groupSessionsOf: () => [],
  })
  rt.ctx.sessionController = {
    selectModel: async ({ sessionId, provider, model, reasoningEffort }) => {
      routes.push({ sessionId, provider, model, reasoningEffort })
      return { selected: { provider, model } }
    },
  }
  const bot = { id: 'b1', name: 'Node Bot', model: 'deepseek/deepseek-v4-pro', effort: null, managedBy: 'hub' }
  rt.state.bots = { b1: bot }
  assert.equal(await rt.desiredEffort(bot, bot.model), undefined, 'null means no level was chosen')
  assert.equal(await rt.applyModel(bot), 'deepseek/deepseek-v4-pro')
  assert.equal(bot.blocked, undefined, 'nothing is blocked for a level nobody chose')
  assert.deepEqual(routes, [{ sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: undefined }], 'the route carries no level')
  assert.equal(bot.appliedEffort, undefined)
})

test('A8c a managed Bot still fails on a level its model does not serve', async () => {
  const rt = world()
  Object.assign(rt, { state: { bots: {}, threads: {} }, save: async () => {}, chatOf: () => 'session-1', groupSessionsOf: () => [] })
  rt.ctx.sessionController = { selectModel: async () => ({}) }
  const bot = { id: 'b1', name: 'Node Bot', model: 'deepseek/deepseek-v4-pro', effort: 'max', managedBy: 'hub' }
  rt.state.bots = { b1: bot }
  await rejectsWith(rt.applyModel(bot), 'E_BOT_EFFORT_UNAVAILABLE')
  assert.equal(bot.blocked?.code, 'E_BOT_EFFORT_UNAVAILABLE', 'a chosen level that is not served is still fatal')
  assert.equal(bot.appliedModel, undefined)
})

// ── A10: the node receiver ───────────────────────────────────────────────────
function receiverWorld({ missing = [], models = ['deepseek'] } = {}) {
  const created = []
  const bots = []
  const saves = []
  const rt = {
    ctx: { get: () => undefined, llm: { listProviders: () => models.map(id => ({ id })) } },
    missingKeys: async () => new Set(missing),
    createBot: async (options) => {
      created.push(options)
      const bot = { id: `node-bot-${bots.length + 1}`, name: options.name, role: options.role }
      bots.push(bot)
      return bot
    },
    save: async () => { saves.push(Date.now()) },
  }
  return { rt, accept: createBotCreateReceiver(rt), created, bots, saves }
}

test('A10 a Bot created for an unkeyed provider is refused with bot-create-model-no-key', async () => {
  const { accept, created } = receiverWorld({ missing: ['deepseek'] })
  const result = await accept({ name: 'Node Bot', modelRef: 'deepseek/deepseek-v4-pro', managedBy: 'hub', defaultEffort: 'high' })
  assert.deepEqual(result, { ok: false, error: 'bot-create-model-no-key' })
  assert.equal(created.length, 0, 'nothing is created for a model that cannot answer')
})

test('A10b a hub-created Bot records managedBy and uses defaultEffort when no effort was named', async () => {
  const { accept, created, bots, saves } = receiverWorld()
  const result = await accept({ name: 'Node Bot', modelRef: 'deepseek/deepseek-v4-pro', managedBy: 'hub', defaultEffort: 'high' })
  assert.equal(result.ok, true)
  assert.equal(created[0].effort, 'high', 'the hub default becomes the Bot effort')
  assert.equal(created[0].model, 'deepseek/deepseek-v4-pro')
  assert.equal(bots[0].managedBy, 'hub', 'the row says the main owns its model')
  assert.equal(saves.length, 1, 'the managed marker is saved with the row')
})

// An older remote-agent validates bot/create with a fixed field list and drops the
// ownership marker before the node's receiver sees it (0.10.1-fork.74 does exactly
// that). The receiver is the node end of the hub's create only, so a frame without
// the marker is still the main's Bot: losing the marker silently restores the local
// fallback that the marker exists to prevent.
test('A10d a bot/create that arrives without the ownership marker still records managedBy', async () => {
  const { accept, bots, saves } = receiverWorld()
  const result = await accept({ name: 'Old Protocol Bot', modelRef: 'deepseek/deepseek-v4-pro', effort: null, workDir: null })
  assert.equal(result.ok, true)
  assert.equal(bots[0].managedBy, 'hub', 'a hub-created Bot never loses the marker to an older frame')
  assert.ok(saves.length >= 1, 'the marker is saved with the row')
})

test('A10c an explicit effort wins over the hub default, and a create marked null stays unmanaged', async () => {
  const { accept, created, bots } = receiverWorld()
  await accept({ name: 'Node Bot', modelRef: 'deepseek/deepseek-v4-pro', effort: 'low', managedBy: 'hub', defaultEffort: 'high' })
  await accept({ name: 'Local Bot', modelRef: 'deepseek/deepseek-v4-pro', defaultEffort: 'high', managedBy: null })
  assert.equal(created[0].effort, 'low')
  assert.equal(created[1].effort, 'high')
  assert.equal(bots[0].managedBy, 'hub')
  assert.equal(bots[1].managedBy, undefined, 'an explicit null is the only way to say "not the main\'s"')
})
