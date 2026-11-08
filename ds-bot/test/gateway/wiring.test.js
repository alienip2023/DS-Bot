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
// Async fns return Promise -> NOT registered -> stop() never called.
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
  // Build settings sections: include ds-bot section when gatewayPort is explicit (non-zero)
  const dsBotSection = gatewayPort !== 0 ? { ns: 'ds-bot', value: { gatewayPort, gatewayHost } } : null
  const baseSections = [
    ...(dsBotSection ? [dsBotSection] : []),
    { ns: 'llm-pi-ai', value: { providers: {} } },
  ]
  const settings = {
    describe: () => baseSections,
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
// Knife: register ignores nodeId -> same refName for all -> RED
// Knife: every-call-generate (ignore secrets.has) -> token value changes -> RED
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

  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]

  const blocker = await startBlocker()
  // IMPORTANT: include ds-bot section with blocker.port so gateway always tries this occupied port.
  // Without this, readGatewaySettings falls back to default 4387, which may or may not be occupied.
  const settingsSections = [
    { ns: 'ds-bot', value: { gatewayPort: blocker.port, gatewayHost: '127.0.0.1' } },
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
  ]

  const { rt, warns, getSetSource, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
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

// --- 1A3-providers: providersFn resolved per-request from real listGatewayProviders ---
// Goes through product path: setSource callback -> Bearer token -> HTTP -> models endpoint.
// Knife A: providersFn returns [] -> alpha 404 -> RED
// Knife C: resolveProviders evaluates once at creation -> beta not found on second request -> RED
test('1A3-providers: per-request provider resolution via real setSource path', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-gw-prov-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n  BETA_KEY: sk-beta\n', { mode: 0o600 })

  let cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: {
      alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'alpha-1' }, { id: 'alpha-2' }], gateway: true },
      beta:  { api: 'openai-completions', baseURL: 'https://up2.example.com/v1', apiKeyEnv: 'BETA_KEY',  models: [{ id: 'beta-1' }],  gateway: true },
    } } },
  ]

  const { rt, getSetSource, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
  rt.ctx.get('settings').describe = () => settingsSections
  rt.ctx.llm.listConfigurableProviders = () => cfgProviders
  rt.dshHome = tmpHome

  install(rt)
  await new Promise(r => setTimeout(r, 120))
  try {
    const port = getProvidedPort()
    assert.ok(port != null && port > 0, 'gateway should have started')
    const cb = getSetSource()
    assert.ok(cb, 'setSource callback should be captured')

    // Get token for node-x via setSource callback (ensureToken is called inside)
    const payload = cb('node-x')
    const alphaEntry = payload.providers.find(p => p.id === 'alpha')
    assert.ok(alphaEntry, 'alpha should be in payload providers')
    const token = alphaEntry.apiKey  // token value written to secrets by ensureToken

    // Request 1: GET /gw/alpha/v1/models with valid Bearer token -> 200, data.length === 2
    const r1 = await fetch(`http://127.0.0.1:${port}/gw/alpha/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const b1 = await r1.json()
    assert.equal(r1.status, 200, `alpha models should return 200, got ${r1.status}: ${JSON.stringify(b1)}`)
    assert.equal(b1.data.length, 2, `alpha should have 2 models, got ${b1.data.length}`)
    assert.equal(b1.data[0].id, 'alpha-1', `first model should be alpha-1, got ${b1.data[0].id}`)

    // Request 2: GET /gw/unknown/v1/models -> 404 provider-not-found
    const r2 = await fetch(`http://127.0.0.1:${port}/gw/unknown/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const b2 = await r2.json()
    assert.equal(r2.status, 404, `unknown provider should return 404, got ${r2.status}`)
    assert.equal(b2.error, 'provider-not-found', `error should be provider-not-found, got ${b2.error}`)

    // Per-request resolution: add beta provider AFTER gateway started
    cfgProviders = [
      { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
      { provider: 'beta',  settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'beta'] },
    ]
    // Request 3: GET /gw/beta/v1/models -> 200 (proves per-request resolution, not cached at creation)
    const r3 = await fetch(`http://127.0.0.1:${port}/gw/beta/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const b3 = await r3.json()
    assert.equal(r3.status, 200, `beta models should return 200 after dynamic add, got ${r3.status}: ${JSON.stringify(b3)}`)
    assert.equal(b3.data[0].id, 'beta-1', `beta model should be beta-1, got ${b3.data[0]?.id}`)
  } finally { await dispose() }
})

// --- 1A3-config: DS_BOT_GATEWAY_HOST env var controls bind host (via payload baseURL) ---
// Use DS_BOT_GATEWAY_HOST=localhost: gateway binds to localhost, payload baseURL uses localhost.
// Knife B: DS_BOT_GATEWAY_HOST ignored -> host stays 127.0.0.1 -> baseURL has 127.0.0.1 -> RED
test('1A3-config: env var DS_BOT_GATEWAY_HOST controls gateway host in payload', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-cfg-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })

  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  // No ds-bot section in settings: host/port come from env only
  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
  ]

  // Set DS_BOT_GATEWAY_HOST=localhost and DS_BOT_GATEWAY_PORT=0 via env (no ds-bot settings section)
  const { rt, getSetSource, getProvidedPort, dispose } = makeRt({
    gatewayPort: 0,
    env: { DS_BOT_GATEWAY_HOST: 'localhost', DS_BOT_GATEWAY_PORT: '0' },
  })
  rt.ctx.get('settings').describe = () => settingsSections
  rt.ctx.llm.listConfigurableProviders = () => cfgProviders
  rt.dshHome = tmpHome

  install(rt)
  await new Promise(r => setTimeout(r, 150))
  try {
    const port = getProvidedPort()
    assert.ok(typeof port === 'number' && port > 0, `gateway should have started via env host=localhost, got ${port}`)
    assert.ok(await canConnect(port, 'localhost'), `gateway should accept connections on localhost:${port}`)

    const cb = getSetSource()
    assert.ok(cb, 'setSource callback should be captured')
    const payload = cb('node-x')
    const alpha = payload.providers.find(p => p.id === 'alpha')
    assert.ok(alpha, 'alpha provider should be in payload')
    // baseURL should reflect the gateway host from env (localhost), not default 127.0.0.1
    assert.ok(alpha.baseURL.startsWith('http://localhost:'), `alpha baseURL should use localhost from env, got: ${alpha.baseURL}`)
  } finally { await dispose() }
})

// --- 1A5-yaml-fallback: settings.yaml ds-bot: section used when settings.describe has no ds-bot ns ---
// Knife: delete YAML fallback -> host stays 127.0.0.1 -> baseURL has 127.0.0.1 -> RED
test('1A5-yaml-fallback: settings.yaml ds-bot section used when settings.describe lacks ds-bot ns', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-yaml-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })
  // Write settings.yaml with ds-bot: section but use host=127.0.0.3 to distinguish from default
  // NOTE: 127.0.0.3 may not be bindable on all macOS; use 127.0.0.1 as gwHost but port=0 for random
  // The key thing we test: the host value is read from settings.yaml, not the default 127.0.0.1
  // We use 'localhost' as the yaml host so it IS bindable and distinct from '127.0.0.1' string
  writeFileSync(join(tmpHome, 'settings.yaml'), [
    'schema: 2',
    'ds-bot:',
    '  gatewayHost: localhost',
    '  gatewayPort: 0',
  ].join('\n') + '\n')

  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
    // Deliberately NO ds-bot section — fallback to settings.yaml must kick in
  ]

  const { rt, getSetSource, getProvidedPort, dispose } = makeRt({ gatewayPort: 0 })
  rt.ctx.get('settings').describe = () => settingsSections
  rt.ctx.llm.listConfigurableProviders = () => cfgProviders
  rt.dshHome = tmpHome

  install(rt)
  await new Promise(r => setTimeout(r, 150))
  try {
    const port = getProvidedPort()
    assert.ok(typeof port === 'number' && port > 0, `gateway should have started via yaml host=localhost, got ${port}`)
    assert.ok(await canConnect(port, 'localhost'), `gateway should accept connections on localhost:${port}`)

    const cb = getSetSource()
    assert.ok(cb, 'setSource callback should be captured')
    const payload = cb('node-x')
    const alpha = payload.providers.find(p => p.id === 'alpha')
    assert.ok(alpha, 'alpha provider should be in payload')
    // baseURL should use the host read from settings.yaml (localhost), not default 127.0.0.1
    assert.ok(alpha.baseURL.startsWith('http://localhost:'), `alpha baseURL should use localhost from yaml, got: ${alpha.baseURL}`)
  } finally { await dispose() }
})

// --- 1A5-warn-logging: gateway logs on start + source attach + not-ready warn ---
test('1A5-warn-logging: gateway listening warn, source attached warn, not-ready warn when port null', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { createServer } = await import('node:http')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-warn-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })

  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
  ]

  // Test 1: happy path — gateway starts, listening warn emitted
  {
    const { rt, warns, dispose } = makeRt({ gatewayPort: 0 })
    rt.ctx.get('settings').describe = () => settingsSections
    rt.ctx.llm.listConfigurableProviders = () => cfgProviders
    rt.dshHome = tmpHome
    install(rt)
    await new Promise(r => setTimeout(r, 150))
    try {
      const listeningWarn = warns.find(w => w[0].includes('gateway listening on'))
      assert.ok(listeningWarn, `should log 'gateway listening on' warn, got: ${JSON.stringify(warns)}`)
      const attachedWarn = warns.find(w => w[0].includes('config-sync source attached'))
      assert.ok(attachedWarn, `should log 'config-sync source attached' warn`)
    } finally { await dispose() }
  }

  // Test 2: port in use — 'providers pushed direct' warn emitted when setSource called
  {
    const blocker = createServer()
    await new Promise(r => blocker.listen(0, '127.0.0.1', r))
    const blockedPort = blocker.address().port
    const blockerSections = [
      ...settingsSections,
      { ns: 'ds-bot', value: { gatewayPort: blockedPort, gatewayHost: '127.0.0.1' } },
    ]
    const { rt, warns, getSetSource, dispose } = makeRt({ gatewayPort: 0 })
    rt.ctx.get('settings').describe = () => blockerSections
    rt.ctx.llm.listConfigurableProviders = () => cfgProviders
    rt.dshHome = tmpHome
    install(rt)
    await new Promise(r => setTimeout(r, 200))
    try {
      const cb = getSetSource()
      if (cb) {
        cb('node-x')  // trigger the not-ready warn
        const notReadyWarn = warns.find(w => w[0].includes('providers pushed direct'))
        assert.ok(notReadyWarn, `should log 'providers pushed direct' when gateway not ready, got: ${JSON.stringify(warns)}`)
      }
    } finally { await dispose(); await new Promise(r => blocker.close(r)) }
  }
})

// --- 1A5-initial-push: after setSource, online nodes get an immediate sendPush ---
test('1A5-initial-push: online nodes receive sendPush immediately after source is attached', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-push-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })

  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
  ]

  // Test 1: both online nodes get pushed; sendPush returns synchronous boolean (production semantics)
  {
    const pushedNodes = []
    const mockService = {
      setSource: cb => { mockService._cb = cb },
      sendPush: (nodeId) => { pushedNodes.push(nodeId); return true },  // sync boolean like production
    }
    const mockRegistry = {
      onlineNodes: () => [{ nodeId: 'node-online-1' }, { nodeId: 'node-online-2' }],
    }

    const { rt, dispose } = makeRt({ gatewayPort: 0 })
    rt.ctx.get('settings').describe = () => settingsSections
    rt.ctx.llm.listConfigurableProviders = () => cfgProviders
    rt.dshHome = tmpHome
    rt.ctx.get = (name) => {
      if (name === 'settings') return { describe: () => settingsSections }
      if (name === 'remote-agent:config-sync') return mockService
      if (name === 'remote-agent:registry') return mockRegistry
      return undefined
    }

    install(rt)
    await new Promise(r => setTimeout(r, 200))
    try {
      assert.ok(pushedNodes.includes('node-online-1'), `node-online-1 should have been pushed immediately, got: ${JSON.stringify(pushedNodes)}`)
      assert.ok(pushedNodes.includes('node-online-2'), `node-online-2 should have been pushed immediately, got: ${JSON.stringify(pushedNodes)}`)
    } finally { await dispose() }
  }

  // Test 2: first node sendPush throws → second node still gets called (error isolation)
  {
    const pushedNodes = []
    const mockService = {
      setSource: cb => { mockService._cb = cb },
      sendPush: (nodeId) => {
        pushedNodes.push(nodeId)
        if (nodeId === 'node-online-1') throw new Error('simulated send failure')
        return true
      },
    }
    const mockRegistry = {
      onlineNodes: () => [{ nodeId: 'node-online-1' }, { nodeId: 'node-online-2' }],
    }

    const { rt, dispose } = makeRt({ gatewayPort: 0 })
    rt.ctx.get('settings').describe = () => settingsSections
    rt.ctx.llm.listConfigurableProviders = () => cfgProviders
    rt.dshHome = tmpHome
    rt.ctx.get = (name) => {
      if (name === 'settings') return { describe: () => settingsSections }
      if (name === 'remote-agent:config-sync') return mockService
      if (name === 'remote-agent:registry') return mockRegistry
      return undefined
    }

    install(rt)
    await new Promise(r => setTimeout(r, 200))
    try {
      assert.ok(pushedNodes.includes('node-online-1'), `node-online-1 sendPush should have been attempted`)
      assert.ok(pushedNodes.includes('node-online-2'), `node-online-2 should still be pushed even when node-online-1 throws, got: ${JSON.stringify(pushedNodes)}`)
    } finally { await dispose() }
  }
})


// --- 1A6-dsh-home: rt.dshHome missing → DSH_HOME env fallback → credentials.yaml written ---
// Knife: resolveDshHome returns rt.dshHome only (no env fallback) → RED
test('1A6-dsh-home: rt.dshHome missing falls back to DSH_HOME env, credentials.yaml gets GATEWAY_TOKEN_', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-1a6-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })
  writeFileSync(join(tmpHome, 'settings.yaml'), [
    'schema: 2',
    'ds-bot:',
    '  gatewayHost: 127.0.0.1',
    '  gatewayPort: 0',
  ].join('\n') + '\n')

  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
  ]

  // rt.dshHome is NOT set (undefined) — resolveDshHome must fall back to DSH_HOME env
  const { rt, getSetSource, getProvidedPort, dispose } = makeRt({
    gatewayPort: 0,
    env: { DSH_HOME: tmpHome, DS_BOT_GATEWAY_PORT: '0' },
  })
  rt.ctx.get('settings').describe = () => settingsSections
  rt.ctx.llm.listConfigurableProviders = () => cfgProviders
  rt.dshHome = undefined  // force fallback to DSH_HOME env

  install(rt)
  await new Promise(r => setTimeout(r, 150))
  try {
    const port = getProvidedPort()
    assert.ok(typeof port === 'number' && port > 0, `gateway should have started, got ${port}`)
    const cb = getSetSource()
    assert.ok(cb, 'setSource callback should be captured')
    // Trigger ensureToken by calling source with a nodeId
    const payload = cb('node-test')
    const alpha = payload.providers.find(p => p.id === 'alpha')
    assert.ok(alpha, 'alpha provider should be in payload')
    // apiKeyEnv should be a GATEWAY_TOKEN_ ref (gateway was active) — proves resolveDshHome
    // found the credentials.yaml from DSH_HOME env and read ALPHA_KEY successfully
    assert.ok(alpha.apiKeyEnv.startsWith('GATEWAY_TOKEN_'), `apiKeyEnv should be GATEWAY_TOKEN_*, got: ${alpha.apiKeyEnv}`)
    // apiKey should be non-empty (token generated because DSH_HOME env was used to read creds)
    assert.ok(typeof alpha.apiKey === 'string' && alpha.apiKey !== '', `apiKey should be non-empty token, got: ${alpha.apiKey}`)
  } finally { await dispose() }
})

// --- 1A6-yaml-source: settings.yaml fallback logs 'from=yaml:<path>' ---
// Knife: delete 'from' from log → RED
test('1A6-yaml-source: yaml fallback logs from=yaml:<path> in warn', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-1a6-yaml-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })
  writeFileSync(join(tmpHome, 'settings.yaml'), [
    'schema: 2',
    'ds-bot:',
    '  gatewayHost: 127.0.0.1',
    '  gatewayPort: 0',
  ].join('\n') + '\n')

  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
  ]

  const { rt, warns, dispose } = makeRt({ gatewayPort: 0 })
  rt.ctx.get('settings').describe = () => settingsSections
  rt.ctx.llm.listConfigurableProviders = () => cfgProviders
  rt.dshHome = tmpHome

  install(rt)
  await new Promise(r => setTimeout(r, 150))
  try {
    // Look for the gateway config warn with from=yaml:
    // warns entries are arrays: [formatString, ...args]. from= is at arg index 3.
    const configWarn = warns.find(w => typeof w[0] === 'string' && w[0].includes('gateway config host='))
    assert.ok(configWarn, `should log 'gateway config ...' warn, got: ${JSON.stringify(warns)}`)
    const fromValue = configWarn[3] || ''
    assert.ok(String(fromValue).includes('yaml:'), `from should contain 'yaml:' indicating yaml fallback, got: ${fromValue}`)
    assert.ok(String(fromValue).includes(tmpHome), `from should contain the settings.yaml path, got: ${fromValue}`)
  } finally { await dispose() }
})

// --- 1A6-repush: gateway-ready triggers second push with gateway non-null ---
// Knife: delete gateway-ready repush → RED
test('1A6-repush: gateway ready after attach → repush sends gateway baseURL to nodes', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-1a6-repush-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n  ALPHA_KEY: sk-alpha\n', { mode: 0o600 })

  const cfgProviders = [
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  const settingsSections = [
    { ns: 'llm-pi-ai', value: { providers: { alpha: { api: 'openai-completions', baseURL: 'https://up.example.com/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }], gateway: true } } } },
    { ns: 'ds-bot', value: { gatewayPort: 0, gatewayHost: '127.0.0.1' } },
  ]

  const pushCalls = []
  const mockService = {
    setSource: cb => { mockService._cb = cb },
    sendPush: (nodeId) => { pushCalls.push(nodeId); return true },
  }
  const mockRegistry = {
    onlineNodes: () => [{ nodeId: 'node-repush-1' }],
  }

  const { rt, dispose } = makeRt({ gatewayPort: 0 })
  rt.ctx.get('settings').describe = () => settingsSections
  rt.ctx.llm.listConfigurableProviders = () => cfgProviders
  rt.dshHome = tmpHome
  rt.ctx.get = (name) => {
    if (name === 'settings') return { describe: () => settingsSections }
    if (name === 'remote-agent:config-sync') return mockService
    if (name === 'remote-agent:registry') return mockRegistry
    return undefined
  }

  install(rt)
  // Wait long enough for both attach and gateway-ready to fire
  await new Promise(r => setTimeout(r, 250))
  try {
    // sendPush should have been called at least twice: once for 'attach', once for 'gateway-ready'
    assert.ok(pushCalls.length >= 2, `sendPush should be called at least twice (attach + gateway-ready), got: ${pushCalls.length}`)
    // The source callback should now return gateway non-null (actualPort is set)
    const cb = mockService._cb
    assert.ok(cb, 'setSource callback should be captured')
    const payload = cb('node-repush-1')
    const alpha = payload.providers.find(p => p.id === 'alpha')
    assert.ok(alpha, 'alpha provider should be in payload')
    assert.ok(alpha.baseURL && alpha.baseURL.includes('/gw/alpha/v1'), `baseURL should be gateway-rewritten, got: ${alpha.baseURL}`)
    assert.ok(alpha.apiKeyEnv && alpha.apiKeyEnv.startsWith('GATEWAY_TOKEN_'), `apiKeyEnv should be GATEWAY_TOKEN_*, got: ${alpha.apiKeyEnv}`)
  } finally { await dispose() }
})
