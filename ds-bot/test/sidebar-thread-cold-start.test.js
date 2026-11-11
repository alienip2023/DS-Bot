// The cold start, in the order the app runs it: the roster becomes ready, the
// surface asks for a team conversation (homeToMainBot), and only then the
// sidebar's landing effect gets its turn. With an empty Thread cache a blank
// Thread Session is unknown to both, so the Host must be asked before anything
// is treated as an outside Session — otherwise the view lands on the Main Bot.
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
      "export { threadHomeGuard } from './src/client/thread-home.js'",
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
const { useLandOnMainBot, threadHomeGuard, createThreadsStore, threadOwnerResolver } = module.exports

const flush = () => Promise.resolve().then(() => Promise.resolve())
const bot = { id: 'chief', name: 'Chief', sessionId: 'chief', threadIds: ['chief:main'] }
const roster = { ready: true, mainBotId: 'chief', byId: { chief: bot }, roomsById: {}, agentOf: {} }

// A cold start: the list knows only the Session's summary, the Thread cache has
// not loaded, and the ownering Bot is the secretary.
async function coldStart({ sessionId, blank, request }) {
  const events = []
  const calls = []
  let asked = 0
  const rows = { [sessionId]: { id: sessionId, blank, retainedBy: { mainView: 1 } } }
  const mainView = () => Object.values(rows).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
  const store = createThreadsStore({ request: async () => ({ threads: [] }) })
  const resolver = threadOwnerResolver({
    request: async (endpoint, payload) => { asked += 1; events.push(['host-ask', payload.sessionId]); return request(endpoint, payload) },
    remember: (id, botId) => store.remember(id, botId),
  })
  // The boot path: roster ready → the surface's home check.
  const home = threadHomeGuard({
    roster: { getSnapshot: () => roster },
    mainView,
    threadBotOfSession: id => store.botOfSession(id),
    threadOwnerOf: id => resolver(id),
    openSession: id => calls.push(['openSession', id]),
  })
  const actions = {
    isAgentSession: () => false,
    threadBotOfSession: id => store.botOfSession(id),
    threadOwnerOf: id => resolver(id),
    landOn: (botId, last) => calls.push(['landOn', botId, last]),
    openSession: id => calls.push(['openSession', id]),
  }
  // The landing effect is mounted at first paint; its timer fires later.
  effects.length = 0
  timers = []
  useLandOnMainBot(roster, selector => selector({ byId: rows }), actions)
  return {
    asked: () => asked,
    store,
    rows,
    home: async () => { events.push(['home']); await home(); events.push(['home-done']) },
    land: () => {
      for (const effect of effects) effect()
      for (const run of timers) { events.push(['landing-timer']); run() }
      return flush().then(() => events)
    },
    calls,
  }
}

test('cold start: the home check and the landing effect both keep a blank Thread Session', async () => {
  const w = await coldStart({ sessionId: 'session-4', blank: true, request: async () => ({ botId: 'secretary', threadId: 't4' }) })
  await w.home()
  const events = await w.land()
  assert.deepEqual(w.calls, [])
  // The boot home check runs before the landing timer: that is the failed order.
  const order = events.map(event => event[0]).filter(name => name !== 'home-done')
  // The boot home check runs before anything else, and it asks the Host first.
  assert.equal(order[0], 'home')
  assert.equal(order[1], 'host-ask')
  // The Host was asked once: the answer taught the cache, so landing did not ask again.
  assert.equal(w.asked(), 1)
  assert.equal(w.store.botOfSession('session-4'), 'secretary')
})

test('cold start: a Thread Session that already has a turn also stays', async () => {
  const w = await coldStart({ sessionId: 'session-3', blank: false, request: async () => ({ botId: 'secretary', threadId: 't3' }) })
  await w.home()
  await w.land()
  assert.deepEqual(w.calls, [])
})

test('cold start: a Session the Host says no Thread owns still lands on the Main Bot', async () => {
  const w = await coldStart({ sessionId: 'session-9', blank: true, request: async () => null })
  await w.home()
  const events = await w.land()
  assert.equal(w.calls.length > 0, true)
  assert.deepEqual([...new Set(w.calls.map(call => call[1]))], ['chief'])
  assert.equal(w.calls.filter(call => call[0] === 'openSession').length, 1)
  assert.equal(events.filter(event => event[0] === 'host-ask').length >= 1, true)
})

test('cold start: a Host that cannot answer keeps the view instead of bouncing', async () => {
  const w = await coldStart({ sessionId: 'session-7', blank: true, request: async () => { throw new Error('host down') } })
  await w.home()
  await w.land()
  assert.deepEqual(w.calls, [])
})

test('a Thread Session the cache already knows is never sent home', async () => {
  const store = createThreadsStore({ request: async () => ({ threads: [] }) })
  store.remember('session-5', 'secretary')
  const calls = []
  const mainView = () => 'session-5'
  const home = threadHomeGuard({
    roster: { getSnapshot: () => roster },
    mainView,
    threadBotOfSession: id => store.botOfSession(id),
    threadOwnerOf: () => assert.fail('a known Thread Session must not ask the Host'),
    openSession: id => calls.push(id),
  })
  await home()
  assert.deepEqual(calls, [])
})
