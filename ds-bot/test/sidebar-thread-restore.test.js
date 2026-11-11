// Restoring a Thread page across a reload: the core restores a Session only when
// its list already shows it, and a Thread's Session is blank. So the page the user
// left is (1) admitted before the core reads the list, and (2) put back after the
// core's restore if it still landed elsewhere — but only while the Host says the
// Thread owns that Session; a deleted Thread must not leave a phantom page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import {
  admitThreadPage,
  forgetThreadPage,
  readThreadPage,
  rememberThreadPage,
  restoreThreadPage,
} from '../src/client/thread-restore.js'
import { threadHomeGuard } from '../src/client/thread-home.js'

const store = () => {
  const values = new Map()
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

const PAGE = { botId: 'secretary', threadId: 't5', sessionId: 'session-5' }

test('the Thread page the user left is remembered and read back', () => {
  const storage = store()
  assert.equal(rememberThreadPage(PAGE, storage), true)
  assert.deepEqual(readThreadPage(storage), PAGE)
  assert.equal(rememberThreadPage({ botId: 'secretary', sessionId: '' }, storage), false)
  forgetThreadPage(storage)
  assert.equal(readThreadPage(storage), undefined)
})

test('a saved blank Thread Session is in the list before the core restores it', () => {
  const storage = store()
  rememberThreadPage(PAGE, storage)
  const byId = {}
  const added = []
  const sessions = {
    list: { getSnapshot: () => ({ byId: { ...byId } }) },
    handleSessionAdded: summary => {
      added.push(summary)
      byId[summary.sessionId] = { id: summary.sessionId, blank: summary.blank === true }
    },
  }
  const page = admitThreadPage(sessions, storage)
  assert.deepEqual(page, PAGE)
  assert.equal(added.length, 1)
  assert.deepEqual(added[0], {
    agentAvailable: true,
    sessionId: 'session-5',
    updatedAt: added[0].updatedAt,
    running: false,
    blank: true,
  })
  // What the core's restore asks before it can reuse the saved Session.
  assert.equal(sessions.list.getSnapshot().byId['session-5'] !== undefined, true)
})

test('with no saved page nothing is admitted', () => {
  const added = []
  const page = admitThreadPage({ handleSessionAdded: summary => added.push(summary) }, store())
  assert.equal(page, undefined)
  assert.deepEqual(added, [])
})

test('the Bot surface does not send a pending Thread page home', async () => {
  const opened = []
  const guard = threadHomeGuard({
    roster: { getSnapshot: () => ({ ready: true, mainBotId: 'chief', byId: { chief: { id: 'chief' } }, roomsById: {} }) },
    mainView: () => 'workspace-blank',
    threadBotOfSession: () => undefined,
    threadOwnerOf: async () => null,
    threadPage: () => PAGE,
    openSession: id => opened.push(id),
  })
  await guard()
  assert.deepEqual(opened, [])
})

test('without a pending page an outside blank Session still goes to the Main Bot', async () => {
  const opened = []
  const guard = threadHomeGuard({
    roster: { getSnapshot: () => ({ ready: true, mainBotId: 'chief', byId: { chief: { id: 'chief' } }, roomsById: {} }) },
    mainView: () => 'workspace-blank',
    threadBotOfSession: () => undefined,
    threadOwnerOf: async () => null,
    threadPage: () => undefined,
    openSession: id => opened.push(id),
  })
  await guard()
  assert.deepEqual(opened, ['chief'])
})

test('the saved page is opened again while the Host still owns the Thread', async () => {
  const opened = []
  const forgotten = []
  const verdict = await restoreThreadPage({
    page: PAGE,
    open: id => opened.push(id),
    ownerOf: async () => ({ botId: 'secretary', threadId: 't5' }),
    forget: () => forgotten.push(true),
  })
  assert.equal(verdict, 'opened')
  assert.deepEqual(opened, ['session-5'])
  assert.deepEqual(forgotten, [])
})

test('a Thread the Host no longer knows is forgotten instead of reopened', async () => {
  const opened = []
  const forgotten = []
  const verdict = await restoreThreadPage({
    page: PAGE,
    open: id => opened.push(id),
    ownerOf: async () => null,
    forget: () => forgotten.push(true),
  })
  assert.equal(verdict, 'gone')
  assert.deepEqual(opened, [])
  assert.deepEqual(forgotten, [true])
})

test('a Host that cannot answer leaves the remembered page alone', async () => {
  const opened = []
  const forgotten = []
  const verdict = await restoreThreadPage({
    page: PAGE,
    open: id => opened.push(id),
    ownerOf: async () => { throw new Error('host down') },
    forget: () => forgotten.push(true),
  })
  assert.equal(verdict, 'unknown')
  assert.deepEqual(opened, [])
  assert.deepEqual(forgotten, [])
})

test('cold start with a restored blank workspace Session: the landing check stays, then the Thread page returns', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: [
        "export { useLandOnMainBot } from './src/client/sidebar.js'",
        "export { threadHomeGuard } from './src/client/thread-home.js'",
        "export { createThreadsStore } from './src/client/threads.js'",
        "export { threadOwnerResolver } from './src/client/thread-owner.js'",
        "export { readThreadPage, restoreThreadPage } from './src/client/thread-restore.js'",
      ].join('\n'),
      resolveDir: join(fileURLToPath(new URL('.', import.meta.url)), '..'),
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const effects = []
  const react = {
    createContext: initial => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
    useContext: ctx => ctx.value,
    useCallback: fn => fn,
    useMemo: make => make(),
    useRef: current => ({ current }),
    useEffect: fn => { effects.push(fn) },
    useLayoutEffect() {},
    useState: initial => [initial, () => {}],
    useId: () => 'id',
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: Symbol('Fragment'),
  }
  let timers = []
  const storage = store()
  const local = { localStorage: storage }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => (name === 'react' ? react : {}),
    window: { innerWidth: 1280 },
    setTimeout: fn => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
    ...local,
  })
  const { useLandOnMainBot, threadHomeGuard: Guard, createThreadsStore, threadOwnerResolver: Resolver, readThreadPage: read, restoreThreadPage: restore } = module.exports

  rememberThreadPage(PAGE, storage)
  const roster = { ready: true, mainBotId: 'chief', byId: { chief: { id: 'chief', sessionId: 'chief' } }, roomsById: {}, agentOf: {} }
  const rows = { 'workspace-blank': { id: 'workspace-blank', blank: true, retainedBy: { mainView: 1 } } }
  const mainView = () => 'workspace-blank'
  const threadStore = createThreadsStore({ request: async () => ({ threads: [] }) })
  const resolver = Resolver({ request: async () => ({ botId: 'secretary', threadId: 't5' }), remember: (id, bot) => threadStore.remember(id, bot) })
  const calls = []
  const home = Guard({
    roster: { getSnapshot: () => roster },
    mainView,
    threadBotOfSession: id => threadStore.botOfSession(id),
    threadOwnerOf: id => resolver(id),
    threadPage: () => read(storage),
    openSession: id => calls.push(['openSession', id]),
  })
  const actions = {
    isAgentSession: () => false,
    threadBotOfSession: id => threadStore.botOfSession(id),
    threadOwnerOf: id => resolver(id),
    landOn: (bot, last) => calls.push(['landOn', bot, last]),
    openSession: id => calls.push(['openSession', id]),
  }
  useLandOnMainBot(roster, selector => selector({ byId: rows }), actions)
  await home()
  for (const effect of effects) effect()
  for (const run of timers) run()
  await Promise.resolve().then(() => Promise.resolve())
  assert.deepEqual(calls, [])
  // The fallback pass puts the remembered page back, and its owner is taught to the cache.
  const verdict = await restore({ page: read(storage), open: id => calls.push(['thread', id]), ownerOf: id => resolver(id), forget: () => forgetThreadPage(storage) })
  assert.equal(verdict, 'opened')
  assert.deepEqual(calls, [['thread', 'session-5']])
  assert.equal(threadStore.botOfSession('session-5'), 'secretary')
})
