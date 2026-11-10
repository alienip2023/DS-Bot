// s50 / merge plan I11: the new-Bot form keeps what this fork added when upstream's form is merged in —
// the Machine dropdown, the remote-node branch (create ON a node, model from the node's catalog, no memory
// field), the Worker-Bot fields and the memoryConfig in the local create body. The REAL CreateBot is
// rendered with a small stateful React stand-in whose state persists across renders; the form is driven
// through its own controls (select onChange, button onClick), never by seeding slots, so a changed
// control layout still reaches the same payloads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: { contents: "export { CreateBot } from './src/client/create-bot.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

let hooks
const react = {
  createContext: initial => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value, useCallback: fn => fn, useSyncExternalStore: (_s, get) => get(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect(fn) { hooks.effects.push(fn) }, useLayoutEffect() {},
  useState(initial) {
    const own = hooks
    const i = own.i++
    if (!(i in own.slots)) own.slots[i] = typeof initial === 'function' ? initial() : initial
    return [own.slots[i], value => { own.slots[i] = typeof value === 'function' ? value(own.slots[i]) : value }]
  },
  useMemo: make => make(), useRef(initial) { const i = hooks.i++; hooks.slots[i] ??= { current: initial }; return hooks.slots[i] }, useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} }, document: { body: {} }, navigator: {}, Element: class {},
})
const { CreateBot } = module.exports

// objects built inside the vm context have another Object.prototype: compare plain copies
const plain = value => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setTimeout(resolve, 5))
const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}
const find = (tree, match) => { const hits = []; walk(tree, node => { if (match(node)) hits.push(node) }); return hits }
const textOf = node => { const parts = []; walk(node, n => { for (const c of [n.props?.children].flat()) if (typeof c === 'string') parts.push(c) }); return parts.join('|') }

const ROSTER = {
  bots: [{ name: 'Existing' }], ready: true, defaultModel: 'piion/m1', prefs: {},
  models: [{ ref: 'piion/m1', provider: 'piion', providerName: 'piion', name: 'Piion M1' }],
}
const NODE_MODEL = { ref: 'ccmax/claude-sonnet-5-5', provider: 'ccmax', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }

// A mounted form: `view()` is the current tree, `act(fn)` runs a handler then re-renders.
async function mount({ targets = [{ nodeId: 'n1', hostname: 'node-1', online: true, models: [NODE_MODEL], defaultModel: null }] } = {}) {
  const created = []
  const actions = {
    botCreateTargets: async () => targets,
    createBot: async payload => { created.push(payload); return { id: 'new-1' } },
    closeOverlay() {}, refreshModels: async () => {}, efforts: async () => ({}), avatarLibrary: async () => ({ entries: [] }),
  }
  const props = { roster: ROSTER, actions, onBack() {}, canGoBack: false, onCreated() {}, inline: true }
  hooks = { i: 0, slots: {}, effects: [] }
  CreateBot(props)
  const effects = hooks.effects
  hooks.effects = []
  for (const effect of effects) effect()
  await settle()
  const view = () => { hooks.i = 0; hooks.effects = []; return CreateBot(props) }
  const act = async fn => { await fn(view()); await settle() }
  const select = (tree, label) => find(tree, n => n.type === 'select' && n.props['aria-label'] === label)[0]
  const createButton = tree => find(tree, n => n.type === 'button' && /bt-create-go/.test(n.props.className ?? ''))[0]
  return { created, view, act, select, createButton }
}

test('M-create-machine: the Machine dropdown is there — "This machine" first, then each connected node', async () => {
  const m = await mount()
  const machine = m.select(m.view(), 'Machine')
  assert.ok(machine, 'a Machine select')
  const options = find(machine, n => n.type === 'option').map(n => [n.props.value, textOf(n)])
  assert.deepEqual(options, [['', 'This machine'], ['n1', 'node-1']])
})

test('M-create-local: the local create body carries the look, the model AND memoryConfig (default Auto)', async () => {
  const m = await mount()
  await m.act(tree => m.createButton(tree).props.onClick())
  assert.equal(m.created.length, 1)
  const body = m.created[0]
  assert.deepEqual(plain(body.memoryConfig), { backend: 'auto' })
  assert.equal(body.model, 'piion/m1')
  assert.equal(typeof body.name, 'string')
  assert.equal(body.nodeId, undefined, 'not a remote create')
  assert.equal(body.type, undefined)
})

test('M-create-memory: the Memory Backend select feeds memoryConfig of the create body', async () => {
  const m = await mount()
  const select = m.select(m.view(), 'Memory backend')
  assert.ok(select, 'a Memory backend select on the local form')
  assert.deepEqual(find(select, n => n.type === 'option').map(n => n.props.value), ['auto', 'mneme', 'file', 'none'])
  await m.act(tree => m.select(tree, 'Memory backend').props.onChange({ target: { value: 'none' } }))
  await m.act(tree => m.createButton(tree).props.onClick())
  assert.deepEqual(plain(m.created[0].memoryConfig), { backend: 'none' })
})

test('M-create-remote: choosing a node creates ON that node — nodeId, the model, no look/memory fields, and the local-only fields disappear', async () => {
  const m = await mount()
  await m.act(tree => m.select(tree, 'Machine').props.onChange({ target: { value: 'n1' } }))
  const tree = m.view()
  assert.equal(m.select(tree, 'Bot type'), undefined, 'no Type select for a node')
  assert.equal(m.select(tree, 'Memory backend'), undefined, 'no Memory Backend select for a node')
  await m.act(t => m.createButton(t).props.onClick())
  assert.equal(m.created.length, 1)
  const body = m.created[0]
  assert.equal(body.nodeId, 'n1')
  assert.equal(body.role, '')
  assert.equal(body.model, 'piion/m1')
  assert.equal('memoryConfig' in body, false, 'the node-side Bot has no main-side memory config')
  assert.equal('avatar' in body, false)
})

test('M-create-worker: a Worker Bot (remote machine type) keeps its hub fields in the body, plus memoryConfig', async () => {
  const m = await mount()
  await m.act(tree => m.select(tree, 'Bot type').props.onChange({ target: { value: 'remote-worker' } }))
  const inputs = find(m.view(), n => n.type === 'input' && ['Hub URL', 'Remote port', 'Enrollment token'].includes(n.props['aria-label']))
  assert.equal(inputs.length, 3, 'the three worker fields appear')
  await m.act(tree => find(tree, n => n.type === 'input' && n.props['aria-label'] === 'Hub URL')[0].props.onChange({ target: { value: ' https://hub.example.com ' } }))
  await m.act(tree => m.createButton(tree).props.onClick())
  const body = m.created[0]
  assert.equal(body.type, 'remote-worker')
  assert.deepEqual(plain(body.worker), { hubUrl: 'https://hub.example.com', remotePort: 19387 })
  assert.deepEqual(plain(body.memoryConfig), { backend: 'auto' })
})
