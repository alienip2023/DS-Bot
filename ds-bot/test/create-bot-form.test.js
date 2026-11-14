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
// connectors-page.test.js: hooks are numbered by expansion order, effects never run.
const { outputFiles } = await build({
  stdin: { contents: "export { CreateBot } from './src/client/create-bot.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
let idx = 0
let concrete = null
let props = {}
const expand = (node) => {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}
const rerender = () => { idx = 0; concrete = expand(module.exports.CreateBot(props)) }
const react = {
  createElement: (type, p, ...children) => ({ type, props: { ...p, children } }),
  Fragment: 'fragment',
  useCallback: fn => fn,
  useEffect() {}, useLayoutEffect() {},
  useState: (init) => {
    const i = idx++
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; rerender() }]
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
const render = (roster) => {
  slots.length = 0
  props = { roster: { bots: [], rooms: [], prefs: {}, ...roster }, actions: {}, onBack() {}, onCreated() {} }
  rerender()
}

const MODELS = [
  { ref: 'ds/flash', provider: 'ds', id: 'flash', name: 'Flash', providerName: 'DS' },
  { ref: 'local-codex-cli/default', provider: 'local-codex-cli', id: 'default', name: 'CLI default', providerName: 'Codex CLI' },
]

test('the form opens on DS Bot models and can create at once', () => {
  render({ models: MODELS })
  assert.equal(button('DS Bot model').props['aria-pressed'], true)
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
  button('Local agent').props.onClick()
  assert.equal(button('Local agent').props['aria-pressed'], true)
  assert.match(flatten(concrete).join(' '), /Looking for agent CLIs/)
  assert.equal(button('Create').props.disabled, true)
  button('DS Bot model').props.onClick()
  assert.equal(button('Create').props.disabled, false)
})

test('switching to a node moves the model onto that node\'s default', () => {
  render({ models: MODELS, prefs: { defaultBotModel: 'ds/flash' } })
  const calls = []
  props.actions = {
    botCreateTargets: () => Promise.resolve({ nodes: [
      { nodeId: 'n1', hostname: 'box', defaultModel: 'node/beta', models: [{ ref: 'node/alpha', name: 'Alpha' }, { ref: 'node/beta', name: 'Beta' }] },
    ] }),
    createBot: (payload) => { calls.push(payload); return Promise.resolve({ id: 'b1' }) },
  }
  // The harness never runs effects, so feed the node list the way the effect would.
  const machine = collect(n => n.type === 'select' && n.props['aria-label'] === 'Machine')[0]
  // The node list lives in state; set it through the setter the effect uses.
  // remoteNodes is the 18th useState (index 17); the harness numbers slots by hook order.
  slots[17] = [
    { nodeId: 'n1', hostname: 'box', defaultModel: 'node/beta', models: [{ ref: 'node/alpha' }, { ref: 'node/beta' }] },
  ]
  machine.props.onChange({ target: { value: 'n1' } })
  // The select's onChange closed over the previous render's remoteNodes, which was empty.
  // Re-read it after the state write so it sees the node list, as a real re-render would.
  const machineNow = collect(n => n.type === 'select' && n.props['aria-label'] === 'Machine')[0]
  machineNow.props.onChange({ target: { value: 'n1' } })
  button('Create').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'node/beta', 'the hub default must not be sent to a node that lacks it')
  assert.equal(calls[0].nodeId, 'n1')
})

test('switching back to this machine restores a hub model', () => {
  render({ models: MODELS, prefs: { defaultBotModel: 'ds/flash' } })
  const calls = []
  props.actions = { createBot: (payload) => { calls.push(payload); return Promise.resolve({ id: 'b1' }) } }
  slots[17] = [
    { nodeId: 'n1', hostname: 'box', defaultModel: 'node/beta', models: [{ ref: 'node/alpha' }, { ref: 'node/beta' }] },
  ]
  const machine = collect(n => n.type === 'select' && n.props['aria-label'] === 'Machine')[0]
  machine.props.onChange({ target: { value: 'n1' } })
  collect(n => n.type === 'select' && n.props['aria-label'] === 'Machine')[0].props.onChange({ target: { value: 'n1' } })
  // The user changes their mind and creates on this machine instead.
  collect(n => n.type === 'select' && n.props['aria-label'] === 'Machine')[0].props.onChange({ target: { value: '' } })
  button('Create').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'ds/flash', 'a node-only model must not be sent to the hub')
  assert.equal(calls[0].nodeId, undefined)
})

test('a node with no default keeps the current model', () => {
  render({ models: MODELS, prefs: { defaultBotModel: 'ds/flash' } })
  const calls = []
  props.actions = { createBot: (payload) => { calls.push(payload); return Promise.resolve({ id: 'b1' }) } }
  slots[17] = [{ nodeId: 'n3', hostname: 'plain', defaultModel: null, models: [{ ref: 'node/alpha' }] }]
  const machine = collect(n => n.type === 'select' && n.props['aria-label'] === 'Machine')[0]
  machine.props.onChange({ target: { value: 'n3' } })
  button('Create').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'ds/flash', 'without a node default the hub choice stays; the node reports unknown itself')
})

test('a node with an empty catalog disables Create and says so', () => {
  render({ models: MODELS })
  slots[17] = [{ nodeId: 'n2', hostname: 'empty', models: [] }]
  const machine = collect(n => n.type === 'select' && n.props['aria-label'] === 'Machine')[0]
  machine.props.onChange({ target: { value: 'n2' } })
  assert.equal(button('Create').props.disabled, true)
  assert.match(flatten(concrete).join(' '), /model catalog has not synced yet/)
})
