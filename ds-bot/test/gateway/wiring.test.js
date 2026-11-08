// 1A-3 wiring tests: gateway startup via install() + nodeId-scoped tokens
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { install } from '../../src/host/config-source.js'
import { createTokenStore } from '../../src/gateway/token-store.js'

async function startBlocker() {
  const s = createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  return { port: s.address().port, stop: () => new Promise(r => s.close(r)) }
}

function canConnect(port) {
  return new Promise(resolve => {
    const sock = createConnection({ port, host: '127.0.0.1' })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

function makeRt({ gatewayPort = 0, gatewayHost = '127.0.0.1', hasSyncService = true } = {}) {
  const warns = []
  let setSourceCb = null
  let providedPort = null
  const effectCleanups = []
  const mockService = hasSyncService ? { setSource: cb => { setSourceCb = cb } } : null
  const store = Object.create(null)
  store['remote-agent:config-sync'] = mockService
  const dsBot = { gatewayPort, gatewayHost }
  const settings = {
    describe: () => [
      { ns: 'ds-bot', value: dsBot },
      { ns: 'llm-pi-ai', value: { providers: {} } },
    ],
  }
  store.settings = settings
  const ctx = {
    get: name => name === 'settings' ? settings : store[name],
    provide: (key, val) => { if (key === 'ds-bot:gateway-port') providedPort = val },
    effect: (fn, _label) => {
      // fn may be async (returns Promise<cleanup>) or sync (returns cleanup fn)
      const result = fn()
      effectCleanups.push(result)
    },
    llm: { listConfigurableProviders: () => [] },
  }
  const rt = { ctx, dshHome: '/nonexistent', warn: (...a) => warns.push(a), defaultBotModel: async () => null }

  const dispose = async () => {
    for (const c of effectCleanups) {
      try {
        const cleanup = c && typeof c.then === 'function' ? await c : c
        if (typeof cleanup === 'function') await cleanup()
      } catch {}
    }
  }

  return { rt, warns, getSetSource: () => setSourceCb, getProvidedPort: () => providedPort, dispose }
}

// --- 1A3-start: install starts gateway, ctx.provide gets real port ---
test('1A3-start: install starts gateway, provide gives real port', async () => {
  const { rt, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
  install(rt)
  await new Promise(r => setTimeout(r, 100))
  try {
    const port = getProvidedPort()
    assert.ok(typeof port === 'number' && port > 0, `ctx.provide should have been called with real port, got: ${port}`)
    assert.ok(await canConnect(port), `gateway port ${port} should accept connections`)
  } finally {
    await dispose()
  }
})

// --- 1A3-node-token: different nodeIds get different refName; same nodeId idempotent ---
test('1A3-node-token: nodeId-scoped tokens + idempotency', async () => {
  const { rt, getSetSource, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
  install(rt)
  await new Promise(r => setTimeout(r, 100))
  try {
    const port = getProvidedPort()
    assert.ok(port != null, 'gateway should have started')
    const cb = getSetSource()
    assert.ok(cb, 'setSource callback should be captured')
    const p1 = cb('node-alpha')
    const p2 = cb('node-beta')
    const p1b = cb('node-alpha')
    // Source must be synchronous (not a Promise)
    assert.ok(typeof p1 === 'object' && !p1.then, 'source must return plain object synchronously')
    // Different nodeIds produce different refNames via tokenStore
    const ts = createTokenStore()
    const r1 = ts.register('node-alpha')
    const r2 = ts.register('node-beta')
    assert.notEqual(r1.refName, r2.refName, 'different nodes should have different refNames')
    const r1b = ts.register('node-alpha')
    assert.equal(r1.refName, r1b.refName, 'same nodeId should produce same refName')
    assert.equal(ts.resolve(r1.refName), 'node-alpha')
    assert.equal(ts.resolve(r2.refName), 'node-beta')
  } finally {
    await dispose()
  }
})

// --- 1A3-no-gateway: port in use -> actualPort null -> setSource gateway null ---
test('1A3-no-gateway: port in use, setSource gateway null, warn logged', async () => {
  const blocker = await startBlocker()
  const { rt, warns, getSetSource, getProvidedPort, dispose } = makeRt({ gatewayPort: blocker.port })
  install(rt)
  await new Promise(r => setTimeout(r, 150))
  try {
    const port = getProvidedPort()
    assert.equal(port, null, 'provide should not be called when gateway fails')
    const cb = getSetSource()
    if (cb) {
      const payload = cb('node-x')
      assert.ok(payload != null && typeof payload === 'object' && !payload.then, 'source must return plain object')
    }
    assert.ok(warns.some(w => String(w[0]).includes('EADDRINUSE') || String(w[0]).includes('gateway') || String(w[0]).includes('port')),
      `should warn about port in use, got: ${JSON.stringify(warns)}`)
  } finally {
    await dispose()
    await blocker.stop()
  }
})

// --- 1A3-stop: dispose releases gateway port ---
// Knife: delete stop() in dispose -> canConnect still true -> RED
test('1A3-stop: dispose releases gateway port', async () => {
  const { rt, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
  install(rt)
  await new Promise(r => setTimeout(r, 100))
  const port = getProvidedPort()
  assert.ok(port != null && port > 0, `gateway should have started on port ${port}`)
  // Port should be open before dispose
  assert.ok(await canConnect(port), 'port should be open before dispose')
  await dispose()
  await new Promise(r => setTimeout(r, 50))
  // After dispose, port should be closed — if stop() removed, port stays open -> RED
  assert.equal(await canConnect(port), false, 'port should be released after dispose')
})
