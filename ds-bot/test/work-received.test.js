// Work model W2: what another Bot handed a Bot is done in its work thread, not in its chat. Its chat says so where it
// happened — between the turn before and the turn after — with the work thread to open (a node Bot's is the hub copy).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const { outputFiles } = await build({
  stdin: { contents: "export { WorkTurnTail } from './src/client/cells.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = new Proxy({
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useState: initial => [initial, () => {}], useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }),
  useCallback: fn => fn, createContext: value => ({ value, Provider: () => null }), useContext: ctx => ctx?.value, useId: () => 'id',
  useSyncExternalStore: (s, get) => get(), memo: fn => fn, forwardRef: fn => fn,
}, { get: (target, key) => target[key] ?? (() => null) })
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : new Proxy({}, { get: () => () => null })), window: { innerWidth: 1280, matchMedia: () => ({ matches: false, addEventListener() {} }) }, document: { createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { dataset: {} } }, navigator: { userAgent: '', platform: '' }, localStorage: { getItem: () => null, setItem() {} } })
const { WorkTurnTail } = module.exports

function collect(node, out = []) {
  if (Array.isArray(node)) { node.forEach(child => collect(child, out)); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  collect(node.props?.children, out)
  return out
}
const n12 = { id: 'joined:node012:a', name: 'node012执行', color: 'orange' }
const n11 = {
  id: 'joined:node011:b', name: 'node011执行', sessionId: 'page-11',
  tasks: [
    { id: 'w1', title: '@node012执行 · 工作', origin: 'bot-work', status: 'standing', remote: true, viewable: true, updatedAt: 150 },
    { id: 'w2', title: '@军团司令 · 工作', origin: 'bot-work', status: 'running', remote: true, viewable: true, updatedAt: 400 },
    { id: 'w3', title: '@Ghost · 工作', origin: 'bot-work', status: 'standing', remote: true, updatedAt: 160 },
    { id: 'b1', title: 'a background task', origin: 'fg-handoff', status: 'running', updatedAt: 170 },
  ],
}
const roster = { byId: { 'page-11': n11, [n11.id]: n11, [n12.id]: n12 } }
const render = ({ end, next, calls = [] }) => collect(WorkTurnTail({
  turn: { turn: 3, end: { time: end } }, sessionId: 'page-11',
  useRoster: pick => pick(roster), useTurnClock: pick => pick({ 'page-11': next === undefined ? {} : { 4: { first: next } } }),
  actions: { openTask: (...args) => calls.push(args) },
}))
const lines = nodes => nodes.filter(node => node.props?.className === 'bt-event-whole')

test('a work thread active between this turn and the next shows in the chat, naming who handed it the work, and opens it', () => {
  const calls = []
  const nodes = render({ end: 100, next: 200, calls })
  const shown = lines(nodes)
  assert.equal(shown.length, 1, 'only w1: w2 is later, w3 has no copy here, b1 is not a work thread')
  assert.equal(JSON.stringify(collect(shown[0]).filter(n => n.props?.bot).map(n => n.props.bot.name)), JSON.stringify(['node012执行']))
  shown[0].props.onClick()
  assert.equal(JSON.stringify(calls), JSON.stringify([['page-11', 'joined:node011:b', 'w1']]))
})

test('after the last turn, the work since then shows, and one still running says so', () => {
  const shown = lines(render({ end: 300 }))
  assert.equal(shown.length, 1)
  assert.equal(shown[0].props.title, '@军团司令 · 工作')
  assert.match(JSON.stringify(collect(shown[0]).map(n => n.props?.children)), /Working on work from/)
})

test('a turn with no work handed to the Bot after it adds nothing', () => {
  assert.equal(lines(render({ end: 500 })).length, 0)
})
