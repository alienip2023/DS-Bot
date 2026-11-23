// A model the hub configured with `input: [text, image]` keeps it on the node: the REAL hub payload builder (modelV2,
// providerExtrasV2) -> AC's REAL handleConfigPush -> the patch file the node's DSH loads -> pi-ai's REAL config schema.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { modelV2, providerExtrasV2 } from '../src/host/config-v2.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const candidates = [process.env.REMOTE_AGENT_REPO, resolve(PLUGIN, '../../dsh-ai-cluster'), resolve(PLUGIN, '../../../Projects/dsh-ai-cluster')]
  .filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
const repo = candidates.find(dir => existsSync(join(dir, 'lib/node/config-managed.js')) && readFileSync(join(dir, 'lib/node/config-managed.js'), 'utf8').includes('cleanPiModel'))
const skip = repo === undefined ? 'AC repo with node model fields not found (set REMOTE_AGENT_REPO)' : false

test('the hub\'s model capabilities survive the push and satisfy pi-ai\'s own config schema', { skip }, async (t) => {
  const { handleConfigPush } = await import(pathToFileURL(join(repo, 'lib/node/config-sync.js')).href)
  const yaml = (await import(pathToFileURL(join(PLUGIN, 'dev/harness/node_modules/js-yaml/dist/js-yaml.mjs')).href)).default
  const { Config } = await import('@deepseek-ai/dsh-llm-pi-ai')

  const tally = { n: 0 }
  const profile = {
    displayName: 'Vision Co', streamIdleTimeoutMs: 120000, headers: { 'x-secret': 'nope' },
    models: [
      { id: 'vision-1', name: 'Vision One', contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high' } },
      { id: 'text-only', name: 'Text Only', input: ['text'], reasoningEfforts: false },
    ],
  }
  const provider = {
    id: 'vision-co', api: 'openai-completions', baseURL: 'https://example.test/v1', apiKeyEnv: 'VISION_API_KEY', apiKey: 'sk-secret-0123456789',
    models: profile.models.map(model => modelV2(model, tally)), ...providerExtrasV2(profile, tally),
  }
  assert.deepEqual(provider.models[0].input, ['text', 'image'], 'the hub side already carries it')

  const base = mkdtempSync(join(tmpdir(), 'node-model-config-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const acks = []
  const result = handleConfigPush({
    data: { schema: 2, revision: 1, providers: [provider], plugins: [], cliExpect: [] },
    dshHome, profileDir, send: (type, data) => acks.push({ type, data }), logger: () => {}, _restartFn: () => {},
  })
  assert.equal(result.ok, true, JSON.stringify(result))

  const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch.includes('sk-secret'), false)
  assert.equal(patch.includes('x-secret'), false, 'headers never leave the hub')
  const entry = yaml.load(patch).find(item => item.id === 'llm-pi-ai')
  const route = entry.config.providers['vision-co']
  assert.deepEqual(route.models[0].input, ['text', 'image'], 'the model reads images on the node')
  assert.equal(route.models[0].contextWindow, 200000)
  assert.deepEqual(route.models[0].reasoningEfforts, { off: null, low: 'low', high: 'high' })
  assert.equal(route.models[1].reasoningEfforts, false)
  // pi-ai's own profile schema accepts exactly this (it rejects a wrong field, and then the node's LLM would not start)
  const profileSchema = Config.dict.providers.inner
  const checked = profileSchema(route)
  assert.equal(checked.models[0].input.join(), 'text,image')
  assert.equal(checked.displayName, 'Vision Co')
  assert.equal(checked.streamIdleTimeoutMs, 120000)
  assert.throws(() => profileSchema({ ...route, models: [{ id: 'x', input: ['audio'] }] }), 'the schema does reject a bad field: the check above is not vacuous')
})
