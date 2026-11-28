import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The Create Bot form, bundled once and rendered with the minimal React stand-in of
// connectors-page.test.js: state is scoped to its component, and node tests run
// only the root form's mount effects against explicit stubs.
const { outputFiles } = await build({
  stdin: { contents: "export { CreateBot } from './src/client/create-bot.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const frames = new Map()
const mountEffects = []
let slots, key
let idx = 0
let concrete = null
let props = {}
const phase = (node, path) => {
  key = path
  slots = frames.get(path) ?? []
  frames.set(path, slots)
  idx = 0
  return node.type(node.props)
}
const expand = (node, path) => {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map((child, i) => expand(child, path + ':' + i))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const here = path + ':' + node.type.name + ':' + (node.props?.key ?? '')
    return expand(phase(node, here), here)
  }
  return { ...node, props: { ...node.props, children: expand(node.props?.children, path) } }
}
const rerender = () => { concrete = expand(phase({ type: module.exports.CreateBot, props }, 'root'), 'root') }
const react = {
  createElement: (type, p, ...children) => ({ type, props: { ...p, children } }),
  Fragment: 'fragment',
  useCallback: fn => fn,
  useMemo: make => make(),
  useEffect(effect, deps) {
    const i = idx++
    if (key === 'root' && deps?.length === 0 && !(i in slots)) {
      slots[i] = true
      mountEffects.push(effect)
    }
  },
  useLayoutEffect() {},
  useState: (init) => {
    const i = idx++
    const frame = slots
    if (!(i in frame)) frame[i] = typeof init === 'function' ? init() : init
    return [frame[i], (value) => { frame[i] = typeof value === 'function' ? value(frame[i]) : value; rerender() }]
  },
  useRef: (current) => {
    const i = idx++
    if (!(i in slots)) slots[i] = { current }
    return slots[i]
  },
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(n => flatten(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  flatten(node.props?.children, out)
  return out
}
const collect = (match) => {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (match(node)) out.push(node)
    walk(node.props?.children)
  }
  walk(concrete)
  return out
}
const button = text => collect(n => n.type === 'button' && flatten(n).join('') === text)[0]
const render = (roster, extra = {}) => {
  frames.clear()
  mountEffects.length = 0
  props = { roster: { bots: [], rooms: [], prefs: {}, ...roster }, actions: {}, onBack() {}, onCreated() {}, ...extra }
  rerender()
}

const MODELS = [
  { ref: 'ds/flash', provider: 'ds', id: 'flash', name: 'Flash', providerName: 'DS' },
  { ref: 'local-codex-cli/default', provider: 'local-codex-cli', id: 'default', name: 'CLI default', providerName: 'Codex CLI' },
]

test('the form opens on Built-in engine and can create at once', () => {
  render({ models: MODELS })
  assert.equal(button('Built-in engine').props['aria-pressed'], true)
  assert.equal(button('Local agent').props['aria-pressed'], false)
  assert.equal(button('Create').props.disabled, false)
})

test('a name another Bot has blocks Create on both sides', () => {
  render({ models: MODELS, bots: [{ id: 'a', name: 'Ada' }] })
  collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')[0].props.onChange({ target: { value: 'Ada' } })
  assert.match(flatten(concrete).join(' '), /A Bot named Ada already exists/)
  assert.equal(button('Create').props.disabled, true)
  button('Local agent').props.onClick()
  assert.equal(button('Create').props.disabled, true)
})

test('on Local agent, Create waits for a CLI', () => {
  render({ models: MODELS })
  const presetPickers = () => collect(n => String(n.props?.className ?? '').includes('bt-preset-trigger'))
  assert.equal(presetPickers().length, 1)
  button('Local agent').props.onClick()
  assert.equal(presetPickers().length, 0)
  assert.equal(button('Local agent').props['aria-pressed'], true)
  assert.match(flatten(concrete).join(' '), /Looking for agent CLIs/)
  assert.equal(button('Create').props.disabled, true)
  button('Built-in engine').props.onClick()
  assert.equal(presetPickers().length, 1)
  assert.equal(button('Create').props.disabled, false)
})

const node = { nodeId: 'n1', hostname: 'box', defaultModel: 'node/beta', models: [{ ref: 'node/alpha', name: 'Alpha' }, { ref: 'node/beta', name: 'Beta' }] }
const chooseMachine = value => collect(n => n.type === 'select' && n.props['aria-label'] === 'Machine')[0].props.onChange({ target: { value } })
async function renderWithNodes(nodes, calls) {
  render({ models: MODELS, prefs: { defaultBotModel: 'ds/flash' } }, { actions: {
    botCreateTargets: async () => nodes,
    createBot: async (payload) => { calls.push(payload); return { id: 'b1' } },
  } })
  for (const effect of mountEffects.splice(0)) effect()
  await Promise.resolve()
}

test('switching to a node moves the model onto that node\'s default', async () => {
  const calls = []
  await renderWithNodes([node], calls)
  chooseMachine('n1')
  assert.equal(collect(n => String(n.props?.className ?? '').includes('bt-preset-trigger')).length, 0)
  button('Create').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'node/beta', 'the hub default must not be sent to a node that lacks it')
  assert.equal(calls[0].nodeId, 'n1')
  assert.equal('agentPreset' in calls[0], false)
})

test('switching back to this machine restores a hub model', async () => {
  const calls = []
  await renderWithNodes([node], calls)
  chooseMachine('n1')
  // The user changes their mind and creates on this machine instead.
  chooseMachine('')
  button('Create').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'ds/flash', 'a node-only model must not be sent to the hub')
  assert.equal(calls[0].nodeId, undefined)
})

test('a node with no default keeps the current model', async () => {
  const calls = []
  await renderWithNodes([{ ...node, nodeId: 'n3', defaultModel: null }], calls)
  chooseMachine('n3')
  button('Create').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'ds/flash', 'without a node default the hub choice stays; the node reports unknown itself')
})

test('a node with an empty catalog disables Create and says so', async () => {
  await renderWithNodes([{ ...node, nodeId: 'n2', models: [] }], [])
  chooseMachine('n2')
  assert.equal(button('Create').props.disabled, true)
  assert.match(flatten(concrete).join(' '), /model catalog has not synced yet/)
})

test('inline Settings subpage does not autoFocus Name below the avatar picker', () => {
  render({ models: MODELS }, { inline: true })
  assert.equal(collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')[0].props.autoFocus, false)
  render({ models: MODELS }, { inline: false })
  assert.equal(collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')[0].props.autoFocus, true)
})
