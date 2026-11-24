// Work model W1/W4: what comes back for a work shows on the asker's page — who handed back, opening their conversation — both where
// the message opens a turn (TriggerCell, a hub Bot) and where it is a context message (a node Bot's page on the hub,
// whose copy carries no inbox claims).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRelayContext } from '../src/client/text.js'


import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const { outputFiles } = await build({
  stdin: { contents: "export { ResultsLine } from './src/client/cells.js'", resolveDir: PLUGIN },
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
const { ResultsLine } = module.exports

function collect(node, out = []) {
  if (Array.isArray(node)) { node.forEach(child => collect(child, out)); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  collect(node.props?.children, out)
  return out
}

test('a hand-back shows who handed it back, only their name, and the name opens the pair\'s conversation', () => {
  const text = '[Work handed back to you · from node011执行 · everything you handed on is back]\nnode011执行:\n16 核，负载 0.83'
  const roster = { byId: { 'joined:node011:s': { id: 'joined:node011:s', name: 'node011执行', color: 'orange' } } }
  const opened = []
  const out = ResultsLine({ source: { kind: 'bot', role: 'results', resultFrom: ['joined:node011:s'] }, content: [{ type: 'text', text }], roster, selfId: 'me', actions: { openExchange: (...args) => opened.push(args) } })
  const nodes = collect(out)
  assert.equal(JSON.stringify(nodes).includes('16 核'), false, 'what came back is not shown on the page')
  const line = nodes.find(node => node.props?.bots !== undefined)
  assert.equal(JSON.stringify(line.props.bots.map(bot => bot.name)), JSON.stringify(['node011执行']))
  line.props.onOpen(line.props.bots[0])
  assert.equal(JSON.stringify(opened), JSON.stringify([['me', 'joined:node011:s']]))
})

test('a hand-back whose Bots the page does not know still names them, from the note', () => {
  const roster = { byId: { a: { id: 'a', name: 'Writer' } } }
  const out = ResultsLine({ source: { kind: 'bot', role: 'results', resultFrom: ['peer:hub:x:unknown'], note: 'Writer, Ghost' }, content: [{ type: 'text', text: '[Work handed back to you · from Writer, Ghost]\nWriter:\nok' }], roster, selfId: 'me', actions: { openExchange() {} } })
  const line = collect(out).find(node => node.props?.bots !== undefined)
  assert.equal(JSON.stringify(line.props.bots.map(bot => bot.name)), JSON.stringify(['Writer', 'Ghost']))
})

test('a results message is a relay context, so a copied page draws it', () => {
  assert.equal(isRelayContext({ source: { kind: 'bot', role: 'results', resultFrom: ['x'] } }), true)
  assert.equal(isRelayContext({ source: { kind: 'bot', role: 'results', deferred: true } }), false)
  assert.equal(isRelayContext({ source: { kind: 'bot', role: 'request' } }), false, 'a request still needs its sender')
})
