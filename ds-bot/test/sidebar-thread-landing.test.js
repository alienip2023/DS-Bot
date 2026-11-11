// The sidebar's landing check, driven directly (no React renderer): a Thread
// Session must stay the main view whether or not it has a turn yet, and an
// outside blank Session must still land on the Main Bot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const { outputFiles } = await build({
  stdin: {
    contents: "export { useLandOnMainBot } from './src/client/sidebar.js'\nexport { createThreadsStore } from './src/client/threads.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const effects = []
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useMemo: make => make(),
  useRef: current => ({ current }),
  useEffect: (fn) => { effects.push(fn) },
  useLayoutEffect() {},
  useState: initial => [initial, () => {}],
  useId: () => 'id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
}

let timers = []
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: { innerWidth: 1280 },
  setTimeout: (fn) => { timers.push(fn); return timers.length },
  clearTimeout: () => {},
})
const { useLandOnMainBot, createThreadsStore } = module.exports

const bot = { id: 'chief', name: 'Chief', sessionId: 'chief', threadIds: ['chief:main'] }
const roster = { ready: true, mainBotId: 'chief', byId: { chief: bot }, roomsById: {}, agentOf: {} }

const threadRow = (id, blank) => ({ [id]: { id, blank, retainedBy: { mainView: 1 } } })

function drive({ rows, owner, overrides = {} }) {
  const calls = []
  const actions = {
    isAgentSession: () => false,
    threadBotOfSession: id => owner?.(id),
    landOn: (botId, last) => calls.push(['landOn', botId, last]),
    openSession: id => calls.push(['openSession', id]),
    ...overrides,
  }
  effects.length = 0
  timers = []
  useLandOnMainBot(roster, selector => selector({ byId: rows }), actions)
  for (const effect of effects) effect()
  for (const run of timers) run()
  return calls
}

test('a new blank Thread Session stays the main view instead of landing on the Main Bot', () => {
  const calls = drive({ rows: threadRow('thread-session', true), owner: id => (id === 'thread-session' ? 'chief' : undefined) })
  assert.deepEqual(calls, [])
})

test('the same Thread Session still stays after a roster refresh', () => {
  const owner = id => (id === 'thread-session' ? 'chief' : undefined)
  const actions = {
    isAgentSession: () => false,
    threadBotOfSession: owner,
    landOn: () => assert.fail('a Thread Session must not land on the Main Bot'),
    openSession: () => assert.fail('a Thread Session must not be reopened'),
  }
  effects.length = 0
  useLandOnMainBot(roster, selector => selector({ byId: threadRow('thread-session', true) }), actions)
  for (const effect of effects) effect()
  useLandOnMainBot({ ...roster, revision: 2 }, selector => selector({ byId: threadRow('thread-session', true) }), actions)
  for (const effect of effects.slice(1)) effect()
  for (const run of timers) run()
})

test('a Thread Session that already has a turn stays too', () => {
  const calls = drive({ rows: threadRow('thread-session', false), owner: id => (id === 'thread-session' ? 'chief' : undefined) })
  assert.deepEqual(calls, [])
})

test('a non-blank Session no Bot owns stays: the blank flag is what sends a view home', () => {
  const calls = drive({ rows: threadRow('outside-session', false), owner: () => undefined })
  assert.deepEqual(calls, [])
})

test('a blank Session no Bot owns still lands on the Main Bot', () => {
  const calls = drive({ rows: threadRow('outside-session', true), owner: () => undefined })
  assert.deepEqual(calls, [['landOn', 'chief', null]])
})

test('the Thread cache answers which Bot a Thread Session belongs to', async () => {
  const store = createThreadsStore({ request: async () => ({ threads: [{ id: 't2', sessionId: 'thread-session' }] }) })
  await store.load('writer')
  assert.equal(store.botOfSession('thread-session'), 'writer')
  assert.equal(store.botOfSession('someone-else'), undefined)
  store.reset()
  assert.equal(store.botOfSession('thread-session'), undefined)
})

test('a Thread created through the cache is indexed by its Session at once', async () => {
  const store = createThreadsStore({ request: async () => ({ thread: { id: 't3', sessionId: 'new-session' }, sessionId: 'new-session' }) })
  await store.create('writer')
  assert.equal(store.botOfSession('new-session'), 'writer')
})
