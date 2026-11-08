// Tests for src/host/config-source.js: the payload main DSH pushes to remote nodes.
// They import the product functions; the settings / llm / remote-agent services are fakes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { buildConfigPayload, install, parseCredentialRefs } from '../src/host/config-source.js'

const KEY_A = 'sk-AAAA-secret-value-1111'
const KEY_B = 'sk-BBBB-secret-value-2222'

function makeRt({ profiles, entries, refs, defaultBotModel } = {}) {
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
  const rt = {
    ctx,
    dshHome: '/nonexistent',
    warn: (...args) => warns.push(format(...args)),
    defaultBotModel,
  }
  return { rt, warns, store, readRefs: () => new Map(Object.entries(refs ?? {})) }
}

const PROFILES = {
  alpha: { api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'm1', name: 'Model 1' }, { id: 'm2' }] },
  beta: { api: 'anthropic-messages', apiKeyEnv: 'BETA_KEY', models: [{ id: 'b1', name: 'B One' }] },
  nokey: { api: 'openai-completions', baseURL: 'https://n.example', apiKeyEnv: 'NOKEY_KEY', models: [{ id: 'n1' }] },
}

test('1. payload shape: providers carry id/api/baseURL/apiKeyEnv/real apiKey/models', () => {
  const { rt, readRefs } = makeRt({ profiles: PROFILES, refs: { ALPHA_KEY: KEY_A, BETA_KEY: KEY_B } })
  const payload = buildConfigPayload(rt, { defaultModel: 'alpha/m1', readRefs })
  assert.equal(payload.defaultModel, 'alpha/m1')
  assert.deepEqual(payload.providers.map(p => p.id), ['alpha', 'beta'])
  assert.deepEqual(payload.providers[0], {
    id: 'alpha', api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', apiKey: KEY_A,
    models: [{ id: 'm1', name: 'Model 1' }, { id: 'm2', name: 'm2' }],
  })
  assert.equal('baseURL' in payload.providers[1], false, 'no baseURL → no key, not an empty string')
  assert.equal(payload.providers[1].apiKey, KEY_B)
  assert.equal('revision' in payload, false, 'the hub adds the revision')
})

test('2. a provider without a key (or without a protocol / a valid id) is skipped, not pushed half-made', () => {
  const profiles = {
    ...PROFILES,
    noapi: { apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'x' }] },
    'bad id': { api: 'openai-completions', apiKeyEnv: 'ALPHA_KEY' },
    noref: { api: 'openai-completions', models: [{ id: 'x' }] },
  }
  const { rt, warns, readRefs } = makeRt({ profiles, refs: { ALPHA_KEY: KEY_A, BETA_KEY: KEY_B } })
  const payload = buildConfigPayload(rt, { readRefs })
  assert.deepEqual(payload.providers.map(p => p.id), ['alpha', 'beta'])
  assert.equal(payload.defaultModel, null)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /skipped 4 provider/)
})

test('3. entries of another settings namespace are ignored', () => {
  const entries = [
    { provider: 'deepseek-official', settingsNs: 'llm-deepseek-api-key', settingsPath: [] },
    { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
  ]
  const { rt, readRefs } = makeRt({ profiles: PROFILES, entries, refs: { ALPHA_KEY: KEY_A } })
  assert.deepEqual(buildConfigPayload(rt, { readRefs }).providers.map(p => p.id), ['alpha'])
})

test('4. no settings service / no llm: empty payload, no throw', () => {
  const rt = { ctx: { get: () => undefined, llm: {} }, dshHome: '/nonexistent' }
  assert.deepEqual(buildConfigPayload(rt, { readRefs: () => new Map() }), { providers: [], defaultModel: null })
})

test('5. the key never reaches a log line or an error message', () => {
  const profiles = { ...PROFILES, noapi: { apiKeyEnv: 'ALPHA_KEY' } }
  const { rt, warns, readRefs } = makeRt({ profiles, refs: { ALPHA_KEY: KEY_A, BETA_KEY: KEY_B } })
  buildConfigPayload(rt, { defaultModel: 'alpha/m1', readRefs })
  rt.ctx.get = () => ({ describe: () => { throw new Error('settings broke') } })
  assert.throws(() => buildConfigPayload(rt, { readRefs }), (err) => {
    assert.equal(String(err.message + err.stack).includes(KEY_A), false)
    return true
  })
  for (const line of warns) {
    assert.equal(line.includes(KEY_A), false, 'KEY_A in log: ' + line)
    assert.equal(line.includes(KEY_B), false, 'KEY_B in log: ' + line)
  }
  assert.ok(warns.length > 0, 'the skip was logged (ids/counts only)')
})

test('6. default readRefs reads refs: of $DSH_HOME/.credentials.yaml; records are not keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'cfgsrc-'))
  writeFileSync(join(home, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    '  ALPHA_KEY: ' + JSON.stringify(KEY_A),
    "  BETA_KEY: '" + KEY_B + "'",
    '  OTHER: |',
    '    multi',
    'records:',
    '  browser-session:',
    '    ALPHA_KEY: not-a-ref',
    '',
  ].join('\n'))
  const { rt } = makeRt({ profiles: PROFILES })
  rt.dshHome = home
  const payload = buildConfigPayload(rt)
  assert.deepEqual(payload.providers.map(p => [p.id, p.apiKey]), [['alpha', KEY_A], ['beta', KEY_B]])
})

test('7. parseCredentialRefs: quoted forms, plain values, block scalars skipped, other sections ignored', () => {
  const refs = parseCredentialRefs([
    'version: 1', 'refs:',
    '  A: "x\\"y"', "  B: 'it''s'", '  C: plain', '  D: |', '    block', '  E:',
    'records:', '  F: nope', '',
  ].join('\n'))
  assert.deepEqual([...refs], [['A', 'x"y'], ['B', "it's"], ['C', 'plain']])
})

test('8. install: remote-agent absent → no throw, no source', () => {
  const { rt } = makeRt({ profiles: PROFILES })
  assert.doesNotThrow(() => install(rt))
})

test('9. install: remote-agent present → setSource once; source is synchronous and carries the cached default model', async () => {
  const { rt, store } = makeRt({ profiles: PROFILES, defaultBotModel: async () => 'alpha/m1' })
  rt.dshHome = mkdtempSync(join(tmpdir(), 'cfgsrc-'))
  writeFileSync(join(rt.dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  ALPHA_KEY: ' + JSON.stringify(KEY_A) + '\n')
  const calls = []
  store['remote-agent:config-sync'] = { setSource: fn => calls.push(fn) }
  install(rt)
  assert.equal(calls.length, 1)
  await new Promise(resolve => setImmediate(resolve))
  const payload = calls[0]()
  assert.equal(typeof payload.then, 'undefined', 'the hub calls the source synchronously')
  assert.equal(payload.defaultModel, 'alpha/m1')
  assert.deepEqual(payload.providers.map(p => p.id), ['alpha'])
})

test('10. install: defaultBotModel failing → defaultModel null, no throw', async () => {
  const { rt, store } = makeRt({ profiles: PROFILES, defaultBotModel: async () => { throw new Error('catalog down') } })
  const calls = []
  store['remote-agent:config-sync'] = { setSource: fn => calls.push(fn) }
  install(rt)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0]().defaultModel, null)
})

test('11. install: remote-agent arriving later is attached on a later tick', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { rt, store } = makeRt({ profiles: PROFILES })
  const calls = []
  install(rt)
  assert.equal(calls.length, 0)
  store['remote-agent:config-sync'] = { setSource: fn => calls.push(fn) }
  t.mock.timers.tick(5_000)
  assert.equal(calls.length, 1)
  t.mock.timers.tick(5_000)
  assert.equal(calls.length, 1, 'attached once')
})
