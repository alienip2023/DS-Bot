// A node older than ra 0.10.1-fork.76 has no `memory-sync/1`, so a Bot created on it
// must not default to federation: the node would drop the field and the shadow row
// would describe a backend the node never runs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotOnNode } from '../src/host/joined-create.js'

function registryWith(caps) {
  const listeners = new Map()
  const sent = []
  const on = (name, fn) => { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)).add(fn) }
  const off = (name, fn) => { listeners.get(name)?.delete(fn) }
  const emit = (name, payload) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload) }
  const send = (nodeId, type, data) => {
    sent.push({ nodeId, type, data })
    if (type === 'bot/create') setTimeout(() => emit('botCreateResult', { requestId: data.requestId, ok: true, remoteBotId: 'rb1', name: data.name }), 0)
    return true
  }
  return { sent, on, off, send, onlineNodes: () => [{ nodeId: 'n1', models: null, caps }] }
}

function runtime(caps) {
  const registry = registryWith(caps)
  const rt = { state: {}, ctx: { get: name => (name === 'remote-agent:registry' ? registry : undefined) }, botCreateTimeoutMs: 200, save: async () => {}, botOf(id) { return this.state.bots?.[id] } }
  return { rt, registry }
}

const create = (rt, extra = {}) => createBotOnNode(rt, { nodeId: 'n1', name: 'Scout', role: '', modelRef: null, ...extra })

test('an old node gets no memoryConfig and the shadow row is not federated', async () => {
  const { rt, registry } = runtime(['bot-create/1'])
  const result = await create(rt)
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(registry.sent[0].data, 'memoryConfig'), false, 'the frame carries no backend')
  assert.equal(Object.hasOwn(rt.state.bots[result.id], 'memoryConfig'), false, 'the shadow row is not federated')
})

test('a node that announces memory-sync/1 still defaults to federation', async () => {
  const { rt, registry } = runtime(['memory-sync/1'])
  const result = await create(rt)
  assert.equal(result.ok, true)
  assert.deepEqual(registry.sent[0].data.memoryConfig, { backend: 'federation' })
  assert.deepEqual(rt.state.bots[result.id].memoryConfig, { backend: 'federation' })
})

test('an explicit backend is sent to both an old and a new node', async () => {
  for (const caps of [['bot-create/1'], ['memory-sync/1']]) {
    for (const backend of ['file', 'none']) {
      const { rt, registry } = runtime(caps)
      const result = await create(rt, { memoryConfig: { backend } })
      assert.equal(result.ok, true)
      assert.deepEqual(registry.sent[0].data.memoryConfig, { backend }, `${caps} takes an explicit ${backend}`)
    }
  }
})
