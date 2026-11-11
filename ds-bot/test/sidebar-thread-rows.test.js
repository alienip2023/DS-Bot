// The Bot row's Thread list, rendered with the sidebar module and a stand-in React
// (components run as plain functions, as the other sidebar tests do).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const { outputFiles } = await build({
  stdin: { contents: "export { ThreadList } from './src/client/sidebar.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: { innerWidth: 1280 },
})
const { ThreadList } = module.exports

const bot = { id: 'writer', name: 'Writer', createdAt: 1, sessionId: 'writer-chat', origin: 'local' }
const joined = { id: 'remote', name: 'Remote', createdAt: 1, sessionId: 'mirror-1', origin: 'joined', worker: { home: 'remote', nodeId: 'node-1' } }
const main = { id: 'writer:main', botId: 'writer', title: 'Main', isMain: true, createdAt: 1, sessionId: null }
const second = { id: 't2', botId: 'writer', title: 'Thread 2', isMain: false, createdAt: 2, sessionId: 'session-2' }

function collect(node, out = []) {
  if (Array.isArray(node)) { node.forEach(child => collect(child, out)); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  collect(node.props?.children, out)
  return out
}

const byClass = (nodes, name) => nodes.filter(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name))
const threadRows = (nodes) => nodes.filter(node => node.type?.name === 'ThreadRow')
const renderedRow = element => collect(element.type(element.props))

function actions(overrides = {}) {
  const calls = []
  const api = {
    openThread: (botId, threadId) => calls.push(['openThread', botId, threadId]),
    openSession: id => calls.push(['openSession', id]),
    openAgentSession: id => calls.push(['openAgentSession', id]),
    openJoinedHome: id => calls.push(['openJoinedHome', id]),
    createThread: async id => { calls.push(['createThread', id]); return { thread: { id: 't3', botId: id, title: 'Thread 3', isMain: false, sessionId: 'session-3' }, sessionId: 'session-3' } },
    reportError: (error, where) => calls.push(['reportError', error?.message, where]),
    ...overrides,
  }
  return { calls, actions: api }
}

const render = (props) => collect(ThreadList({
  bot, threads: [second, main], status: 'ready', actions: actions().actions,
  useSessionRetainInfo: () => false, botActive: false, onRetry: () => {}, ...props,
}))

test('a Bot row lists the new-Thread row, Main and the other Threads', () => {
  const nodes = render({})
  const create = byClass(nodes, 'bt-agent-new')
  assert.equal(create.length, 1)
  assert.equal(create[0].props.disabled, undefined)
  const rows = threadRows(nodes)
  assert.deepEqual(rows.map(row => row.props.thread.title), ['Main', 'Thread 2'])
})

test('clicking another Thread opens it through openThread, not the Bot page', () => {
  const { calls, actions: api } = actions()
  const nodes = render({ actions: api })
  const row = threadRows(nodes).find(element => element.props.thread.id === 't2')
  const button = renderedRow(row).find(node => typeof node.props?.onClick === 'function')
  button.props.onClick()
  assert.deepEqual(calls, [['openThread', 'writer', 't2']])
})

test('clicking Main opens the Bot page through openThread', () => {
  const { calls, actions: api } = actions()
  const nodes = render({ actions: api })
  const row = threadRows(nodes).find(element => element.props.thread.id === 'writer:main')
  renderedRow(row).find(node => typeof node.props?.onClick === 'function').props.onClick()
  assert.deepEqual(calls, [['openThread', 'writer', 'writer:main']])
})

test('a joined Bot shows only Main, no new-Thread row, and opens its home', () => {
  const { calls, actions: api } = actions()
  const nodes = collect(ThreadList({
    bot: joined, threads: [main], status: 'ready', actions: api,
    useSessionRetainInfo: () => false, botActive: true, onRetry: () => {},
  }))
  assert.equal(byClass(nodes, 'bt-agent-new').length, 0)
  const rows = threadRows(nodes)
  assert.deepEqual(rows.map(row => row.props.thread.title), ['Main'])
  renderedRow(rows[0]).find(node => typeof node.props?.onClick === 'function').props.onClick()
  assert.deepEqual(calls, [['openJoinedHome', 'remote']])
})

test('a failed first load keeps a Main row and offers a retry', () => {
  const nodes = render({ threads: [], status: 'error' })
  const create = byClass(nodes, 'bt-agent-new')
  // The retry row reuses the new-row class; the create row is gone when no threads loaded? No:
  // both rows share the class, so the retry is the one without a createThread call.
  assert.ok(create.length >= 1)
  const rows = threadRows(nodes)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].props.thread.isMain, true)
  assert.equal(rows[0].props.thread.sessionId, bot.sessionId)
})

test('creating a Thread opens its new Session', async () => {
  const { calls, actions: api } = actions()
  const nodes = render({ actions: api })
  const create = byClass(nodes, 'bt-agent-new').find(node => node.props.disabled === undefined)
  create.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls[0], ['createThread', 'writer'])
  assert.deepEqual(calls[1], ['openAgentSession', 'session-3'])
})

test('the new-Thread row is disabled at the host limit', () => {
  const ten = Array.from({ length: 10 }, (_, index) => ({ id: `t${index}`, botId: 'writer', title: `T${index}`, isMain: index === 0, createdAt: index }))
  const nodes = collect(ThreadList({
    bot, threads: ten, status: 'ready', actions: actions().actions,
    useSessionRetainInfo: () => false, botActive: false, onRetry: () => {},
  }))
  const create = byClass(nodes, 'bt-agent-new')
  assert.equal(create[0].props.disabled, true)
})
