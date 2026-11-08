// Tests for config-source.js gateway integration (1K-rotate, 1O-mixed)
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildConfigPayload } from '../../src/host/config-source.js'
import { createTokenStore } from '../../src/gateway/token-store.js'

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
  const getTokensMap = () => {
    const m = new Map()
    const rec = tokenStore.get('n1')
    if (rec?.currentRefName) {
      const val = secrets.get(rec.currentRefName) ?? 'tok-' + rec.currentRefName
      m.set('alpha', { refName: rec.currentRefName, value: val })
    }
    return m
  }

  const profiles = { alpha: { api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [], gateway: true } }
  const { rt, readRefs } = makeRt({ profiles, refs: { ALPHA_KEY: KEY_A } })

  // Get pre-rotation payload
  const gw1 = { host: '127.0.0.1', port: 4387, tokens: getTokensMap() }
  const pre = buildConfigPayload(rt, { readRefs, gateway: gw1 })
  const preEnv = pre.providers[0].apiKeyEnv

  // Rotate token
  t = 2000000  // advance time so epoch changes
  tokenStore.rotate('n1')
  const gw2 = { host: '127.0.0.1', port: 4387, tokens: getTokensMap() }
  const post = buildConfigPayload(rt, { readRefs, gateway: gw2 })
  const postEnv = post.providers[0].apiKeyEnv

  assert.ok(preEnv !== postEnv, `apiKeyEnv should change after rotation: ${preEnv} vs ${postEnv}`)
  // post-rotation refName must be base + '_' + non-empty epoch36
  assert.ok(postEnv.startsWith(preEnv + '_'), `post-rotation refName should start with pre + '_', got: ${preEnv} -> ${postEnv}`)
  const epoch36 = postEnv.slice((preEnv + '_').length)
  assert.ok(epoch36.length > 0, `epoch suffix should be non-empty, got: '${epoch36}' in ${postEnv}`)
})

// --- 1O-mixed: one gateway provider, one direct provider ---
test('1O-mixed: gateway provider gets gateway baseURL, direct provider keeps original', () => {
  const tokenStore = createTokenStore()
  tokenStore.register('n1')
  const rec = tokenStore.get('n1')
  const tokens = new Map([['gwprovider', { refName: rec.currentRefName, value: 'gw-tok' }]])

  const profiles = {
    gwprovider: { api: 'openai-completions', baseURL: 'https://gw.example/v1', apiKeyEnv: 'GW_KEY', models: [], gateway: true },
    direct: { api: 'openai-completions', baseURL: 'https://direct.example/v1', apiKeyEnv: 'DIRECT_KEY', models: [] },
  }
  const { rt, readRefs } = makeRt({ profiles, refs: { GW_KEY: 'sk-gw', DIRECT_KEY: 'sk-direct' } })

  const gatewayHost = '127.0.0.1'
  const gatewayPort = 4387
  const payload = buildConfigPayload(rt, { readRefs, gateway: { host: gatewayHost, port: gatewayPort, tokens } })

  const gw = payload.providers.find(p => p.id === 'gwprovider')
  const dir = payload.providers.find(p => p.id === 'direct')

  assert.ok(gw, 'gwprovider should be in payload')
  assert.ok(dir, 'direct should be in payload')

  const gwOrigin = new URL(gw.baseURL).origin
  assert.equal(gwOrigin, `http://${gatewayHost}:${gatewayPort}`, `gateway baseURL origin should be gateway, got: ${gw.baseURL}`)
  assert.equal(dir.baseURL, 'https://direct.example/v1', `direct baseURL should be unchanged`)
  assert.equal(gw.apiKeyEnv, rec.currentRefName, 'gateway apiKeyEnv should be gateway refName')
})

// --- 1O-mixed no-gateway: gateway not started -> warn + fallback to direct ---
test('1O-mixed no-gateway: gateway param port null -> warn, direct fallback', () => {
  const tokens = new Map([['alpha', { refName: 'GATEWAY_TOKEN_n1', value: 'tok' }]])
  const profiles = {
    alpha: { api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [], gateway: true },
  }
  const { rt, warns, readRefs } = makeRt({ profiles, refs: { ALPHA_KEY: KEY_A } })

  // port: null means gateway not started
  const payload = buildConfigPayload(rt, { readRefs, gateway: { host: '127.0.0.1', port: null, tokens } })

  const p = payload.providers[0]
  // Falls back to direct: original baseURL, original apiKeyEnv
  assert.equal(p.baseURL, 'https://a.example/v1', 'should fall back to original baseURL')
  assert.equal(p.apiKeyEnv, 'ALPHA_KEY', 'should fall back to original apiKeyEnv')
  assert.ok(warns.some(w => w.includes('alpha') || w.includes('not started')), `should warn for provider alpha, got: ${JSON.stringify(warns)}`)
})
