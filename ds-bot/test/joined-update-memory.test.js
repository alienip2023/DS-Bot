// §61 A: changing a joined Bot's memory backend must reach the node, not just the
// shadow row. The hub sends `bot/update` with memoryConfig, then writes back whatever
// the node reports it applied; an old node gets the rest of the patch without it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { joinedUpdateBot, createBotUpdateReceiver } from '../src/host/joined-page.js'

function fakeRegistry({ caps = ['bot-memory-update/1'], answer } = {}) {
  const listeners = new Map()
  const sent = []
  const on = (name, fn) => {
    const set = listeners.get(name) ?? new Set()
    set.add(fn)
    listeners.set(name, set)
  }
  const off = (name, fn) => { listeners.get(name)?.delete(fn) }
  const emit = (name, payload) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload) }
  const send = (nodeId, type, data) => {
    sent.push({ nodeId, type, data })
    if (type === 'bot/update') {
      const applied = answer ? answer(data) : data.memoryConfig ?? null
      setTimeout(() => emit('botUpdateResult', {
        requestId: data.requestId, ok: true,
        model: data.model ?? null, effort: data.effort ?? null,
        instructions: data.instructions ?? null, workDir: data.workDir ?? null,
        memoryConfig: applied,
      }), 0)
    }
    return true
  }
  return { sent, on, off, send, onlineNodes: () => [{ nodeId: 'n1', hello: { caps } }] }
}

function runtime({ registry = fakeRegistry(), memoryConfig = { backend: 'federation' } } = {}) {
  const bot = {
    id: 'b1', name: 'Scout', origin: 'joined',
    worker: { nodeId: 'n1', home: 'remote', remoteBotId: 'rb1' },
    memoryConfig,
  }
  let saves = 0
  const rt = {
    ctx: { get: name => (name === 'remote-agent:registry' ? registry : undefined) },
    botUpdateTimeoutMs: 200,
    save: async () => { saves += 1 },
    botOf(id) { return id === bot.id ? bot : undefined },
  }
  return { rt, registry, bot, saves: () => saves }
}

test('bot/update carries the new backend and the shadow row follows the node', async () => {
  const { rt, registry, bot, saves } = runtime()
  const result = await joinedUpdateBot(rt, 'b1', { memoryConfig: { backend: 'file' } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.memoryConfig, { backend: 'file' })
  assert.equal(registry.sent.length, 1)
  assert.equal(registry.sent[0].type, 'bot/update')
  assert.deepEqual(registry.sent[0].data.memoryConfig, { backend: 'file' })
  assert.deepEqual(bot.memoryConfig, { backend: 'file' })
  assert.equal(saves(), 1)
})

test('switching back to federation sends the backend again', async () => {
  const { rt, registry, bot } = runtime({ memoryConfig: { backend: 'file' } })
  const result = await joinedUpdateBot(rt, 'b1', { memoryConfig: { backend: 'federation' } })
  assert.equal(result.ok, true)
  assert.deepEqual(registry.sent[0].data.memoryConfig, { backend: 'federation' })
  assert.deepEqual(bot.memoryConfig, { backend: 'federation' })
})

test('an unknown backend is refused before any frame is sent', async () => {
  const { rt, registry, bot } = runtime()
  const result = await joinedUpdateBot(rt, 'b1', { memoryConfig: { backend: 'sqlite' } })
  assert.deepEqual(result, { ok: false, error: 'bot-update-memory-invalid' })
  assert.equal(registry.sent.length, 0)
  assert.deepEqual(bot.memoryConfig, { backend: 'federation' })
})

test('an old node gets the rest of the patch but not the backend', async () => {
  const { rt, registry, bot } = runtime({ registry: fakeRegistry({ caps: [] }) })
  const result = await joinedUpdateBot(rt, 'b1', {
    model: 'p/m1',
    memoryConfig: { backend: 'file' },
  })
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(registry.sent[0].data, 'memoryConfig'), false)
  assert.equal(registry.sent[0].data.model, 'p/m1')
  // The node was never asked to change it, so the shadow row must not pretend it did.
  assert.deepEqual(bot.memoryConfig, { backend: 'federation' })
  assert.equal(Object.hasOwn(result, 'memoryConfig'), false)
})

test('asking only for a backend on an old node fails fast instead of waiting', async () => {
  const { rt, registry } = runtime({ registry: fakeRegistry({ caps: [] }) })
  const result = await joinedUpdateBot(rt, 'b1', { memoryConfig: { backend: 'file' } })
  assert.deepEqual(result, { ok: false, error: 'bot-update-memory-unsupported' })
  assert.equal(registry.sent.length, 0)
})

test('the shadow row uses the backend the node actually applied', async () => {
  const { rt, bot } = runtime({
    registry: fakeRegistry({ answer: () => ({ backend: 'none' }) }),
  })
  const result = await joinedUpdateBot(rt, 'b1', { memoryConfig: { backend: 'file' } })
  assert.equal(result.ok, true)
  assert.deepEqual(bot.memoryConfig, { backend: 'none' })
  assert.deepEqual(result.memoryConfig, { backend: 'none' })
})

function receiverRuntime() {
  const calls = []
  const rt = {
    ctx: { get: () => undefined },
    updateBot: async (id, patch) => {
      calls.push({ id, patch })
      return { id, name: 'Scout', ...patch, memoryConfig: patch.memoryConfig ?? { backend: 'federation' } }
    },
  }
  return { rt, calls, accept: createBotUpdateReceiver(rt) }
}

test('the node receiver applies memoryConfig through the roster', async () => {
  const { rt, calls, accept } = receiverRuntime()
  rt.updateBot = async (id, patch) => {
    calls.push({ id, patch })
    return { id, name: 'Scout', memoryConfig: patch.memoryConfig ?? { backend: 'federation' } }
  }
  const result = await accept({ remoteBotId: 'rb1', model: null, effort: null, instructions: null, workDir: null, memoryConfig: { backend: 'file' } })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].patch, { memoryConfig: { backend: 'file' } })
  assert.deepEqual(result.memoryConfig, { backend: 'file' })
})

test('the node receiver refuses a malformed memoryConfig', async () => {
  const { rt, calls, accept } = receiverRuntime()
  for (const memoryConfig of [['file'], { backend: 7 }, { backend: '  ' }, 'file']) {
    const result = await accept({ remoteBotId: 'rb1', memoryConfig })
    assert.equal(result.ok, false, String(memoryConfig))
    assert.equal(result.error, 'bot-update-memoryConfig-invalid')
  }
  assert.equal(calls.length, 0, 'the roster must not see a malformed backend')
})

test('a frame without memoryConfig leaves the backend alone and reports the current one', async () => {
  const { calls, accept } = receiverRuntime()
  const result = await accept({ remoteBotId: 'rb1', instructions: 'be brief' })
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(calls[0].patch, 'memoryConfig'), false)
  assert.deepEqual(result.memoryConfig, { backend: 'federation' })
})
