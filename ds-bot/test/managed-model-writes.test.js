// A Bot the main manages runs the model the main chose. Its own machine must not change
// that model or its thinking level — a local write would silently diverge from the row the
// main shows (verifier §49: the node row kept `model=m3probe/…` while its applied model was
// something else). The hub's own update is the one caller allowed through, and the refusal
// must keep the Bot's blocked state, which belongs to the old model's failure.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const BLOCKED = { code: 'AUTH', provider: 'm3probe' }
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    m9: { id: 'm9', sessionId: 'm9', name: 'Node Bot', role: 'Node', model: 'm3probe/ling-mini', managedBy: 'hub', blocked: BLOCKED, instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start(team = TEAM) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-managed-writes-'))
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'm3probe', name: 'M3 probe' }],
      listModels: async (id) => (id === 'm3probe' ? [{ id: 'ling-mini' }] : [{ id: 'v4' }]),
      resolveModelInfo: async (provider, model) => (provider === 'deepseek'
        ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
        : undefined),
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 }, followup: () => {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  createRuntime(ctx, { home })
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name)?.execute
    ? ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
    : undefined
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, state, stop, home }
}

test('a local model change on a managed Bot is refused and keeps its blocked state', async (t) => {
  const { call, state, stop } = start()
  t.after(stop)
  const result = await call('update-bot', { id: 'm9', model: 'deepseek/v4' })
  assert.equal(result.ok, false, 'the local write is refused')
  assert.equal(result.error.code, 'bot/managed-model', 'with a code the client can name')
  const bot = state().bots.m9
  assert.equal(bot.model, 'm3probe/ling-mini', 'the model the main chose is unchanged')
  assert.deepEqual(bot.blocked, BLOCKED, 'the refusal does not clear what blocked the Bot')
})

test('a local thinking-level change on a managed Bot is refused too', async (t) => {
  const { call, state, stop } = start()
  t.after(stop)
  const result = await call('update-bot', { id: 'm9', effort: 'high' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/managed-model')
  assert.equal(state().bots.m9.effort, undefined)
})

test('the hub\'s own update still changes a managed Bot\'s model and level', async (t) => {
  const { ctx, state, stop } = start()
  t.after(stop)
  const accept = ctx.get('remote-agent:bot-update')
  assert.equal(typeof accept, 'function', 'the node receiver is installed')
  const result = await accept({ remoteBotId: 'm9', model: 'deepseek/v4', effort: 'high', instructions: null, workDir: null })
  assert.equal(result.ok, true, result.error)
  const bot = state().bots.m9
  assert.equal(bot.model, 'deepseek/v4', 'the main may still set the model')
  assert.equal(bot.effort, 'high')
  assert.equal(bot.blocked, undefined, 'a new model is not the old model\'s failure')
})

test('a managed Bot still changes its own name and instructions', async (t) => {
  const { call, state, stop } = start()
  t.after(stop)
  const result = await call('update-bot', { id: 'm9', name: 'Node Two', instructions: 'Answer on the node' })
  assert.equal(result.ok, true)
  const bot = state().bots.m9
  assert.equal(bot.name, 'Node Two')
  assert.equal(bot.instructions, 'Answer on the node')
})
