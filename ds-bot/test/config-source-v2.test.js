// P1b-1 (ds-bot side): the schema:2 config-sync payload, and which node gets it.
// Behaviour tests over the real buildConfigPayload / install; settings, llm and the remote-agent
// registry are fakes. One test also feeds the produced plugin to the REAL node validator when the
// remote-agent checkout is available (DSH_REMOTE_AGENT, default /tmp/ra-p1b), because "the payload the
// source builds is accepted by the node" is the contract this slice exists for.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { format } from 'node:util'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { buildConfigPayload, install } from '../src/host/config-source.js'
import { isLoopback, nodeSpeaksV2 } from '../src/host/config-v2.js'

const DS_KEY = 'sk-DEEPSEEK-secret-value-9999'
const PI_KEY = 'sk-PIAI-secret-value-7777'

const DS_ENTRY = { provider: 'deepseek-official', settingsNs: 'llm-deepseek-api-key', settingsPath: [] }
const PI_ENTRY = { provider: 'alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] }
const XAI_ENTRY = { provider: 'xai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'xai'], defaultBaseURL: 'https://api.x.ai/v1', nativeAuth: { env: ['XAI_API_KEY'] } }

// What `settings.describe()` holds for the main's deepseek plugin: the whitelisted fields plus tuning knobs the node must not get.
const DS_SECTION = {
  baseURL: 'https://api.deepseek.com/anthropic',
  thinking: 'enabled',
  reasoningEffort: 'high',
  maxTokens: 32000,
  defaultContextWindow: 1000000,
  streamIdleTimeoutMs: 120000,
  retryPolicy: { mode: 'normal', maxRetries: 4, retryableCodes: ['429', '503'], backoff: { initialDelayMs: 500, maxDelayMs: 20000, jitterRatio: 0.2 } },
  models: [
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1000000, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only', imagePixelBudget: 'low', imageMaxBytes: 9999 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Stronger.', contextWindow: 1000000, inputModalities: ['text'] },
  ],
  // tuning knobs that must stay on the main
  maxRequestFilesBytes: 1, maxInlineRequestImageBytes: 2, maxImagesPerRequest: 600, imageOffloadByteQuantum: 3, filesApiTimeoutMs: 4, fileExpiresAfterSeconds: 3600,
}
const PI_PROFILE = {
  api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', displayName: 'Alpha', streamIdleTimeoutMs: 90000,
  compat: { supportsStore: false, maxTokensField: 'max_tokens' }, headers: { 'X-Secret': 'must-never-travel' },
  models: [{ id: 'm1', name: 'Model 1', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'], reasoningEfforts: { low: 'low', high: 'high' } }, { id: 'm2' }],
}

function makeRt({ deepseek = DS_SECTION, refs = { DEEPSEEK_API_KEY: DS_KEY, ALPHA_KEY: PI_KEY }, entries, pi = { alpha: PI_PROFILE } } = {}) {
  const warns = []
  const store = Object.create(null)
  const sections = [{ ns: 'llm-pi-ai', value: { providers: pi } }]
  if (deepseek !== null) sections.push({ ns: 'llm-deepseek-api-key', value: deepseek })
  store.settings = { describe: () => sections }
  const rt = {
    ctx: { get: name => store[name], llm: { listConfigurableProviders: () => entries ?? [DS_ENTRY, ...Object.keys(pi).map(id => ({ provider: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id] }))] } },
    dshHome: '/nonexistent',
    warn: (...args) => warns.push(format(...args)),
  }
  return { rt, warns, store, readRefs: () => new Map(Object.entries(refs)) }
}

// ── the v2 payload ──────────────────────────────────────────────────────────

test('P1b1-v2-shape: schema:2 carries plugins[] (whitelisted deepseek config + key), cliExpect [], completed provider models', () => {
  const { rt, readRefs } = makeRt()
  const payload = buildConfigPayload(rt, { readRefs, schema: 2 })
  assert.equal(payload.schema, 2)
  assert.deepEqual(payload.cliExpect, [])
  assert.deepEqual(payload.plugins, [{
    entryId: 'llm-deepseek',
    name: '@deepseek-ai/dsh-llm-deepseek-api-key',
    config: {
      thinking: 'enabled', reasoningEffort: 'high', maxTokens: 32000, defaultContextWindow: 1000000, streamIdleTimeoutMs: 120000,
      retryPolicy: DS_SECTION.retryPolicy,
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1000000, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Stronger.', contextWindow: 1000000, inputModalities: ['text'] },
      ],
    },
    credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: DS_KEY }],
  }])
  // deepseek-official is a plugin, not a pi-ai route
  assert.deepEqual(payload.providers.map(p => p.id), ['alpha'])
  const alpha = payload.providers[0]
  assert.deepEqual(alpha.models, [
    { id: 'm1', name: 'Model 1', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'], reasoningEfforts: { low: 'low', high: 'high' } },
    { id: 'm2', name: 'm2' },
  ])
  assert.equal(alpha.displayName, 'Alpha')
  assert.equal(alpha.streamIdleTimeoutMs, 90000)
  assert.deepEqual(alpha.compat, { supportsStore: false, maxTokensField: 'max_tokens' })
  assert.equal('headers' in alpha, false, 'custom headers can hold a secret: never synced')
  assert.equal(JSON.stringify(payload).includes('must-never-travel'), false)
})

test('P1b1-v2-trim: tuning knobs and unknown keys stay on the main; the official baseURL is not sent, a custom reachable one is', () => {
  const { rt, readRefs } = makeRt()
  const official = buildConfigPayload(rt, { readRefs, schema: 2 }).plugins[0].config
  for (const knob of ['maxRequestFilesBytes', 'maxInlineRequestImageBytes', 'maxImagesPerRequest', 'imageOffloadByteQuantum', 'filesApiTimeoutMs', 'fileExpiresAfterSeconds', 'baseURL']) assert.equal(knob in official, false, knob)
  for (const model of official.models) { assert.equal('imagePixelBudget' in model, false); assert.equal('imageMaxBytes' in model, false) }

  const custom = makeRt({ deepseek: { ...DS_SECTION, baseURL: 'https://proxy.example.com/anthropic' } })
  assert.equal(buildConfigPayload(custom.rt, { readRefs: custom.readRefs, schema: 2 }).plugins[0].config.baseURL, 'https://proxy.example.com/anthropic')
  const loopback = makeRt({ deepseek: { ...DS_SECTION, baseURL: 'http://127.0.0.1:8795' } })
  assert.equal('baseURL' in buildConfigPayload(loopback.rt, { readRefs: loopback.readRefs, schema: 2 }).plugins[0].config, false, "the main's own loopback is not an endpoint the node can reach")
})

test('P1b1-v2-sanitize: a value the node would refuse is dropped here (it would reject the whole push), counted in the log, never printed', () => {
  const bad = { ...DS_SECTION, thinking: 'disabled', reasoningEffort: 'high', maxTokens: -5, streamIdleTimeoutMs: 'soon', retryPolicy: { mode: 'sometimes' },
    models: [{ id: 'ok', inputModalities: ['text', 'audio'], contextWindow: 0 }, { id: 'ok' }, { id: '' }, 'junk'] }
  const { rt, warns, readRefs } = makeRt({ deepseek: bad })
  const config = buildConfigPayload(rt, { readRefs, schema: 2 }).plugins[0].config
  assert.equal(config.thinking, 'disabled')
  assert.equal('reasoningEffort' in config, false, 'thinking off with effort high would make the node plugin throw at start')
  for (const k of ['maxTokens', 'streamIdleTimeoutMs', 'retryPolicy']) assert.equal(k in config, false, k)
  assert.deepEqual(config.models, [{ id: 'ok' }], 'bad modalities / zero window / duplicate / empty id / junk are dropped per field or per model')
  const line = warns.find(w => /dropped \d+ plugin config field/.test(w))
  assert.ok(line, 'a count line is logged')
  for (const w of warns) { assert.equal(w.includes(DS_KEY), false); assert.equal(w.includes('DEEPSEEK_API_KEY'), false) }
})

test('P1b1-v2-no-key: deepseek configured but no key → plugins is empty (the node then deletes the ref and entry it owns)', () => {
  const { rt, readRefs } = makeRt({ refs: { ALPHA_KEY: PI_KEY } })
  assert.deepEqual(buildConfigPayload(rt, { readRefs, schema: 2 }).plugins, [])
})

test('P1b1-v2-no-section: no deepseek section at all → plugins is empty, providers unchanged', () => {
  const { rt, readRefs } = makeRt({ deepseek: null, entries: [PI_ENTRY] })
  const payload = buildConfigPayload(rt, { readRefs, schema: 2 })
  assert.deepEqual(payload.plugins, [])
  assert.deepEqual(payload.providers.map(p => p.id), ['alpha'])
})

test('P1b1-v2-own-ref: a main that keeps its key under another ref name still ships it as DEEPSEEK_API_KEY (the node plugin reads that one)', () => {
  const { rt, readRefs } = makeRt({ deepseek: { ...DS_SECTION, apiKeyEnv: 'MY_DS_KEY' }, refs: { MY_DS_KEY: DS_KEY } })
  assert.deepEqual(buildConfigPayload(rt, { readRefs, schema: 2 }).plugins[0].credentialRefs, [{ ref: 'DEEPSEEK_API_KEY', apiKey: DS_KEY }])
})

test('P1b1-v2-catalog: a catalog route completed from pi-ai (xai) is flagged catalog:true in v2 and still pushed', () => {
  const { rt, readRefs } = makeRt({ entries: [XAI_ENTRY], pi: { xai: { models: [{ id: 'grok-4.3', name: 'Grok 4.3' }] } }, refs: { XAI_API_KEY: PI_KEY } })
  const [xai] = buildConfigPayload(rt, { readRefs, schema: 2 }).providers
  assert.equal(xai.id, 'xai')
  assert.equal(xai.catalog, true)
  assert.equal(xai.api, 'openai-responses')
})

test('P1b1-v2-log: no log line of a v2 build contains a key', () => {
  const { rt, warns, readRefs } = makeRt({ entries: [DS_ENTRY, PI_ENTRY, XAI_ENTRY], pi: { alpha: PI_PROFILE, xai: { models: [{ id: 'g' }] } }, refs: { DEEPSEEK_API_KEY: DS_KEY, ALPHA_KEY: PI_KEY } })
  buildConfigPayload(rt, { readRefs, schema: 2 })
  for (const w of warns) for (const key of [DS_KEY, PI_KEY]) assert.equal(w.includes(key), false, w)
})

// ── which node gets which version ───────────────────────────────────────────

function installed({ caps, registry = 'present' } = {}) {
  const made = makeRt()
  made.rt.dshHome = mkdtempSync(join(tmpdir(), 'cfgv2-'))
  writeFileSync(join(made.rt.dshHome, '.credentials.yaml'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${JSON.stringify(DS_KEY)}\n  ALPHA_KEY: ${JSON.stringify(PI_KEY)}\n`)
  const calls = []
  made.store['remote-agent:config-sync'] = { setSource: fn => calls.push(fn) }
  if (registry === 'present') made.store['remote-agent:registry'] = { getNode: id => (id === 'n-known' ? { nodeId: id, hello: { caps } } : undefined), onlineNodes: () => [] }
  if (registry === 'throws') made.store['remote-agent:registry'] = { getNode() { throw new Error('registry down') }, onlineNodes: () => [] }
  install(made.rt)
  return { source: calls[0], ...made }
}

test('P1b1-v1-compat: a node without the config-sync/2 cap (or an unknown node, no registry, a throwing registry) gets exactly the v1 payload', () => {
  const V1_KEYS = ['defaultModel', 'providers']
  for (const [label, opts, nodeId] of [
    ['old node', { caps: ['fs', 'exec', 'artifact', 'agent'] }, 'n-known'],
    ['node with no caps field', { caps: undefined }, 'n-known'],
    ['unknown node', { caps: ['config-sync/2'] }, 'n-unknown'],
    ['no node id', { caps: ['config-sync/2'] }, undefined],
    ['no registry', { registry: 'none' }, 'n-known'],
    ['registry throws', { registry: 'throws' }, 'n-known'],
  ]) {
    const { source } = installed(opts)
    const payload = source(nodeId)
    assert.deepEqual(Object.keys(payload).sort(), V1_KEYS, label)
    assert.deepEqual(payload.providers.map(p => p.id), ['alpha'], label)
    assert.deepEqual(Object.keys(payload.providers[0]).sort(), ['api', 'apiKey', 'apiKeyEnv', 'baseURL', 'id', 'models'], `${label}: v1 providers carry none of the v2 fields`)
    assert.deepEqual(payload.providers[0].models[0], { id: 'm1', name: 'Model 1' }, `${label}: v1 models stay {id,name}`)
    assert.equal(JSON.stringify(payload).includes(DS_KEY), false, `${label}: the deepseek key is not pushed to a node that cannot place it`)
  }
})

test('P1b1-v2-negotiated: a node whose hello announced config-sync/2 gets schema:2 with the deepseek plugin and its key', () => {
  const { source } = installed({ caps: ['fs', 'exec', 'config-sync/2'] })
  const payload = source('n-known')
  assert.equal(payload.schema, 2)
  assert.equal(payload.plugins.length, 1)
  assert.deepEqual(payload.plugins[0].credentialRefs, [{ ref: 'DEEPSEEK_API_KEY', apiKey: DS_KEY }])
})

// ── what the node really accepts ────────────────────────────────────────────

const RA = process.env.DSH_REMOTE_AGENT ?? '/tmp/ra-p1b'
const RA_VALIDATOR = join(RA, 'lib/node/config-managed.js')
// A run without the remote-agent checkout must SAY so: these tests are the only place the node side of the contract is checked.
// DSH_REQUIRE_REMOTE_AGENT=1 (CI) turns the skip into a failure.
const NO_RA = `remote-agent checkout not found at ${RA} (set DSH_REMOTE_AGENT): the NODE side of the payload contract is NOT checked in this run`
const skipWithoutRa = (...paths) => (paths.every(path => existsSync(path)) || process.env.DSH_REQUIRE_REMOTE_AGENT === '1' ? false : NO_RA)

test('P1b1-v2-node-accepts: the plugin the source builds passes the real node validator (and a bad one is what the node would refuse)', { skip: skipWithoutRa(RA_VALIDATOR) }, async () => {
  const { validatePlugins } = await import(pathToFileURL(RA_VALIDATOR).href)
  for (const section of [DS_SECTION, {}, { ...DS_SECTION, baseURL: 'https://proxy.example.com/anthropic', thinking: 'disabled', reasoningEffort: 'high' },
    { ...DS_SECTION, models: [{ id: 'x', inputModalities: ['audio'] }, 'junk'], retryPolicy: { mode: 'always', backoff: { jitterRatio: 5 } } }]) {
    const { rt, readRefs } = makeRt({ deepseek: section })
    const { plugins } = buildConfigPayload(rt, { readRefs, schema: 2 })
    const accepted = validatePlugins(plugins)
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0].entryId, 'llm-deepseek')
  }
  // control: the untrimmed section is exactly what the node refuses, so the test can fail
  assert.throws(() => validatePlugins([{ entryId: 'llm-deepseek', config: DS_SECTION, credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: DS_KEY }] }]), /plugin-config-invalid|maxRequestFilesBytes|config/)
})

const RA_SYNC = join(RA, 'lib/node/config-sync.js')
const RA_HASH = join(RA, 'lib/hub/stable-hash.js')

test('P1b1-e2e: real source → real hub revision → real node apply: the key lands 0600, the entry has no key; revoking the key removes both', { skip: skipWithoutRa(RA_SYNC, RA_HASH) }, async () => {
  const { handleConfigPush } = await import(pathToFileURL(RA_SYNC).href)
  const { computeRevision } = await import(pathToFileURL(RA_HASH).href)
  const home = mkdtempSync(join(tmpdir(), 'cfgv2-e2e-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const logs = []
  const apply = (refs) => {
    const { rt, readRefs } = makeRt({ refs })
    const payload = buildConfigPayload(rt, { readRefs, schema: 2 })
    const revision = computeRevision(payload)
    const acks = []
    const result = handleConfigPush({ data: { ...payload, revision }, dshHome: home, profileDir, send: (type, ack) => acks.push(ack), logger: (...a) => logs.push(format(...a)), _restartFn() {} })
    return { result, acks, payload }
  }
  const cred = join(home, '.credentials.yaml')
  const patch = join(profileDir, 'cordis.patch.yml')

  const first = apply({ DEEPSEEK_API_KEY: DS_KEY, ALPHA_KEY: PI_KEY })
  assert.equal(first.acks.at(-1)?.ok, true, JSON.stringify(first.acks))
  assert.match(readFileSync(cred, 'utf8'), /DEEPSEEK_API_KEY:/)
  assert.equal(statSync(cred).mode & 0o777, 0o600)
  const patchText = readFileSync(patch, 'utf8')
  assert.match(patchText, /- id: llm-deepseek/)
  assert.match(patchText, /name: "@deepseek-ai\/dsh-llm-deepseek-api-key"/)
  assert.equal(patchText.includes(DS_KEY), false, 'the key is in the credentials file only')
  assert.match(patchText, /id: \"deepseek-flash\"/)

  // the main drops the deepseek key: the next payload has no plugin, the node removes what it owns
  const second = apply({ ALPHA_KEY: PI_KEY })
  assert.equal(second.payload.plugins.length, 0)
  assert.equal(second.acks.at(-1)?.ok, true, JSON.stringify(second.acks))
  assert.equal(/DEEPSEEK_API_KEY:/.test(readFileSync(cred, 'utf8')), false, 'revoked key is gone from the node')
  assert.equal(/- id: llm-deepseek/.test(readFileSync(patch, 'utf8')), false, 'its entry is gone too')
  for (const line of logs) for (const key of [DS_KEY, PI_KEY]) assert.equal(line.includes(key), false, 'the node log never holds a key')
})

// ═══ P1b-2 prestage (acceptance round 2) ═══

const PI_DEEPSEEK_ENTRY = { provider: 'deepseek', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'deepseek'], defaultBaseURL: 'https://api.deepseek.com/v1', nativeAuth: { env: ['DEEPSEEK_API_KEY'] } }
const PI_DS_KEY = 'sk-PIAI-DEEPSEEK-route-value-5555'

function clash({ sameValue = false } = {}) {
  return makeRt({
    deepseek: { ...DS_SECTION, apiKeyEnv: 'MY_DS_KEY' },
    entries: [DS_ENTRY, PI_DEEPSEEK_ENTRY, PI_ENTRY],
    pi: { deepseek: { models: [{ id: 'deepseek-chat' }] }, alpha: PI_PROFILE },
    refs: { MY_DS_KEY: DS_KEY, DEEPSEEK_API_KEY: sameValue ? DS_KEY : PI_DS_KEY, ALPHA_KEY: PI_KEY },
  })
}

test('P1b2-clash: a pi-ai deepseek route (native ref DEEPSEEK_API_KEY) and deepseek-official under another ref with a different value: the route is left out, the plugin keeps the ref, the count is logged', () => {
  const { rt, warns, readRefs } = clash()
  const payload = buildConfigPayload(rt, { readRefs, schema: 2 })
  assert.deepEqual(payload.providers.map(p => p.id), ['alpha'], 'the clashing route is left out, the others stay')
  assert.deepEqual(payload.plugins[0].credentialRefs, [{ ref: 'DEEPSEEK_API_KEY', apiKey: DS_KEY }])
  assert.ok(warns.some(w => /left out 1 provider\(s\) whose credential ref clashes/.test(w)), warns.join('\n'))
  for (const w of warns) for (const key of [DS_KEY, PI_DS_KEY, PI_KEY]) assert.equal(w.includes(key), false, w)
})

test('P1b2-clash-none: the same ref with the SAME value is not a clash (nothing is dropped)', () => {
  const { rt, readRefs } = clash({ sameValue: true })
  assert.deepEqual(buildConfigPayload(rt, { readRefs, schema: 2 }).providers.map(p => p.id), ['deepseek', 'alpha'])
})

test('P1b2-clash-v1: a v1 payload has no plugins, so no clash handling and no provider is dropped', () => {
  const { rt, readRefs } = clash()
  assert.deepEqual(buildConfigPayload(rt, { readRefs }).providers.map(p => p.id), ['deepseek', 'alpha'])
})

test('P1b2-clash-node: what the source builds for a clashing config is accepted by the real node (without the guard the node rejects the whole push)', { skip: skipWithoutRa(RA_SYNC, RA_HASH) }, async () => {
  const { handleConfigPush } = await import(pathToFileURL(RA_SYNC).href)
  const { computeRevision } = await import(pathToFileURL(RA_HASH).href)
  const home = mkdtempSync(join(tmpdir(), 'cfgv2-clash-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const { rt, readRefs } = clash()
  const payload = buildConfigPayload(rt, { readRefs, schema: 2 })
  const acks = []
  handleConfigPush({ data: { ...payload, revision: computeRevision(payload) }, dshHome: home, profileDir, send: (type, ack) => acks.push(ack), logger() {}, _restartFn() {}, _systemd: false })
  assert.equal(acks.at(-1)?.ok, true, JSON.stringify(acks.at(-1)))
  assert.match(readFileSync(join(home, '.credentials.yaml'), 'utf8'), new RegExp(`DEEPSEEK_API_KEY: ${DS_KEY}`))
})

test('P1b2-loopback: the main\'s own endpoints (127.x, 0.0.0.0, [::], [::1], localhost, *.localhost, [::ffff:127.0.0.1]) are not sent and are counted; a reachable one is sent', () => {
  for (const url of ['http://127.0.0.1:8795', 'http://0.0.0.0:8795', 'http://[::ffff:127.0.0.1]:8795', 'http://[::1]:8795', 'http://[::]:8795', 'http://localhost:8795', 'http://proxy.localhost:8795', 'http://127.1:8795']) {
    const { rt, warns, readRefs } = makeRt({ deepseek: { ...DS_SECTION, baseURL: url } })
    const config = buildConfigPayload(rt, { readRefs, schema: 2 }).plugins[0].config
    assert.equal('baseURL' in config, false, url)
    assert.ok(warns.some(w => /did not send 1 baseURL\(s\) that point at the main itself/.test(w)), `${url}: ${warns.join('|')}`)
    for (const w of warns) assert.equal(w.includes('8795'), false, 'the URL itself is never logged')
  }
  for (const url of ['http://192.168.1.5:8795', 'http://[::ffff:8.8.8.8]:8795', 'https://proxy.example.com/anthropic']) {
    const { rt, warns, readRefs } = makeRt({ deepseek: { ...DS_SECTION, baseURL: url } })
    assert.equal(buildConfigPayload(rt, { readRefs, schema: 2 }).plugins[0].config.baseURL, url)
    assert.equal(warns.some(w => /point at the main itself/.test(w)), false, url)
  }
  assert.equal(isLoopback('[::ffff:7f00:1]'), true)
  assert.equal(isLoopback('example.com'), false)
})

test('P1b2-log-fields: provider/model fields the node cannot take (and headers, never synced) are counted in one log line, never printed', () => {
  const pi = { alpha: { ...PI_PROFILE, displayName: 12345, streamIdleTimeoutMs: -1, models: [{ id: 'm1', contextWindow: 0, maxTokens: 'big', input: ['audio'], reasoningEfforts: 'x' }] } }
  const { rt, warns, readRefs } = makeRt({ pi, refs: { DEEPSEEK_API_KEY: DS_KEY, ALPHA_KEY: PI_KEY } })
  buildConfigPayload(rt, { readRefs, schema: 2 })
  // displayName, streamIdleTimeoutMs, headers (3) + contextWindow, maxTokens, input, reasoningEfforts (4)
  assert.ok(warns.some(w => /left out 7 provider\/model field\(s\)/.test(w)), warns.join('|'))
  for (const w of warns) { assert.equal(w.includes('must-never-travel'), false); assert.equal(w.includes('12345'), false) }
})

test('P1b2-D8: a key with a control character is not sent from the main (the node would refuse the whole push) and is never logged', () => {
  for (const bad of ['sk-line\nbreak', 'sk-cr\rhere', 'sk-nul\u0000x', 'sk-del\u007fx', 'sk-tab\tx']) {
    const { rt, warns, readRefs } = makeRt({ refs: { DEEPSEEK_API_KEY: bad, ALPHA_KEY: PI_KEY } })
    assert.deepEqual(buildConfigPayload(rt, { readRefs, schema: 2 }).plugins, [], JSON.stringify(bad))
    for (const w of warns) assert.equal(w.includes('sk-'), false)
  }
})

test('P1b2-D1d: the cap match is exact — config-sync/10, config-sync/2.1, config-sync/2x, a bare string or a non-array is not config-sync/2', () => {
  for (const caps of [['config-sync/10'], ['config-sync/2.1'], ['config-sync/2x'], ['xconfig-sync/2'], ['config-sync/20', 'config-sync/3'], 'config-sync/2', { 0: 'config-sync/2', length: 1 }, null, undefined, []]) {
    assert.equal(nodeSpeaksV2(caps), false, JSON.stringify(caps))
  }
  assert.equal(nodeSpeaksV2(['fs', 'config-sync/2']), true)
  const { source } = installed({ caps: ['config-sync/10'] })
  assert.equal(source('n-known').schema, undefined, 'such a node gets v1')
})

// The skip must say what it did not check; CI can make it a failure. Run this very file in a child where the checkout is missing.
test('P1b2-skip-notice: without the remote-agent checkout the node-side tests are skipped WITH the reason; with DSH_REQUIRE_REMOTE_AGENT=1 the run fails', { skip: process.env.DSH_META_CHILD === '1' && 'meta test, not run inside its own child' }, () => {
  const run = extra => spawnSync(process.execPath, ['--import', './test/harness-resolve.mjs', '--test', '--test-reporter=tap', '--test-force-exit', '--test-timeout=60000', 'test/config-source-v2.test.js'], {
    cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 120000,
    // NODE_TEST_CONTEXT would make the child a subtest of this run (it would report in the runner's own format).
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, DSH_META_CHILD: '1', DSH_REMOTE_AGENT: '/nonexistent-remote-agent', DSH_HARNESS: process.env.DSH_HARNESS ?? '/private/tmp/deepseek-harness', ...extra },
  })
  const skipped = run({ DSH_REQUIRE_REMOTE_AGENT: '' })
  assert.equal(skipped.status, 0, skipped.stdout.slice(-600))
  const notices = skipped.stdout.split('\n').filter(line => /# SKIP .*DSH_REMOTE_AGENT.*NOT checked/.test(line))
  assert.equal(notices.length, 3, `node-accepts, e2e and clash-node each say why they were skipped:\n${notices.join('\n')}`)
  const required = run({ DSH_REQUIRE_REMOTE_AGENT: '1' })
  assert.notEqual(required.status, 0, 'CI mode: a missing checkout is a failure, not a skip')
})
