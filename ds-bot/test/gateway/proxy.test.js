
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createTokenStore } from '../../src/gateway/token-store.js'
import { createGatewayServer } from '../../src/gateway/index.js'

// Helper: start fake upstream, returns {port, stop, requests, abortedCount}
function startFakeUpstream(handler) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req)
    handler(req, res)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        port,
        requests,
        stop: () => new Promise(r => server.close(r)),
      })
    })
  })
}

async function startTestGateway({ providers = [], secrets = new Map(), store = createTokenStore(), timeoutMs, bodyLimit } = {}) {
  const rt = { warn: () => {} }
  const gw = createGatewayServer({ gatewayHost: '127.0.0.1', gatewayPort: 0, secrets, store, providers, rt, timeoutMs, bodyLimit })
  const port = await gw.start()
  return { port, stop: () => gw.stop() }
}

async function gFetch(port, path, opts = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, opts)
}

// --- 1C: valid request -> streaming SSE with [DONE] ---
test('1C: valid request -> streaming SSE, first chunk before last chunk', async () => {
  const fake = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
    setTimeout(() => {
      res.write('data: [DONE]\n\n')
      res.end()
    }, 300)
  })
  const store = createTokenStore()
  const { refName } = store.register('n1')
  const secrets = new Map([[refName, 'tok1']])
  const { port, stop } = await startTestGateway({
    secrets, store,
    providers: [{ id: 'p1', baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'sk-test', models: [] }]
  })
  try {
    const timestamps = []
    const r = await gFetch(port, '/gw/p1/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    })
    assert.equal(r.status, 200)
    assert.ok(r.headers.get('content-type').includes('text/event-stream'))
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = dec.decode(value)
      timestamps.push({ chunk, t: Date.now() })
      full += chunk
    }
    assert.ok(full.includes('[DONE]'), 'should contain [DONE]')
    assert.ok(timestamps.length >= 2, 'should receive multiple chunks (streaming)')
    // First chunk must arrive before last
    assert.ok(timestamps[0].t < timestamps[timestamps.length - 1].t)
  } finally {
    await stop()
    await fake.stop()
  }
})

// --- 1D: upstream 502 -> passthrough 502 ---
test('1D: upstream 502 -> 502 passthrough', async () => {
  const fake = await startFakeUpstream((req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'bad gateway' }))
  })
  const store = createTokenStore()
  const { refName } = store.register('n1')
  const secrets = new Map([[refName, 'tok1']])
  const { port, stop } = await startTestGateway({
    secrets, store,
    providers: [{ id: 'p1', baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'sk-test', models: [] }]
  })
  try {
    const r = await gFetch(port, '/gw/p1/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok1', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(r.status, 502)
  } finally {
    await stop()
    await fake.stop()
  }
})

// --- 1E: abort <= 1s: fake upstream records close within 1s ---
test('1E: client abort -> upstream receives close within 1s', async () => {
  let closedAt = null
  const fake = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: start\n\n')
    req.on('close', () => { closedAt = Date.now() })
  })
  const store = createTokenStore()
  const { refName } = store.register('n1')
  const secrets = new Map([[refName, 'tok1']])
  const { port, stop } = await startTestGateway({
    secrets, store,
    providers: [{ id: 'p1', baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'sk-test', models: [] }]
  })
  try {
    const ac = new AbortController()
    const r = await gFetch(port, '/gw/p1/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok1', 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: ac.signal,
    })
    const reader = r.body.getReader()
    await reader.read()
    const tAbort = Date.now()
    ac.abort()
    // Catch the abort error from reader
    try { await reader.read() } catch {}
    // Wait up to 1s for upstream close
    await new Promise(resolve => setTimeout(resolve, 1000))
    assert.ok(closedAt !== null, 'upstream should have received close')
    assert.ok(closedAt - tAbort <= 1000, `abort propagation ${closedAt - tAbort}ms > 1000ms`)
  } finally {
    await stop()
    await fake.stop()
  }
})

// --- 1G: baseURL /v1 -> upstream receives /v1/chat/completions ---
test('1G: baseURL with /v1 -> upstream path is /v1/chat/completions', async () => {
  let receivedPath = null
  const fake = await startFakeUpstream((req, res) => {
    receivedPath = req.url
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const store = createTokenStore()
  const { refName } = store.register('n1')
  const secrets = new Map([[refName, 'tok1']])
  const { port, stop } = await startTestGateway({
    secrets, store,
    providers: [{ id: 'p1', baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'sk-test', models: [] }]
  })
  try {
    await gFetch(port, '/gw/p1/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok1', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(receivedPath, '/v1/chat/completions')
  } finally {
    await stop()
    await fake.stop()
  }
})

// --- 1M: 429 + Retry-After passthrough ---
test('1M: 429 + Retry-After header passthrough', async () => {
  const fake = await startFakeUpstream((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
    res.end(JSON.stringify({ error: 'rate-limited' }))
  })
  const store = createTokenStore()
  const { refName } = store.register('n1')
  const secrets = new Map([[refName, 'tok1']])
  const { port, stop } = await startTestGateway({
    secrets, store,
    providers: [{ id: 'p1', baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'sk-test', models: [] }]
  })
  try {
    const r = await gFetch(port, '/gw/p1/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok1', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(r.status, 429)
    assert.equal(r.headers.get('retry-after'), '7')
  } finally {
    await stop()
    await fake.stop()
  }
})

// --- 1N: 402 passthrough ---
test('1N: 402 passthrough', async () => {
  const fake = await startFakeUpstream((req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'payment-required' }))
  })
  const store = createTokenStore()
  const { refName } = store.register('n1')
  const secrets = new Map([[refName, 'tok1']])
  const { port, stop } = await startTestGateway({
    secrets, store,
    providers: [{ id: 'p1', baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'sk-test', models: [] }]
  })
  try {
    const r = await gFetch(port, '/gw/p1/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok1', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(r.status, 402)
  } finally {
    await stop()
    await fake.stop()
  }
})

// --- 1O: no token + unknown provider -> 401 (auth checked before provider lookup) ---
test('1O: no token -> 401 (auth before provider lookup)', async () => {
  const store = createTokenStore()
  store.register('n1')
  const secrets = new Map([['GATEWAY_TOKEN_n1', 'tok1']])
  const { port, stop } = await startTestGateway({
    secrets, store,
    providers: [{ id: 'p1', models: [] }]
  })
  try {
    const r = await gFetch(port, '/gw/nonexistent/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(r.status, 401)
  } finally { await stop() }
})
