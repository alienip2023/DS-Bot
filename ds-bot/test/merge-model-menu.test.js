// s50 merge M5 — the model picker: upstream's local-agent routing vs. this fork's remote Bot picker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// fork.64: the model picker of a remote (joined) Bot lists what its NODE can run. The REAL
// DetailsDrawer is rendered with a small stateful React stand-in; the REAL BotModelMenu fetches
// the node's catalog through the real teamActions (botCreateTargets -> call), the REAL ModelMenu
// is opened (state slot seeded), and its rows are clicked.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { ModelMenu } from './src/client/model-menu.js'",
      "export { installLocale } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

let hooks
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect(fn) { hooks.effects.push(fn) }, useLayoutEffect() {},
  useState(initial) {
    const own = hooks // setters keep writing to the render they came from
    const i = own.i++
    if (!(i in own.slots)) own.slots[i] = i in own.seed ? own.seed[i] : (typeof initial === 'function' ? initial() : initial)
    return [own.slots[i], (value) => { own.sets.push(value); own.slots[i] = typeof value === 'function' ? value(own.slots[i]) : value }]
  },
  useMemo: make => make(),
  useRef(initial) { const i = hooks.i++; hooks.slots[i] ??= { current: initial }; return hooks.slots[i] },
  useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
  document: { body: {} },
  navigator: {},
  Element: class {},
})
const { ModelMenu } = module.exports

const settle = () => new Promise(resolve => setTimeout(resolve, 5))
// Render a component as a function; run its effects once, let the promises settle, render again.
async function render(Component, props, { seed = {}, effects = true } = {}) {
  hooks = { i: 0, slots: {}, effects: [], seed, sets: [] }
  Component(props)
  if (effects) {
    for (const effect of hooks.effects) effect()
    await settle()
  }
  hooks.i = 0
  hooks.effects = []
  const tree = Component(props)
  return { tree, sets: hooks.sets }
}
const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}
// Components without hooks that make up the menu body are rendered in place (ModelChoices, ModelRows).
const INLINE = new Set(['ModelChoices', 'ModelRows', 'ModelGroupList'])
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object' || node.props === undefined) return node
  // Upstream v0.3.2 folds a provider's models under its heading (only the current model's provider starts open).
  // These tests are about WHICH models the list holds, so every group is expanded here.
  if (typeof node.type === 'function' && node.type.name === 'ModelGroupList') return expand(node.type({ ...node.props, manual: new Proxy({}, { get: () => true }) }))
  if (typeof node.type === 'function' && INLINE.has(node.type.name)) return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const find = (tree, match) => { const hits = []; walk(tree, node => { if (match(node)) hits.push(node) }); return hits }


const OPEN = { 1: { left: 0, width: 240, top: 0, maxHeight: 400 } }
const NODE = [
  { ref: 'ccmax/claude-sonnet-5-5', provider: 'ccmax', name: 'Claude Sonnet 5.5' },
  { ref: 'claude-code/opus', provider: 'claude-code', name: 'Opus (old node name)' },
  { ref: 'local-claude-code/sonnet', provider: 'local-claude-code', name: 'Sonnet (new node name)' },
  { ref: 'local-codex-cli/gpt-5', provider: 'local-codex-cli', name: 'GPT-5 (new node name)' },
]
const joined = model => ({ id: 'joined:n1:rb1', name: 'R', origin: 'joined', type: 'remote-worker', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true }, model })
const local = model => ({ id: 'bot-l', name: 'L', model })

// s50 merge M5: upstream's ModelMenu treats a `local-<cli>` model as an agent of THIS machine (it lists that agent's own
// models, asks its CLI for them when the menu opens, and hides every local route from any other Bot). A remote Bot's list
// is the NODE's catalog — whatever names a node of either build reports — and nothing of this machine's CLIs.
async function menuOf(bot, models, { open = true } = {}) {
  const calls = []
  const actions = { agentModels: async route => { calls.push(['agentModels', route]) }, refreshModels: async () => { calls.push(['refreshModels']) }, efforts: async () => ({}), updateBot: async () => ({}) }
  const roster = { models, ready: true, byId: {} }
  const { tree } = await render(ModelMenu, { bot, roster, actions, run: fn => fn, unavailable: [], notice: null }, { effects: false, seed: open ? OPEN : {} })
  const items = find(expand(tree), n => n.type === 'button' && n.props.role === 'menuitemradio')
  return { picks: items.map(n => n.props.title), calls, tree }
}

test('M-menu-remote: a remote Bot whose model is a local-… name lists the node catalog whole, local names of either spelling included', async () => {
  const m = await menuOf(joined('local-claude-code/sonnet'), NODE)
  assert.deepEqual(m.picks.sort(), NODE.map(n => n.ref).sort())
})

test('M-menu-remote-old: the same for a remote Bot on an old-name model', async () => {
  const m = await menuOf(joined('claude-code/opus'), NODE)
  assert.deepEqual(m.picks.sort(), NODE.map(n => n.ref).sort())
})

test('M-menu-remote-open: opening a remote Bot\'s menu never asks THIS machine\'s CLI for its models', async () => {
  const m = await menuOf(joined('local-claude-code/sonnet'), NODE, { open: false })
  const trigger = find(m.tree, n => n.type === 'button' && n.props.className === 'bt-model-trigger')[0]
  trigger.props.onClick()
  assert.deepEqual(m.calls.filter(c => c[0] === 'agentModels'), [])
})

test('M-menu-local: a local Bot on a local agent lists that agent\'s models only, and asks its CLI when the menu opens', async () => {
  const m = await menuOf(local('local-claude-code/sonnet'), NODE)
  assert.deepEqual(m.picks, ['local-claude-code/sonnet'])
  const closed = await menuOf(local('local-claude-code/sonnet'), NODE, { open: false })
  find(closed.tree, n => n.type === 'button' && n.props.className === 'bt-model-trigger')[0].props.onClick()
  assert.deepEqual(closed.calls.filter(c => c[0] === 'agentModels'), [['agentModels', 'local-claude-code']])
})

test('M-menu-local-model: a local Bot on a provider model lists the provider models and no local-… agent', async () => {
  const m = await menuOf(local('ccmax/claude-sonnet-5-5'), NODE)
  assert.deepEqual(m.picks.sort(), ['ccmax/claude-sonnet-5-5', 'claude-code/opus'], 'no local-… route in it')
})
