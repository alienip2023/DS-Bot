// P1 DS 侧 applyModelSync 测试：hub 下发 MODEL_SYNC 帧，bot.model/effort 更新并触发 applyModel
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function seed(opts = {}) {
  return {
    version: 2,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', sessionId: 'sa', managedBy: 'hub', model: 'openai/gpt-4o', createdAt: 1 },
      b: { id: 'b', name: 'Worker', sessionId: 'sb', managedBy: 'hub', model: 'openai/gpt-4o', createdAt: 2 },
      c: { id: 'c', name: 'Local', sessionId: 'sc', createdAt: 3 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
    ...opts,
  }
}

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-model-sync-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  t.after(async () => {
    await ctx.dispose?.()
    rmSync(home, { recursive: true, force: true })
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  return rt
}

test('applyModelSync scope=all: 只更新 managedBy=hub 的 bot', { timeout: 5000 }, async (t) => {
  const rt = await start(t)
  // Stub applyModel to track calls without real DSH session
  const applied = []
  const origApply = rt.applyModel
  rt.applyModel = async (bot, opts) => { applied.push({ id: bot.id, model: bot.model, effort: bot.effort }); return bot.model }

  const result = await rt.applyModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'all', modelRef: 'deepseek/deepseek-chat' })

  assert.ok(Array.isArray(result), 'returns array')
  // Bot a and b have managedBy=hub, bot c does not
  const ids = new Set(result)
  assert.ok(ids.has('a'), 'hub-managed bot a updated')
  assert.ok(ids.has('b'), 'hub-managed bot b updated')
  assert.ok(!ids.has('c'), 'local bot c not touched')
  assert.equal(rt.state.bots.a.model, 'deepseek/deepseek-chat')
  assert.equal(rt.state.bots.b.model, 'deepseek/deepseek-chat')
  assert.equal(rt.state.bots.c.model, undefined, 'local bot model unchanged')
  rt.applyModel = origApply
})

test('applyModelSync scope=bot: 只更新指定 botId', { timeout: 5000 }, async (t) => {
  const rt = await start(t)
  rt.applyModel = async (bot) => bot.model

  const result = await rt.applyModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'bot', modelRef: 'anthropic/claude-3-5-sonnet', botId: 'a' })

  assert.deepEqual(result, ['a'])
  assert.equal(rt.state.bots.a.model, 'anthropic/claude-3-5-sonnet')
  assert.equal(rt.state.bots.b.model, 'openai/gpt-4o', 'bot b untouched')
})

test('applyModelSync scope=all: effort 字段随 ref 一起更新', { timeout: 5000 }, async (t) => {
  const rt = await start(t)
  rt.applyModel = async (bot) => bot.model

  await rt.applyModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'all', modelRef: 'openai/gpt-4o', effort: 'high' })

  assert.equal(rt.state.bots.a.effort, 'high')
  assert.equal(rt.state.bots.b.effort, 'high')
})

test('applyModelSync scope=all: effort 缺席时清除旧 effort', { timeout: 5000 }, async (t) => {
  const rt = await start(t)
  rt.state.bots.a.effort = 'high'
  rt.applyModel = async (bot) => bot.model

  await rt.applyModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'all', modelRef: 'openai/gpt-4o' })

  assert.equal(rt.state.bots.a.effort, undefined, 'effort cleared when not in sync frame')
})

test('applyModelSync scope=all: applyModel 失败时回滚并继续其他 bot', { timeout: 5000 }, async (t) => {
  const rt = await start(t)
  let call = 0
  rt.applyModel = async (bot) => {
    call++
    if (bot.id === 'a') throw new Error('DSH session error')
    return bot.model
  }

  const result = await rt.applyModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'all', modelRef: 'deepseek/deepseek-chat' })

  // Bot a failed → rolled back to old model, not in result
  assert.ok(!result.includes('a'), 'failed bot not in applied list')
  assert.ok(result.includes('b'), 'successful bot in applied list')
  assert.equal(rt.state.bots.a.model, 'openai/gpt-4o', 'bot a rolled back')
  assert.equal(rt.state.bots.b.model, 'deepseek/deepseek-chat')
})

test('applyModelSync scope=default is refused: Bots never follow the DSH default model', { timeout: 5000 }, async (t) => {
  const rt = await start(t)
  let selected = false
  rt.ctx.provide?.('agentDefaultModel', { select: async () => { selected = true } })
  const result = await rt.applyModelSync({ nodeId: 'n1', requestId: 'r1', scope: 'default', modelRef: 'openai/gpt-4o' })
  assert.deepEqual(result, [])
  assert.equal(selected, false, 'the DSH default model is left alone')
})
