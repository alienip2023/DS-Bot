// s50 / merge plan I8 (R1, R11): the model picker of a remote Bot greys out CLI models with the CLI
// reason, under BOTH route spellings — the main may be 0.3.2-based (`local-claude-code/…`) while the
// node still reports the old names, or the other way round. Written before the merge: the old-name
// cases are green on fork.76, the `local-` cases are red until src/client/node-models.js (M4) knows them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { joinedModelView, NODE_REASONS } from './src/client/node-models.js'\nexport { installLocale } from './src/client/i18n.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: initial => ({ value: initial, Provider: () => null }), useContext: ctx => ctx.value, useCallback: fn => fn,
  useSyncExternalStore: (_s, get) => get(), createElement: () => null, Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}], useMemo: make => make(), useRef: initial => ({ current: initial }), useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} }, document: { body: {} }, navigator: {}, Element: class {},
})
const { joinedModelView, NODE_REASONS } = module.exports

const bot = { id: 'joined:n1:rb1', origin: 'joined', type: 'remote-worker', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true } }
const model = (ref, provider = ref.split('/')[0]) => ({ ref, provider, providerName: provider, name: ref })
const nodeModel = ref => ({ ref, provider: ref.split('/')[0], id: ref.split('/')[1], name: ref })
const view = (mainRefs, nodeRefs) => joinedModelView(bot, { models: mainRefs.map(r => model(r)) }, nodeRefs.map(nodeModel))

const ORDINARY = 'openrouter/gpt-x'
const CLIS = ['claude-code/sonnet', 'codex-cli/gpt-5', 'local-claude-code/sonnet', 'local-codex-cli/gpt-5']

for (const ref of CLIS) {
  test(`M-menu-${ref}: a main-only CLI model is greyed out with the CLI reason, not the provider reason`, () => {
    const out = view([ORDINARY, ref], [ORDINARY])
    const row = out.unavailable.find(m => m.ref === ref)
    assert.ok(row, 'listed as unavailable')
    assert.equal(row.reason, NODE_REASONS.cli())
    assert.notEqual(NODE_REASONS.cli(), NODE_REASONS.provider(), 'the two reasons really differ')
  })
}

test('M-menu-ordinary: a main-only ordinary provider model gets the provider reason', () => {
  const out = view([ORDINARY, 'other/m'], [ORDINARY])
  assert.equal(out.unavailable.find(m => m.ref === 'other/m').reason, NODE_REASONS.provider())
})

test('M-menu-lookalike: a provider that only CONTAINS a CLI name (my-claude-code, local-claude-codex) gets the provider reason', () => {
  const out = view([ORDINARY, 'my-claude-code/x', 'local-claude-codex/y'], [ORDINARY])
  for (const ref of ['my-claude-code/x', 'local-claude-codex/y']) assert.equal(out.unavailable.find(m => m.ref === ref).reason, NODE_REASONS.provider(), ref)
})

test('M-menu-mixed: a node that reports the OLD name while the main lists the NEW one (and the reverse) — each ref stays on its own side', () => {
  // main 0.3.2-based, node 0.3.1: the node can run claude-code/sonnet; the main's local-claude-code/sonnet is not on the node
  const a = view([ORDINARY, 'local-claude-code/sonnet'], [ORDINARY, 'claude-code/sonnet'])
  assert.deepEqual(a.unavailable.map(m => m.ref), ['local-claude-code/sonnet'])
  assert.equal(a.unavailable[0].reason, NODE_REASONS.cli())
  assert.deepEqual(a.roster.models.map(m => m.ref), [ORDINARY, 'claude-code/sonnet'], 'the node list is what the picker offers')
  const b = view([ORDINARY, 'claude-code/sonnet'], [ORDINARY, 'local-claude-code/sonnet'])
  assert.deepEqual(b.unavailable.map(m => m.ref), ['claude-code/sonnet'])
  assert.equal(b.unavailable[0].reason, NODE_REASONS.cli())
})

test('M-menu-on-node: a CLI model the node does report is selectable, not greyed', () => {
  for (const ref of CLIS) assert.deepEqual(view([ORDINARY, ref], [ORDINARY, ref]).unavailable, [], ref)
})
