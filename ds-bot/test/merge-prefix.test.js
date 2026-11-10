// s50 / merge plan I5, I6, I7(R1): the main's CLI filter must know BOTH route spellings.
// Upstream v0.3.2 renames the local CLI routes `claude-code` → `local-claude-code` (engines.js ROUTE_PREFIX);
// a node that still runs 0.3.1-fork.N reports the old name, so both must be recognised. Written BEFORE the
// merge: the old-name cases and the golden bytes are green on fork.76, the `local-` cases go red→green at M4.
import test from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'node:util'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfigPayload, listGatewayProviders } from '../src/host/config-source.js'

const KEY_A = 'sk-AAAA-secret-value-1111'
const KEY_B = 'sk-BBBB-secret-value-2222'

function makeRt({ profiles, entries, refs }) {
  const warns = []
  const store = Object.create(null)
  store.settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles } }] }
  const ctx = { get: name => store[name], llm: { listConfigurableProviders: () => entries } }
  const rt = { ctx, dshHome: '/nonexistent', warn: (...args) => warns.push(format(...args)) }
  return { rt, warns, readRefs: () => new Map(Object.entries(refs)) }
}

const PROFILES = {
  alpha: { api: 'openai-completions', baseURL: 'https://a.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'm1', name: 'Model 1' }, { id: 'm2' }] },
  beta: { api: 'anthropic-messages', apiKeyEnv: 'BETA_KEY', models: [{ id: 'b1', name: 'B One' }] },
}
// A CLI route has a settings section of its own, with a baseURL and a key it would be pushed with if
// the filter let it through — that is what makes a missed filter visible.
const CLI_PROFILE = { api: 'openai-completions', baseURL: 'https://cli.example/v1', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'cli-m' }] }
const OLD_CLI = ['claude-code', 'codex-cli']
const NEW_CLI = ['local-claude-code', 'local-codex-cli']

const entryOf = id => ({ provider: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id] })
function world(extraIds = []) {
  const profiles = { ...PROFILES }
  for (const id of extraIds) profiles[id] = CLI_PROFILE
  const entries = [...Object.keys(PROFILES), ...extraIds].map(entryOf)
  return makeRt({ profiles, entries, refs: { ALPHA_KEY: KEY_A, BETA_KEY: KEY_B } })
}
const bytes = (ids, opts = {}) => {
  const { rt, readRefs } = world(ids)
  return JSON.stringify(buildConfigPayload(rt, { readRefs, ...opts }))
}

// What fork.76 produced for the two ordinary providers, byte for byte. Computed once on fa93fd30 and written
// down here: a change of key order, a new field or a different filter shows up as a diff.
const GOLDEN_V1 = "{\"providers\":[{\"id\":\"alpha\",\"api\":\"openai-completions\",\"baseURL\":\"https://a.example/v1\",\"apiKeyEnv\":\"ALPHA_KEY\",\"apiKey\":\"sk-AAAA-secret-value-1111\",\"models\":[{\"id\":\"m1\",\"name\":\"Model 1\"},{\"id\":\"m2\",\"name\":\"m2\"}]},{\"id\":\"beta\",\"api\":\"anthropic-messages\",\"apiKeyEnv\":\"BETA_KEY\",\"apiKey\":\"sk-BBBB-secret-value-2222\",\"models\":[{\"id\":\"b1\",\"name\":\"B One\"}]}],\"defaultModel\":null}"
const GOLDEN_V2 = "{\"schema\":2,\"providers\":[{\"id\":\"alpha\",\"api\":\"openai-completions\",\"baseURL\":\"https://a.example/v1\",\"apiKeyEnv\":\"ALPHA_KEY\",\"apiKey\":\"sk-AAAA-secret-value-1111\",\"models\":[{\"id\":\"m1\",\"name\":\"Model 1\"},{\"id\":\"m2\",\"name\":\"m2\"}]},{\"id\":\"beta\",\"api\":\"anthropic-messages\",\"apiKeyEnv\":\"BETA_KEY\",\"apiKey\":\"sk-BBBB-secret-value-2222\",\"models\":[{\"id\":\"b1\",\"name\":\"B One\"}]}],\"defaultModel\":null,\"plugins\":[],\"cliExpect\":[]}"

test('M-golden-v1: the v1 payload of fork.76 is reproduced byte for byte (old-name CLI routes present and filtered)', () => {
  assert.equal(bytes(OLD_CLI), GOLDEN_V1)
  assert.equal(bytes([]), GOLDEN_V1, 'the CLI routes add nothing, with or without them')
})

test('M-golden-v2: the v2 payload of fork.76 is reproduced byte for byte', () => {
  assert.equal(bytes(OLD_CLI, { schema: 2 }), GOLDEN_V2)
  assert.equal(bytes([], { schema: 2 }), GOLDEN_V2)
})

for (const id of OLD_CLI) {
  test(`M-old-${id}: the old route name is never pushed to a node (v1 and v2)`, () => {
    for (const schema of [1, 2]) {
      const out = buildConfigPayload(world([id]).rt, { readRefs: world([id]).readRefs, schema })
      assert.deepEqual(out.providers.map(p => p.id), ['alpha', 'beta'], `schema ${schema}`)
    }
  })
}

for (const id of NEW_CLI) {
  test(`M-new-${id}: the upstream route name is filtered the same way (v1 and v2) — and the bytes do not change`, () => {
    const w = world([id])
    for (const schema of [1, 2]) {
      const out = buildConfigPayload(w.rt, { readRefs: w.readRefs, schema })
      assert.deepEqual(out.providers.map(p => p.id), ['alpha', 'beta'], `schema ${schema}: ${id} is a local CLI, not a provider to sync`)
    }
    assert.equal(bytes([id]), GOLDEN_V1)
    assert.equal(bytes([id], { schema: 2 }), GOLDEN_V2)
  })
}

test('M-lookalike: a provider that merely CONTAINS a CLI name is an ordinary provider and is pushed', () => {
  const ids = ['my-claude-code', 'claude-codex', 'local-claude-codex', 'xlocal-codex-cli']
  const w = world(ids)
  const out = buildConfigPayload(w.rt, { readRefs: w.readRefs })
  assert.deepEqual(out.providers.map(p => p.id), ['alpha', 'beta', ...ids])
})

// The gateway's upstream list is a second copy of the CLI filter (config-source.js, listGatewayProviders).
// A CLI route that slipped through would be offered to nodes as a gateway upstream with the main's key.
function gatewayIds(extraIds) {
  const w = world(extraIds)
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-merge-prefix-'))
  writeFileSync(join(home, '.credentials.yaml'), `refs:\n  ALPHA_KEY: ${KEY_A}\n  BETA_KEY: ${KEY_B}\n`, { mode: 0o600 })
  w.rt.dshHome = home
  return listGatewayProviders(w.rt).map(p => p.id)
}

test('M-gw-old: the gateway upstream list leaves out the old CLI route names', () => {
  assert.deepEqual(gatewayIds(OLD_CLI), ['alpha'], 'beta has no baseURL, so only alpha is a usable upstream')
})

for (const id of NEW_CLI) {
  test(`M-gw-${id}: the gateway upstream list leaves out the upstream route name`, () => {
    assert.deepEqual(gatewayIds([id]), ['alpha'])
  })
}

test('M-gw-lookalike: an ordinary provider whose id merely contains a CLI name is still an upstream', () => {
  assert.deepEqual(gatewayIds(['my-claude-code', 'local-claude-codex']), ['alpha', 'my-claude-code', 'local-claude-codex'])
})
