// The settings panel says when a joined Bot's node is too old to federate, instead of
// offering a backend the node would drop.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: { contents: "export { BotSettingsForm } from './src/client/bot-settings.js'\n", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let hooks
const react = {
  createContext: initial => ({ value: initial, Provider: ({ children }) => children }),
  useContext: ctx => ctx.value, useCallback: fn => fn, useMemo: make => make(), useId: () => 'id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect(fn) { hooks.effects.push(fn) }, useLayoutEffect() {},
  useState(initial) {
    const i = hooks.i++
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === 'function' ? initial() : initial
    return [hooks.slots[i], value => { hooks.slots[i] = typeof value === 'function' ? value(hooks.slots[i]) : value }]
  },
  useRef(initial) { const i = hooks.i++; hooks.slots[i] ??= { current: initial }; return hooks.slots[i] },
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : {}), window: {}, document: { body: {} }, navigator: {}, setTimeout, clearTimeout, console })
const { BotSettingsForm } = module.exports

const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (!node || typeof node !== 'object') return
  visit(node); walk(node.props?.children, visit)
}
const textOf = tree => { const parts = []; walk(tree, n => { for (const c of [n.props?.children].flat()) if (typeof c === 'string') parts.push(c) }); return parts.join(' ') }

async function render(props) {
  hooks = { i: 0, slots: {}, effects: [] }
  BotSettingsForm(props)
  for (const effect of hooks.effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  hooks.i = 0; hooks.effects = []
  return BotSettingsForm(props)
}

const bot = { id: 'joined:n1:rb1', name: 'Scout', role: '', origin: 'joined', worker: { home: 'remote', nodeId: 'n1' } }
const roster = { memoryFederation: { canFederate: true, hub: true } }
const actions = nodes => ({ botCreateTargets: async () => nodes, updateBot: async () => {}, refreshModels: async () => {} })

test('an old node shows the reason instead of offering federation', async () => {
  const tree = await render({ bot, roster, actions: actions([{ nodeId: 'n1', federates: false }]), run: fn => fn })
  const text = textOf(tree)
  assert.match(text, /too old for federated memory/, 'the panel names the reason')
  const memory = []
  walk(tree, n => { if (n.type === 'select' && n.props['aria-label'] === 'Memory backend') memory.push(n) })
  assert.equal(memory.length, 1)
  assert.equal(memory[0].props.value, 'auto', 'the shown backend is the node\'s real one, not federation')
})
