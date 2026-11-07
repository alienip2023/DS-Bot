// Behavioral tests for the channel UI layer: create-bot nodeId routing and bot-create-targets.
// Knife requirement: delete the nodeId branch in channel.js → tests fail on behavior
// (local createBot was called / no shadow row written), not on source regex.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Minimal start() that wires a fake registry with online nodes.
function start({ nodes = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-step3-ui-'))
  const services = {}
  const ctx = fakeContext({ services })
  // Fake registry exposed via ctx.get('remote-agent:registry')
  const listeners = {}
  const fakeRegistry = {
    sent: [],
    nodes,
    onlineNodes() { return this.nodes.slice() },
    send(nid, type, data) {
      this.sent.push({ nodeId: nid, type, data })
      Promise.resolve().then(() => {
        const fn = (listeners['botCreateResult'] ?? [])
        fn.forEach(f => f({ requestId: data.requestId, ok: true, remoteBotId: 'remote-bot-1', name: data.name, role: data.role ?? '' }))
      })
      return true
    },
    on(name, fn) { (listeners[name] ??= []).push(fn) },
    off(name, fn) { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn) },
    emit(name, payload) { (listeners[name] ?? []).forEach(f => f(payload)) },
  }
  const baseGet = ctx.get.bind(ctx)
  ctx.get = name => name === 'remote-agent:registry' ? fakeRegistry : baseGet(name)

  let sessions = 0
  const localBotsCreated = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async (path) => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => { localBotsCreated.push(true); return { sessionId: `s${++sessions}` } },
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })

  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }

  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, rt, fakeRegistry, localBotsCreated }
}

// ── Knife test: delete the nodeId branch → this test must fail on behavior ──
// When nodeId is present, channel must NOT call local createBot (no session created).
test('create-bot with nodeId routes to createBotOnNode and does not call local createBot', async (t) => {
  const { call, stop, fakeRegistry, localBotsCreated } = start({
    nodes: [{ nodeId: 'node-x', hostname: 'worker-1' }],
  })
  t.after(stop)

  const res = await call('create-bot', { nodeId: 'node-x', name: 'RemoteAlpha', role: '工' })
  assert.equal(res.ok, true, `create-bot with nodeId failed: ${JSON.stringify(res.error)}`)
  // The result must come from createBotOnNode (has remoteBotId), not local createBot (which has a model field)
  assert.ok(res.value?.id ?? res.value?.remoteBotId ?? res.value?.ok === true,
    'result should carry shadow row id or remoteBotId from createBotOnNode')
  // A bot/create frame must have been sent to the registry (not a local session)
  const sent = fakeRegistry.sent.find(s => s.type === 'bot/create')
  assert.ok(sent, '没有向 registry 发出 bot/create 帧 — nodeId 分支没生效')
  assert.equal(sent.nodeId, 'node-x')
  // Local sessionController.create must NOT have been called for this bot
  assert.equal(localBotsCreated.length, 0,
    'local createBot (sessionController.create) should not be called when nodeId is provided')
})

// When node is offline/unknown, must return error and write no shadow row.
test('create-bot with unknown nodeId returns error and writes no shadow row', async (t) => {
  const { call, stop, rt } = start({ nodes: [{ nodeId: 'node-x', hostname: 'worker-1' }] })
  t.after(stop)

  const res = await call('create-bot', { nodeId: 'node-unknown', name: 'Ghost', role: '' })
  assert.equal(res.ok, false, 'should fail for unknown node')
  // No shadow row written
  await rt.load()
  const joinedBots = Object.values(rt.state.bots ?? {}).filter(b => b.origin === 'joined')
  assert.equal(joinedBots.length, 0, '不应有影子行')
})

// bot-create-targets returns the online nodes from the registry.
test('bot-create-targets returns online nodes from registry', async (t) => {
  const { call, stop } = start({
    nodes: [{ nodeId: 'node-a', hostname: 'machine-a' }, { nodeId: 'node-b', hostname: 'machine-b' }],
  })
  t.after(stop)

  const res = await call('bot-create-targets', {})
  assert.equal(res.ok, true, 'bot-create-targets should succeed')
  assert.ok(Array.isArray(res.value), 'should return array')
  assert.equal(res.value.length, 2)
  const ids = res.value.map(n => n.nodeId)
  assert.ok(ids.includes('node-a'), 'should include node-a')
  assert.ok(ids.includes('node-b'), 'should include node-b')
})

// bot-create-targets returns empty array when no registry is present.
test('bot-create-targets returns empty array when registry absent', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-step3-ui-noregistry-'))
  const ctx = fakeContext({})
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async (path) => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: `s${++sessions}` }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const res = await call('bot-create-targets', {})
  assert.equal(res.ok, true)
  assert.deepEqual(res.value, [])
})

// Without nodeId, create-bot continues to create a local bot as before.
test('create-bot without nodeId creates a local Bot', async (t) => {
  const { call, stop } = start({ nodes: [] })
  t.after(stop)

  const res = await call('create-bot', { name: 'LocalBot', role: '助手' })
  assert.equal(res.ok, true, `local create-bot failed: ${JSON.stringify(res.error)}`)
  assert.ok(res.value?.id, 'should return bot id')
  assert.equal(res.value?.name, 'LocalBot')
})
