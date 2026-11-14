// The 5s tick must not repeat itself. A count warning is logged once per distinct count,
// the fingerprint is rebuilt only when an input hint moved, and the default model is not
// re-read on every tick. install() and buildConfigPayload() are the real product code; the
// only instrumentation is counting how often the credentials file is read, which the full
// build does and the cheap hint does not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { install } from '../src/host/config-source.js'

const KEY = 'sk-AAAA-secret-value-1111'
const flush = () => new Promise(resolve => setImmediate(resolve))

const reads = new Map()
const realRead = readFileSync
globalThis.__cfgQuietRead = (file, ...rest) => {
  const home = reads.get(String(file))
  if (home !== undefined) home.n += 1
  return realRead(file, ...rest)
}

function world() {
  const warns = []
  const profiles = {
    alpha: { api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'm1' }] },
    // A route with a protocol but no key: counted, never pushed.
    bare: { api: 'openai-completions', apiKeyEnv: 'BARE_KEY', models: [{ id: 'b1' }] },
  }
  const home = mkdtempSync(join(tmpdir(), 'cfgquiet-'))
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  ALPHA_KEY: ' + JSON.stringify(KEY) + '\n')
  const credReads = { n: 0 }
  reads.set(join(home, '.credentials.yaml'), credReads)
  const store = Object.create(null)
  const ctx = {
    get: name => store[name],
    llm: { listConfigurableProviders: () => Object.keys(profiles).map(id => ({ provider: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id] })) },
  }
  store.settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles } }] }
  let modelReads = 0
  let model = 'alpha/m1'
  const answer = async () => { modelReads += 1; return rt.state?.prefs?.defaultBotModel ?? model }
  const rt = {
    ctx, dshHome: home,
    warn: (...args) => warns.push(format(...args)),
    defaultBotModel: answer,
  }
  const pushes = []
  store['remote-agent:config-sync'] = { source: null, setSource(fn) { this.source = fn }, sendPush(nodeId) { pushes.push(nodeId); return true } }
  store['remote-agent:registry'] = { onlineNodes: () => [{ nodeId: 'n1' }], getNode: () => undefined, on: () => {} }
  return { rt, store, warns, profiles, pushes, modelReads: () => modelReads, builds: () => credReads.n, setModel: value => { model = value }, restore() { rt.defaultBotModel = answer } }
}

const skipped = warns => warns.filter(line => line.startsWith('ds-bot: config-source skipped'))

async function settled(t, w) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  install(w.rt)
  await flush()
  t.mock.timers.tick(5_000)
  await flush()
}

test('three ticks with nothing changed add no repeated count warning', async (t) => {
  const w = world()
  await settled(t, w)
  const before = skipped(w.warns).length
  assert.equal(before, 1, 'the first build logs the skip once')
  for (let i = 0; i < 3; i += 1) { t.mock.timers.tick(5_000); await flush() }
  assert.equal(skipped(w.warns).length, before, 'the same count is not logged again')
})

test('a count that changed is logged once more', async (t) => {
  const w = world()
  await settled(t, w)
  w.profiles.second = { api: 'openai-completions', apiKeyEnv: 'SECOND_KEY', models: [{ id: 's1' }] }
  t.mock.timers.tick(5_000)
  await flush()
  assert.equal(skipped(w.warns).length, 2)
  assert.match(skipped(w.warns).at(-1), /skipped 2 provider/)
})

test('a count that falls back to zero logs nothing more', async (t) => {
  const w = world()
  await settled(t, w)
  const before = w.warns.length
  delete w.profiles.bare
  t.mock.timers.tick(5_000)
  await flush()
  assert.equal(skipped(w.warns).length, 1, 'no recovered line when the count reaches zero')
  assert.equal(w.warns.length, before, 'falling back to zero adds no warning of any kind')
})

test('a real change is pushed and an unchanged hint does not rebuild', async (t) => {
  const w = world()
  await settled(t, w)
  w.pushes.length = 0
  const built = w.builds()
  for (let i = 0; i < 3; i += 1) { t.mock.timers.tick(5_000); await flush() }
  assert.equal(w.builds(), built, 'an unchanged hint does not read the credentials file again')
  assert.deepEqual(w.pushes, [])

  w.profiles.gamma = { api: 'openai-completions', baseURL: 'https://g.example/v1', apiKeyEnv: 'GAMMA_KEY', models: [{ id: 'g1' }] }
  writeFileSync(join(w.rt.dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  ALPHA_KEY: ' + JSON.stringify(KEY) + '\n  GAMMA_KEY: ' + JSON.stringify('sk-GAMMA-3333') + '\n')
  t.mock.timers.tick(5_000)
  await flush()
  assert.ok(w.builds() > built, 'a changed hint rebuilds')
  assert.deepEqual(w.pushes, ['n1'])
})

test('the cached default model is not re-read every tick, and a lapsed cache still catches the change', async (t) => {
  const w = world()
  await settled(t, w)
  const asked = w.modelReads()
  for (let i = 0; i < 3; i += 1) { t.mock.timers.tick(5_000); await flush() }
  assert.equal(w.modelReads(), asked, 'within the cache window the default model is not asked again')

  w.setModel('alpha/m2')
  w.pushes.length = 0
  t.mock.timers.tick(10 * 60_000)
  await flush()
  assert.ok(w.modelReads() > asked, 'the cache lapses after ten minutes and the model is read again')
  assert.deepEqual(w.pushes, ['n1'], 'the new default is pushed on the tick the cache lapses')
  assert.equal(w.store['remote-agent:config-sync'].source('n1').defaultModel, 'alpha/m2')
})

test('a hint that cannot be read falls back to a full build', async (t) => {
  const w = world()
  await settled(t, w)
  const built = w.builds()
  // A settings service that throws cannot be fingerprinted cheaply. That is a doubt, so
  // the tick rebuilds rather than reusing the cached fingerprint.
  w.store.settings.describe = () => { throw new Error('settings unreadable') }
  t.mock.timers.tick(5_000)
  await flush()
  assert.ok(w.builds() > built, 'a hint that cannot be read rebuilds instead of trusting the cache')
})

test('a throw is not cached: the next tick reads the default model again', async (t) => {
  const w = world()
  await settled(t, w)
  const asked = w.modelReads()
  // A changed hint forces a read. The read throws, and that failure must not count as a
  // check: the following tick, with the hint now still, has to read again.
  // One function throughout, so its identity never moves: the only thing that can make
  // the next tick read again is the cleared check time.
  let threw = 0
  let fail = true
  w.rt.defaultBotModel = async () => {
    threw += 1
    if (fail) throw new Error('catalog down')
    return 'alpha/m2'
  }
  w.profiles.gamma = { api: 'openai-completions', apiKeyEnv: 'GAMMA_KEY', models: [{ id: 'g1' }] }
  t.mock.timers.tick(5_000)
  await flush()
  assert.equal(w.store['remote-agent:config-sync'].source('n1').defaultModel, null)
  assert.equal(threw, 1, 'the changed hint read once, and it threw')

  fail = false
  t.mock.timers.tick(5_000)
  await flush()
  assert.equal(threw, 2, 'the next tick reads again instead of reusing the failure')
  assert.equal(w.store['remote-agent:config-sync'].source('n1').defaultModel, 'alpha/m2')
})

test('a changed default-model preference rebuilds and pushes on its own', async (t) => {
  const w = world()
  await settled(t, w)
  w.pushes.length = 0
  const built = w.builds()
  w.rt.state = { prefs: { defaultBotModel: 'alpha/m2' } }
  t.mock.timers.tick(5_000)
  await flush()
  assert.ok(w.builds() > built, 'the preference is part of the hint, so a change rebuilds')
  assert.deepEqual(w.pushes, ['n1'])
})
