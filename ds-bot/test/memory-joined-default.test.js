// A Bot created on a node keeps its memory with the hub by default: `federation` is what
// a new joined Bot starts with, and an explicit backend is still the way to opt out.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotOnNode, createBotCreateReceiver } from '../src/host/joined-create.js'
import { shadowId } from '../src/host/roster-join.js'

function fakeRegistry() {
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
    if (type === 'bot/create') {
      setTimeout(() => emit('botCreateResult', { requestId: data.requestId, ok: true, remoteBotId: 'rb1', name: data.name }), 0)
    }
    return true
  }
  return { sent, on, off, send, onlineNodes: () => [{ nodeId: 'n1', models: null }] }
}

function runtime({ state = {} } = {}) {
  const registry = fakeRegistry()
  const rt = {
    state,
    ctx: { get: name => (name === 'remote-agent:registry' ? registry : undefined) },
    botCreateTimeoutMs: 200,
    save: async () => {},
    botOf(id) { return this.state.bots?.[id] },
  }
  return { rt, registry }
}

const create = (rt, extra = {}) => createBotOnNode(rt, { nodeId: 'n1', name: 'Scout', role: '', modelRef: null, ...extra })

test('a joined Bot created without a backend is federated', async () => {
  const { rt, registry } = runtime()
  const result = await create(rt)
  assert.equal(result.ok, true)
  assert.deepEqual(registry.sent[0].data.memoryConfig, { backend: 'federation' })
  assert.deepEqual(rt.state.bots[result.id].memoryConfig, { backend: 'federation' })
})

test('an explicit file backend is used instead of the default', async () => {
  const { rt, registry } = runtime()
  const result = await create(rt, { memoryConfig: { backend: 'file' } })
  assert.equal(result.ok, true)
  assert.deepEqual(registry.sent[0].data.memoryConfig, { backend: 'file' })
  assert.deepEqual(rt.state.bots[result.id].memoryConfig, { backend: 'file' })
})

test('an explicit none backend is used instead of the default', async () => {
  const { rt, registry } = runtime()
  const result = await create(rt, { memoryConfig: { backend: 'none' } })
  assert.equal(result.ok, true)
  assert.deepEqual(registry.sent[0].data.memoryConfig, { backend: 'none' })
  assert.deepEqual(rt.state.bots[result.id].memoryConfig, { backend: 'none' })
})

test('re-reporting a Bot that already has a backend leaves that row alone', async () => {
  const { rt, registry } = runtime()
  const id = shadowId('n1', 'rb1')
  rt.state.bots = { [id]: { id, memoryConfig: { backend: 'file' } } }
  const result = await create(rt)
  assert.equal(result.ok, true)
  assert.equal(result.id, id)
  assert.deepEqual(rt.state.bots[id].memoryConfig, { backend: 'file' })
  // The frame still offers the default for the Bot being created on the node.
  assert.deepEqual(registry.sent[0].data.memoryConfig, { backend: 'federation' })
})

test('the node end stores the backend the create frame carried', async () => {
  const seen = []
  const rt = {
    ctx: { get: () => undefined },
    botOf: () => undefined,
    async createBot(spec) { seen.push(spec); return { id: 'local-9' } },
  }
  const accept = createBotCreateReceiver(rt)
  const result = await accept({ name: 'Scout', role: '', modelRef: null, memoryConfig: { backend: 'federation' } })
  assert.equal(result.ok, true)
  assert.deepEqual(seen[0].memoryConfig, { backend: 'federation' })
})

test('the node end drops a backend it does not know', async () => {
  const seen = []
  const rt = {
    ctx: { get: () => undefined },
    botOf: () => undefined,
    async createBot(spec) { seen.push(spec); return { id: 'local-9' } },
  }
  const accept = createBotCreateReceiver(rt)
  const result = await accept({ name: 'Scout', role: '', modelRef: null, memoryConfig: { backend: 'sqlite' } })
  assert.equal(result.ok, true)
  assert.equal(seen[0].memoryConfig, undefined)
})
