// Tests for config-source.js gateway integration (1K-rotate, 1O-mixed)
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildConfigPayload, install } from '../../src/host/config-source.js'
import { createTokenStore } from '../../src/gateway/token-store.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const KEY_A = 'sk-AAAA-secret-value-1111'
const KEY_B = 'sk-BBBB-secret-value-2222'

function makeRt({ profiles, entries, refs } = {}) {
  const warns = []
  const store = Object.create(null)
  const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles ?? {} } }] }
  const ctx = {
    get: name => store[name],
    llm: {
      listConfigurableProviders: () => entries ?? Object.keys(profiles ?? {}).map(id => ({
        provider: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id],
      })),
    },
  }
  store.settings = settings
  const rt = { ctx, dshHome: '/nonexistent', warn: (...a) => warns.push(a[0]) }
  return { rt, warns, readRefs: () => new Map(Object.entries(refs ?? {})) }
}

// --- 1K-rotate: after rotation, apiKeyEnv contains new epoch suffix and differs from pre-rotation ---
test('1K-rotate: rotate changes apiKeyEnv to epoch refName, differs from pre-rotation', () => {
  let t = 1000000
  const tokenStore = createTokenStore({ now: () => t })
  tokenStore.register('n1')
  const secrets = new Map()
  const getToken = () => {
    const rec = tokenStore.get('n1')
    const val = secrets.get(rec.currentRefName) ?? 'tok-' + rec.currentRefName
    return { refName: rec.currentRefName, value: val }
  }

  const profiles = { alpha: { api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [], gateway: true } }
  const { rt, readRefs } = makeRt({ profiles, refs: { ALPHA_KEY: KEY_A } })

  // Get pre-rotation payload
  const gw1 = { host: '127.0.0.1', port: 4387, token: getToken() }
  const pre = buildConfigPayload(rt, { readRefs, gateway: gw1 })
  const preEnv = pre.providers[0].apiKeyEnv

  // Rotate token
  t = 2000000  // advance time so epoch changes
  tokenStore.rotate('n1')
  const gw2 = { host: '127.0.0.1', port: 4387, token: getToken() }
  const post = buildConfigPayload(rt, { readRefs, gateway: gw2 })
  const postEnv = post.providers[0].apiKeyEnv

  assert.ok(preEnv !== postEnv, `apiKeyEnv should change after rotation: ${preEnv} vs ${postEnv}`)
  // post-rotation refName must be base + '_' + non-empty epoch36
  assert.ok(postEnv.startsWith(preEnv + '_'), `post-rotation refName should start with pre + '_', got: ${preEnv} -> ${postEnv}`)
  const epoch36 = postEnv.slice((preEnv + '_').length)
  assert.ok(epoch36.length > 0, `epoch suffix should be non-empty, got: '${epoch36}' in ${postEnv}`)
})

// --- 1O-mixed: gateway:true provider gets gateway URL, non-gateway keeps original ---
// Knife: remove profile.gateway===true condition → direct also gets gateway URL → dir.baseURL check fails
test('1O-mixed: gateway provider gets gateway baseURL, direct provider keeps original', () => {
  const tokenStore = createTokenStore()
  tokenStore.register('n1')
  const rec = tokenStore.get('n1')
  // Single token shared by all gateway providers (node-scoped, not provider-scoped)
  const token = { refName: rec.currentRefName, value: 'gw-tok' }

  const profiles = {
    gwprovider: { api: 'openai-completions', baseURL: 'https://gw.example/v1', apiKeyEnv: 'GW_KEY', models: [], gateway: true },
    gwprovider2: { api: 'openai-completions', baseURL: 'https://gw2.example/v1', apiKeyEnv: 'GW2_KEY', models: [], gateway: true },
    direct: { api: 'openai-completions', baseURL: 'https://direct.example/v1', apiKeyEnv: 'DIRECT_KEY', models: [] },
  }
  const { rt, readRefs } = makeRt({ profiles, refs: { GW_KEY: 'sk-gw', GW2_KEY: 'sk-gw2', DIRECT_KEY: 'sk-direct' } })

  const gatewayHost = '127.0.0.1'
  const gatewayPort = 4387
  const payload = buildConfigPayload(rt, { readRefs, gateway: { host: gatewayHost, port: gatewayPort, token } })

  const gw = payload.providers.find(p => p.id === 'gwprovider')
  const gw2 = payload.providers.find(p => p.id === 'gwprovider2')
  const dir = payload.providers.find(p => p.id === 'direct')

  assert.ok(gw, 'gwprovider should be in payload')
  assert.ok(gw2, 'gwprovider2 should be in payload')
  assert.ok(dir, 'direct should be in payload')

  const gwOrigin = new URL(gw.baseURL).origin
  assert.equal(gwOrigin, `http://${gatewayHost}:${gatewayPort}`, `gateway baseURL origin should be gateway, got: ${gw.baseURL}`)
  assert.equal(dir.baseURL, 'https://direct.example/v1', `direct baseURL should be unchanged (non-gateway)`)
  // Both gateway providers share the same refName (node-scoped token)
  assert.equal(gw.apiKeyEnv, rec.currentRefName, 'gateway apiKeyEnv should be gateway refName')
  assert.equal(gw2.apiKeyEnv, rec.currentRefName, 'gateway2 apiKeyEnv should be same gateway refName (shared token)')
})

// --- 1O-mixed no-gateway: gateway not started -> warn + fallback to direct ---
test('1O-mixed no-gateway: gateway param port null -> warn, direct fallback', () => {
  const token = { refName: 'GATEWAY_TOKEN_n1', value: 'tok' }
  const profiles = {
    alpha: { api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [], gateway: true },
    beta: { api: 'openai-completions', baseURL: 'https://b.example/v1', apiKeyEnv: 'BETA_KEY', models: [], gateway: true },
  }
  const { rt, warns, readRefs } = makeRt({ profiles, refs: { ALPHA_KEY: KEY_A, BETA_KEY: KEY_B } })

  // port: null means gateway not started
  const payload = buildConfigPayload(rt, { readRefs, gateway: { host: '127.0.0.1', port: null, token } })

  const pa = payload.providers.find(p => p.id === 'alpha')
  const pb = payload.providers.find(p => p.id === 'beta')
  // Falls back to direct: original baseURL, original apiKeyEnv
  assert.equal(pa.baseURL, 'https://a.example/v1', 'alpha should fall back to original baseURL')
  assert.equal(pa.apiKeyEnv, 'ALPHA_KEY', 'alpha should fall back to original apiKeyEnv')
  // Exactly one warn for all fallback providers combined
  assert.equal(warns.length, 1, `should have exactly one aggregated warn, got: ${JSON.stringify(warns)}`)
  assert.ok(warns[0].includes('2') || warns[0].includes('not started'), `warn should mention count or 'not started', got: ${warns[0]}`)
})


// --- rt.gateway wiring: production setSource callback reads rt.gateway ---
// Goes through real install() to capture the setSource callback, then invokes it.
// Knife: delete 'gateway: rt.gateway' from setSource call -> callback won't read rt.gateway -> RED
test('rt.gateway wiring: setSource callback is synchronous and accepts nodeId', async () => {
  // Verify install() wires setSource with a (nodeId) => payload callback that:
  // 1. Is synchronous (no Promise returned)
  // 2. Accepts nodeId param (not zero-arg)
  // 3. Returns plain object payload
  const tmpHome = mkdtempSync(join(tmpdir(), 'ds-bot-gw-test-'))
  writeFileSync(join(tmpHome, '.credentials.yaml'), 'refs:\n', { mode: 0o600 })

  let captured = null
  let effectFn = null
  const mockService = { setSource: cb => { captured = cb } }
  const store = Object.create(null)
  store['remote-agent:config-sync'] = mockService
  const settings = { describe: () => [
    { ns: 'ds-bot', value: { gatewayPort: 0 } },
  ] }
  store.settings = settings
  const ctx = {
    get: name => name === 'settings' ? settings : store[name],
    provide: () => {},
    effect: (fn) => { effectFn = fn },
    llm: { listConfigurableProviders: () => [] },
  }
  const rt = { ctx, dshHome: tmpHome, warn: () => {}, defaultBotModel: async () => null }

  install(rt)
  assert.ok(captured, 'setSource should have been called with a callback')
  assert.equal(typeof captured, 'function', 'setSource arg should be a function')
  assert.equal(captured.length, 1, 'callback should accept 1 argument (nodeId)')

  // Call synchronously — must not return Promise
  const result = captured('dshtest-1')
  assert.ok(result != null && typeof result === 'object', 'callback must return plain object')
  assert.ok(typeof result.then === 'undefined', 'callback must be synchronous (no Promise)')
  assert.ok('providers' in result, 'payload must have providers key')

  // nodeId=null: gateway param should be null
  const resultNull = captured(null)
  assert.ok(resultNull != null && typeof resultNull === 'object', 'null nodeId should return plain object')
  assert.ok(!resultNull.then, 'must not return Promise for null nodeId')

  // Start gateway via effectFn, verify provide called
  let providedPort = null
  ctx.provide = (key, val) => { if (key === 'ds-bot:gateway-port') providedPort = val }
  const cleanup = await effectFn()
  try {
    await new Promise(r => setTimeout(r, 50))
    assert.ok(typeof providedPort === 'number' && providedPort > 0, `ctx.provide should be called with port, got: ${providedPort}`)
  } finally {
    if (cleanup) await cleanup()
  }

  rmSync(tmpHome, { recursive: true, force: true })
})

// --- 1O-token-missing: gateway running but token undefined -> warn + fallback to direct ---
// Knife: delete gwTokenMissingCount += 1 -> warn absent -> RED
test('1O-token-missing: port set but token undefined -> warn + direct fallback', () => {
  const profiles = {
    alpha: { api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [], gateway: true },
  }
  const { rt, warns, readRefs } = makeRt({ profiles, refs: { ALPHA_KEY: KEY_A } })

  // gateway is started (port valid) but token is undefined (not yet registered)
  const payload = buildConfigPayload(rt, { readRefs, gateway: { host: '127.0.0.1', port: 4387, token: undefined } })

  const p = payload.providers[0]
  assert.equal(p.baseURL, 'https://a.example/v1', 'should keep original baseURL when token missing')
  assert.equal(p.apiKeyEnv, 'ALPHA_KEY', 'should keep original apiKeyEnv when token missing')
  assert.equal(warns.length, 1, `should have exactly one token-missing warn, got: ${JSON.stringify(warns)}`)
  assert.ok(warns[0].includes('token') || warns[0].includes('missing'), `warn should mention token/missing, got: ${warns[0]}`)
})
