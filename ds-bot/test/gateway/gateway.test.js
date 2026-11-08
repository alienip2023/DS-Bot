import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createTokenStore } from '../../src/gateway/token-store.js'
import { createGatewayServer } from '../../src/gateway/index.js'
import { readUpstreamProviders } from '../../src/gateway/upstream.js'
import { authMiddleware } from '../../src/gateway/auth.js'

async function startTestGateway({ providers = [], secrets = new Map(), store = createTokenStore() } = {}) {
  const rt = { warn: () => {} }
  const gw = createGatewayServer({ gatewayHost: '127.0.0.1', gatewayPort: 0, secrets, store, providers, rt })
  const port = await gw.start()
  return { port, stop: () => gw.stop() }
}

async function gFetch(port, path, opts = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, opts)
}

test('1A: missing token -> 401', async () => {
  const store = createTokenStore()
  const { refName } = store.register('node1')
  const secrets = new Map([[refName, 'secret123']])
  const { port, stop } = await startTestGateway({ secrets, store, providers: [{ id: 'p1', models: [] }] })
  try {
    const r = await gFetch(port, '/gw/p1/v1/models')
    assert.equal(r.status, 401)
    const body = await r.json()
    assert.equal(body.error, 'gateway-token-invalid')
  } finally { await stop() }
})

test('1B: unknown provider -> 404', async () => {
  const store = createTokenStore()
  const { refName } = store.register('n1')
  const secrets = new Map([[refName, 'tok1']])
  const { port, stop } = await startTestGateway({ secrets, store, providers: [] })
  try {
    const r = await gFetch(port, '/gw/nonexistent/v1/models', {
      headers: { Authorization: 'Bearer tok1' }
    })
    assert.equal(r.status, 404)
  } finally { await stop() }
})

test('1F: EADDRINUSE -> rt.warn called, returns null', async () => {
  const blocker = createServer()
  await new Promise(r => blocker.listen(0, '127.0.0.1', r))
  const occupiedPort = blocker.address().port
  const warnings = []
  const rt = { warn: (msg) => warnings.push(msg) }
  const gw = createGatewayServer({
    gatewayHost: '127.0.0.1', gatewayPort: occupiedPort,
    secrets: new Map(), store: createTokenStore(), providers: [], rt
  })
  let result
  try {
    result = await gw.start()
  } finally {
    await gw.stop()
    await new Promise(r => blocker.close(r))
  }
  assert.equal(result, null)
  assert.ok(warnings.some(w => String(w).includes('EADDRINUSE')))
})

test('1H: readUpstreamProviders excludes exact gateway origin', () => {
  const gatewayOrigin = 'http://127.0.0.1:4387'
  const providers = [
    { id: 'gw', baseURL: 'http://127.0.0.1:4387/gw/openai/v1' },
    { id: 'other', baseURL: 'http://127.0.0.1:3001/v1' },
    { id: 'ext', baseURL: 'https://api.openai.com/v1' },
  ]
  const result = readUpstreamProviders(providers, gatewayOrigin)
  const ids = result.map(p => p.id)
  assert.ok(!ids.includes('gw'))
  assert.ok(ids.includes('other'))
  assert.ok(ids.includes('ext'))
})

test('1H-ollama: ollama on 11434 is preserved', () => {
  const gatewayOrigin = 'http://127.0.0.1:4387'
  const providers = [
    { id: 'ollama', baseURL: 'http://127.0.0.1:11434' },
    { id: 'gw', baseURL: 'http://127.0.0.1:4387/gw/x/v1' },
  ]
  const result = readUpstreamProviders(providers, gatewayOrigin)
  const ids = result.map(p => p.id)
  assert.ok(ids.includes('ollama'))
  assert.ok(!ids.includes('gw'))
})

test('1J: previous token within window is accepted', async () => {
  let t = 1000
  const store = createTokenStore({ now: () => t })
  const { refName: oldRef } = store.register('n1')
  const { refName: newRef } = store.rotate('n1')
  const secrets = new Map([
    [oldRef, 'old-secret'],
    [newRef, 'new-secret'],
  ])
  const { port, stop } = await startTestGateway({ secrets, store, providers: [{ id: 'p1', models: ['gpt-4'] }] })
  try {
    // within window
    const r = await gFetch(port, '/gw/p1/v1/models', { headers: { Authorization: 'Bearer old-secret' } })
    assert.equal(r.status, 200)
  } finally { await stop() }
})

test('1L-expire: previous token after window -> 401', async () => {
  let t = 1000
  const store = createTokenStore({ now: () => t })
  const { refName: oldRef } = store.register('n1')
  const { refName: newRef } = store.rotate('n1')
  const secrets = new Map([
    [oldRef, 'old-secret'],
    [newRef, 'new-secret'],
  ])
  const { port, stop } = await startTestGateway({ secrets, store, providers: [{ id: 'p1', models: ['gpt-4'] }] })
  try {
    t = 1000 + 10 * 60 * 1000 + 1
    const r = await gFetch(port, '/gw/p1/v1/models', { headers: { Authorization: 'Bearer old-secret' } })
    assert.equal(r.status, 401)
  } finally { await stop() }
})

test('1P: GET /gw/:providerId/v1/models -> {data:[{id}]}', async () => {
  const store = createTokenStore()
  const { refName } = store.register('n1')
  const secrets = new Map([[refName, 'tok1']])
  const { port, stop } = await startTestGateway({
    secrets, store,
    providers: [{ id: 'openai', models: ['gpt-4', 'gpt-4o'] }]
  })
  try {
    const r = await gFetch(port, '/gw/openai/v1/models', { headers: { Authorization: 'Bearer tok1' } })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.ok(Array.isArray(body.data))
    assert.equal(body.data[0].id, 'gpt-4')
    assert.equal(body.data[1].id, 'gpt-4o')
  } finally { await stop() }
})

test('413: oversized body on chat completions -> 413', async () => {
  const store = createTokenStore()
  const { refName } = store.register('n1')
  const secrets = new Map([[refName, 'tok1']])
  const { port, stop } = await startTestGateway({ secrets, store, providers: [{ id: 'p1', models: [] }] })
  try {
    const bigBody = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61)
    const r = await gFetch(port, '/gw/p1/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok1', 'content-type': 'application/json' },
      body: bigBody,
      duplex: 'half',
    })
    assert.equal(r.status, 413)
  } finally { await stop() }
})

test('1F2: ctx.provide called with real port on success', async () => {
  const provided = new Map()
  const rt = { warn: () => {}, ctx: { provide: (k, v) => provided.set(k, v) } }
  const store = createTokenStore()
  const gw = createGatewayServer({ gatewayHost: '127.0.0.1', gatewayPort: 0, secrets: new Map(), store, providers: [], rt })
  const port = await gw.start()
  try {
    assert.ok(port > 0)
    assert.equal(provided.get('ds-bot:gateway-port'), port)
  } finally { await gw.stop() }
})

test('1F2: ctx.provide NOT called on EADDRINUSE', async () => {
  const blocker = createServer()
  await new Promise(r => blocker.listen(0, '127.0.0.1', r))
  const occupiedPort = blocker.address().port
  const provided = new Map()
  const rt = { warn: () => {}, ctx: { provide: (k, v) => provided.set(k, v) } }
  const gw = createGatewayServer({ gatewayHost: '127.0.0.1', gatewayPort: occupiedPort, secrets: new Map(), store: createTokenStore(), providers: [], rt })
  try {
    await gw.start()
  } finally {
    await gw.stop()
    await new Promise(r => blocker.close(r))
  }
  assert.ok(!provided.has('ds-bot:gateway-port'), 'provide must not be called on EADDRINUSE')
})

test('1K-collision: a-b and a_b get different refNames, resolve correctly', () => {
  const store = createTokenStore()
  const { refName: r1 } = store.register('a-b')
  const { refName: r2 } = store.register('a_b')
  assert.notEqual(r1, r2, 'collision: refNames must differ')
  assert.equal(store.resolve(r1), 'a-b')
  assert.equal(store.resolve(r2), 'a_b')
})
