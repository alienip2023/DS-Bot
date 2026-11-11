// The sidebar's landing check, driven directly (no React renderer): a Thread
// Session must stay the main view whether or not it has a turn yet — including
// after a reload or a restart, when the Thread cache is still empty and the Host
// is the only one who knows the Session. An outside blank Session still lands on
// the Main Bot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { useLandOnMainBot } from './src/client/sidebar.js'",
      "export { createThreadsStore } from './src/client/threads.js'",
      "export { threadOwnerResolver } from './src/client/thread-owner.js'",
    ].join('\n'),
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
const { useLandOnMainBot, createThreadsStore, threadOwnerResolver } = module.exports

const flush = () => Promise.resolve().then(() => Promise.resolve())
const bot = { id: 'chief', name: 'Chief', sessionId: 'chief', threadIds: ['chief:main'] }
const roster = { ready: true, mainBotId: 'chief', byId: { chief: bot }, roomsById: {}, agentOf: {} }
const threadRow = (id, blank) => ({ [id]: { id, blank, retainedBy: { mainView: 1 } } })

async function drive({ rows, owner, threadOwnerOf, overrides = {} }) {
  const calls = []
  const actions = {
    isAgentSession: () => false,
    threadBotOfSession: id => owner?.(id),
    ...(threadOwnerOf === undefined ? {} : { threadOwnerOf }),
    landOn: (botId, last) => calls.push(['landOn', botId, last]),
    openSession: id => calls.push(['openSession', id]),
    ...overrides,
  }
  effects.length = 0
  timers = []
  useLandOnMainBot(roster, selector => selector({ byId: rows }), actions)
  for (const effect of effects) effect()
  for (const run of timers) run()
  await flush()
  return calls
}

test('a new blank Thread Session stays the main view instead of landing on the Main Bot', async () => {
  const calls = await drive({ rows: threadRow('thread-session', true), owner: id => (id === 'thread-session' ? 'chief' : undefined) })
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

test('a Thread Session that already has a turn stays too', async () => {
  const calls = await drive({ rows: threadRow('thread-session', false), owner: id => (id === 'thread-session' ? 'chief' : undefined) })
  assert.deepEqual(calls, [])
})

test('a blank Session the Host reports as a Thread page stays, and the cache learns it', async () => {
  const known = []
  const resolver = threadOwnerResolver({
    request: async (endpoint, payload) => {
      assert.equal(endpoint, 'thread-owner')
      assert.equal(payload.sessionId, 'session-9')
      return { botId: 'chief', threadId: 'chief:t9' }
    },
    remember: (sessionId, botId) => known.push([sessionId, botId]),
  })
  const calls = await drive({ rows: threadRow('session-9', true), threadOwnerOf: resolver })
  assert.deepEqual(calls, [])
  assert.deepEqual(known, [['session-9', 'chief']])
})

test('a blank Session no Thread owns lands on the Main Bot when the Host says so', async () => {
  const resolver = threadOwnerResolver({ request: async () => null })
  const calls = await drive({ rows: threadRow('session-9', true), threadOwnerOf: resolver })
  assert.deepEqual(calls, [['landOn', 'chief', null]])
})

test('a question that cannot be asked keeps the view instead of guessing', async () => {
  const resolver = threadOwnerResolver({ request: async () => { throw new Error('host down') } })
  const calls = await drive({ rows: threadRow('session-9', true), threadOwnerOf: resolver })
  assert.deepEqual(calls, [])
})

test('after a restart (empty cache) the Host answer still keeps the Thread page, and the next check does not ask', async () => {
  const store = createThreadsStore({ request: async () => ({ threads: [] }) })
  let asked = 0
  const resolver = threadOwnerResolver({
    request: async () => { asked += 1; return { botId: 'chief', threadId: 'chief:t9' } },
    remember: (sessionId, botId) => store.remember(sessionId, botId),
  })
  const first = await drive({ rows: threadRow('session-9', true), threadOwnerOf: resolver, owner: id => store.botOfSession(id) })
  assert.deepEqual(first, [])
  assert.equal(asked, 1)
  assert.equal(store.botOfSession('session-9'), 'chief')
  const second = await drive({ rows: threadRow('session-9', true), threadOwnerOf: resolver, owner: id => store.botOfSession(id) })
  assert.deepEqual(second, [])
  assert.equal(asked, 1)
})

test('a non-blank Session no Bot owns stays: the blank flag is what sends a view home', async () => {
  const calls = await drive({ rows: threadRow('outside-session', false), owner: () => undefined })
  assert.deepEqual(calls, [])
})

test('a blank Session no Bot owns still lands on the Main Bot', async () => {
  const calls = await drive({ rows: threadRow('outside-session', true), owner: () => undefined })
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

test('an owner the Host reported survives a list load that does not mention it yet', async () => {
  const store = createThreadsStore({ request: async () => ({ threads: [] }) })
  store.remember('session-9', 'chief')
  assert.equal(store.botOfSession('session-9'), 'chief')
  await store.load('chief')
  assert.equal(store.botOfSession('session-9'), 'chief')
})
