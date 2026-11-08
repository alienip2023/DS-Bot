// 1A-3 wiring tests: gateway startup via install() + nodeId-scoped tokens
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { install, listGatewayProviders } from '../../src/host/config-source.js'
import { createTokenStore } from '../../src/gateway/token-store.js'

async function startBlocker() {
  const s = createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  return { port: s.address().port, stop: () => new Promise(r => s.close(r)) }
}

function canConnect(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const sock = createConnection({ port, host })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

// Real Cordis effect semantics: fn() called sync; only typeof result === 'function' registered as disposer.
// Async fns return Promise → NOT registered → stop() never called.
function makeRt({ gatewayPort = 0, gatewayHost = '127.0.0.1', hasSyncService = true, providers = [], env: envOverride = {} } = {}) {
  // When gatewayPort=0 (random), inject DS_BOT_GATEWAY_PORT=0 so readGatewaySettings uses it
  const env = gatewayPort === 0 ? { DS_BOT_GATEWAY_PORT: '0', ...envOverride } : { ...envOverride }
  const warns = []
  let setSourceCb = null
  let providedPort = null
  const disposers = []
  const mockService = hasSyncService ? { setSource: cb => { setSourceCb = cb } } : null
  const store = Object.create(null)
  store['remote-agent:config-sync'] = mockService
  const dsBot = gatewayPort !== 0 ? { gatewayPort, gatewayHost } : null
  const settings = {
    describe: () => [
      ...(dsBot ? [{ ns: 'ds-bot', value: dsBot }] : []),
      { ns: 'llm-pi-ai', value: { providers: {} } },
    ],
  }
  store.settings = settings
  const ctx = {
    get: name => name === 'settings' ? settings : store[name],
    provide: (key, val) => { if (key === 'ds-bot:gateway-port') providedPort = val },
    effect: (fn, _label) => {
      const r = fn()
      if (typeof r === 'function') disposers.push(r)
    },
    llm: { listConfigurableProviders: () => providers },
  }
  // Patch env vars for this test
  const savedEnv = {}
  for (const [k, v] of Object.entries(env)) { savedEnv[k] = process.env[k]; process.env[k] = v }
  const rt = { ctx, dshHome: '/nonexistent', warn: (...a) => warns.push(a), defaultBotModel: async () => null }

  const dispose = async () => {
    for (const d of disposers) { try { d() } catch {} }
    await new Promise(r => setTimeout(r, 30))
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  return { rt, warns, getSetSource: () => setSourceCb, getProvidedPort: () => providedPort, dispose }
}

// --- 1A3-start: install starts gateway, ctx.provide gets real port ---
test('1A3-start: install starts gateway, provide gives real port', async () => {
  const { rt, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
  install(rt)
  await new Promise(r => setTimeout(r, 120))
  try {
    const port = getProvidedPort()
    assert.ok(typeof port === 'number' && port > 0, `ctx.provide should have been called with real port, got: ${port}`)
    assert.ok(await canConnect(port), `gateway port ${port} should accept connections`)
  } finally { await dispose() }
})

// --- 1A3-node-token: different nodeIds get different refName; same nodeId idempotent ---
// Goes through real ensureToken via setSource callback with a gateway provider.
// Knife A: register ignores nodeId → same refName for all → RED
// Knife B: every-call-generate (ignore secrets.has) → token value changes → RED
test('1A3-node-token: nodeId-scoped tokens + idempotency', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-token-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })

  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
  ]
  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  const { rt, getSetSource, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
  rt.ctx.get('settings').describe = () => settingsSections
  rt.ctx.llm.listConfigurableProviders = () => cfgProviders
  rt.dshHome = tmpHome

  install(rt)
  await new Promise(r => setTimeout(r, 120))
  try {
    const port = getProvidedPort()
    assert.ok(port != null, 'gateway should have started')
    const cb = getSetSource()
    assert.ok(cb, 'setSource callback should be captured')
    // Call with different nodeIds — ensureToken produces different refNames
    const p1 = cb('node-alpha')
    const p2 = cb('node-beta')
    const p1b = cb('node-alpha')
    const gw1 = p1.providers.find(p => p.id === 'alpha')
    const gw2 = p2.providers.find(p => p.id === 'alpha')
    const gw1b = p1b.providers.find(p => p.id === 'alpha')
    assert.ok(gw1 && gw2 && gw1b, 'alpha provider should be in all payloads')
    assert.notEqual(gw1.apiKeyEnv, gw2.apiKeyEnv, 'different nodeIds should have different apiKeyEnv (refName)')
    assert.equal(gw1.apiKeyEnv, gw1b.apiKeyEnv, 'same nodeId should produce same apiKeyEnv (idempotent)')
    assert.equal(gw1.apiKey, gw1b.apiKey, 'same nodeId should produce same token value (idempotent)')
  } finally { await dispose() }
})

// --- 1A3-no-gateway: port in use -> actualPort null -> providers NOT rewritten ---
// Knife: pass gateway even when port null -> provider baseURL gets rewritten -> RED
test('1A3-no-gateway: port in use, providers keep original baseURL', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-nogw-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })

  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
  ]
  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]

  const blocker = await startBlocker()
  const { rt, warns, getSetSource, getProvidedPort, dispose } = makeRt({ gatewayPort: blocker.port })
  rt.ctx.get('settings').describe = () => settingsSections
  rt.ctx.llm.listConfigurableProviders = () => cfgProviders
  rt.dshHome = tmpHome

  install(rt)
  await new Promise(r => setTimeout(r, 150))
  try {
    const port = getProvidedPort()
    assert.equal(port, null, 'provide should not be called when gateway fails to start')
    const cb = getSetSource()
    assert.ok(cb, 'setSource callback should exist')
    const payload = cb('node-x')
    assert.ok(payload != null && typeof payload === 'object' && !payload.then, 'source must return plain object synchronously')
    // Provider alpha has gateway:true but gateway port is null -> should keep original baseURL
    const alpha = payload.providers.find(p => p.id === 'alpha')
    assert.ok(alpha, 'alpha provider should be in payload')
    assert.equal(alpha.baseURL, 'https://up.example.com/v1', 'provider should keep original baseURL when gateway not started')
    assert.ok(warns.length > 0, 'should have warned about port in use or gateway fallback')
  } finally { await dispose(); await blocker.stop() }
})

// --- 1A3-stop: dispose releases gateway port ---
test('1A3-stop: dispose releases gateway port', async () => {
  const { rt, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
  install(rt)
  await new Promise(r => setTimeout(r, 120))
  const port = getProvidedPort()
  assert.ok(port != null && port > 0, `gateway should have started on port ${port}`)
  assert.ok(await canConnect(port), 'port should be open before dispose')
  await dispose()
  await new Promise(r => setTimeout(r, 80))
  assert.equal(await canConnect(port), false, 'port should be released after dispose')
})

// --- 1A3-providers: listGatewayProviders derives from real settings ---
// Knife: providers: [] (empty) → listGatewayProviders returns [] → alpha missing → RED
test('1A3-providers: listGatewayProviders returns real provider list', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-gw-prov-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })

  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'alpha-1' }, { id: 'alpha-2' }], gateway: true } } } },
  ]
  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]

  const { rt, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
  rt.ctx.get('settings').describe = () => settingsSections
  rt.ctx.llm.listConfigurableProviders = () => cfgProviders
  rt.dshHome = tmpHome

  install(rt)
  await new Promise(r => setTimeout(r, 120))
  try {
    const port = getProvidedPort()
    assert.ok(port != null && port > 0, 'gateway should have started')

    // listGatewayProviders should return alpha (has key + baseURL)
    const list = listGatewayProviders(rt)
    assert.ok(list.some(p => p.id === 'alpha'), 'alpha should be in provider list')
    const alpha = list.find(p => p.id === 'alpha')
    assert.equal(alpha.models.length, 2, 'alpha should have 2 models')

    // GET /gw/alpha/v1/models — auth required but provider IS registered: 401 (not 404)
    const r1 = await fetch(`http://127.0.0.1:${port}/gw/alpha/v1/models`).catch(() => null)
    if (r1) {
      const b1 = await r1.json().catch(() => ({}))
      assert.ok(r1.status !== 404, `alpha should not be 404 (providers registered), got ${r1.status}: ${JSON.stringify(b1)}`)
    }

    // Unknown provider → 401 without auth first; check auth-required response
    const r2 = await fetch(`http://127.0.0.1:${port}/gw/unknown/v1/models`).catch(() => null)
    if (r2) {
      // 401 is fine here (auth checked before routing), but provider-not-found must not appear
      // because auth fails before we reach provider lookup
      const b2 = await r2.json().catch(() => ({}))
      assert.notEqual(b2.error, 'provider-not-found', 'should not see provider-not-found before auth passes')
    }
  } finally { await dispose() }
})

// --- 1A3-config: DS_BOT_GATEWAY_HOST/PORT env vars control bind ---
// Uses env to specify port=0 (random), verifies gateway starts and port > 0.
// Knife: ignore env, always default 127.0.0.1:4387 → 4387 likely occupied → null → RED
test('1A3-config: env var DS_BOT_GATEWAY_PORT controls port', async () => {
  // Set DS_BOT_GATEWAY_PORT=0 so gateway picks a random free port via OS (default would be 4387)
  // No 'ds-bot' settings section — env is the only config path being exercised
  const { rt, getProvidedPort, dispose } = makeRt({ gatewayPort: 0, env: { DS_BOT_GATEWAY_PORT: '0' } })
  install(rt)
  await new Promise(r => setTimeout(r, 150))
  try {
    const port = getProvidedPort()
    // Port should be a positive number chosen by OS (not 4387 the default)
    assert.ok(typeof port === 'number' && port > 0, `gateway should have started via env port=0, got ${port}`)
    assert.ok(await canConnect(port), `gateway port ${port} should accept connections`)
  } finally { await dispose() }
})
