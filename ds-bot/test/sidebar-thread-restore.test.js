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
import { createThreadsStore } from '../src/client/threads.js'
import { threadOwnerResolver } from '../src/client/thread-owner.js'

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

test('the restore kept the page: the Host answer still teaches the Thread cache', async () => {
  const threads = createThreadsStore({ request: async () => ({ threads: [] }) })
  const resolver = threadOwnerResolver({
    request: async () => ({ botId: 'secretary', threadId: 't5' }),
    remember: (sessionId, botId) => threads.remember(sessionId, botId),
  })
  const opened = []
  const verdict = await restoreThreadPage({
    page: PAGE,
    open: id => opened.push(id),
    ownerOf: id => resolver(id),
    forget: () => assert.fail('a confirmed page must not be forgotten'),
    alreadyOpen: true,
  })
  assert.equal(verdict, 'opened')
  assert.deepEqual(opened, [])
  // `plain` reads this cache, so the surface recomputes without a list change.
  assert.equal(threads.botOfSession('session-5'), 'secretary')
})

test('a Thread the Host no longer knows returns the restored page to its Bot', async () => {
  const opened = []
  const forgotten = []
  const home = []
  const verdict = await restoreThreadPage({
    page: PAGE,
    open: id => opened.push(id),
    ownerOf: async () => null,
    forget: () => forgotten.push(true),
    home: () => home.push('chief'),
    alreadyOpen: true,
  })
  assert.equal(verdict, 'gone')
  assert.deepEqual(opened, [])
  assert.deepEqual(forgotten, [true])
  assert.deepEqual(home, ['chief'])
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

async function sidebarFixture() {
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
  const timers = []
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
  const storage = store()
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => (name === 'react' ? react : {}),
    window: { innerWidth: 1280 },
    setTimeout: fn => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
    localStorage: storage,
  })
  return { m: module.exports, storage, effects, timers }
}

const runEffects = (fixture) => { for (const effect of fixture.effects) effect() }
const runTimers = (fixture) => { for (const run of fixture.timers) run() }
const flush = async () => { for (let round = 0; round < 6; round += 1) await Promise.resolve() }

const ROSTER = { ready: true, mainBotId: 'chief', byId: { chief: { id: 'chief', sessionId: 'chief' } }, roomsById: {}, agentOf: {} }

test('cold start with a restored blank workspace Session: the landing check stays, then the Thread page returns', async () => {
  const fixture = await sidebarFixture()
  const { useLandOnMainBot: Hook, threadHomeGuard: Guard, createThreadsStore, threadOwnerResolver: Resolver, readThreadPage: read, restoreThreadPage: restore } = fixture.m
  rememberThreadPage(PAGE, fixture.storage)
  const rows = { 'workspace-blank': { id: 'workspace-blank', blank: true, retainedBy: { mainView: 1 } } }
  const mainView = () => 'workspace-blank'
  const threadStore = createThreadsStore({ request: async () => ({ threads: [] }) })
  const resolver = Resolver({ request: async () => ({ botId: 'secretary', threadId: 't5' }), remember: (id, bot) => threadStore.remember(id, bot) })
  const calls = []
  const home = Guard({
    roster: { getSnapshot: () => ROSTER },
    mainView,
    threadBotOfSession: id => threadStore.botOfSession(id),
    threadOwnerOf: id => resolver(id),
    threadPage: () => read(fixture.storage),
    openSession: id => calls.push(['openSession', id]),
  })
  const actions = {
    hasThreadPage: () => read(fixture.storage) !== undefined,
    isAgentSession: () => false,
    threadBotOfSession: id => threadStore.botOfSession(id),
    threadOwnerOf: id => resolver(id),
    landOn: (bot, last) => calls.push(['landOn', bot, last]),
    openSession: id => calls.push(['openSession', id]),
  }
  Hook(ROSTER, selector => selector({ byId: rows }), actions)
  await home()
  runEffects(fixture)
  runTimers(fixture)
  await flush()
  assert.deepEqual(calls, [])
  // The fallback pass puts the remembered page back, and its owner is taught to the cache.
  const verdict = await restore({ page: read(fixture.storage), open: id => calls.push(['thread', id]), ownerOf: id => resolver(id), forget: () => forgetThreadPage(fixture.storage) })
  assert.equal(verdict, 'opened')
  assert.deepEqual(calls, [['thread', 'session-5']])
  assert.equal(threadStore.botOfSession('session-5'), 'secretary')
})

test('an empty main view with a pending Thread page never lands on the Main Bot', async () => {
  const fixture = await sidebarFixture()
  rememberThreadPage(PAGE, fixture.storage)
  const calls = []
  const actions = {
    hasThreadPage: () => fixture.m.readThreadPage(fixture.storage) !== undefined,
    isAgentSession: () => false,
    threadBotOfSession: () => undefined,
    threadOwnerOf: async () => ({ botId: 'secretary', threadId: 't5' }),
    landOn: (bot, last) => calls.push(['landOn', bot, last]),
    openSession: id => calls.push(['openSession', id]),
  }
  fixture.m.useLandOnMainBot(ROSTER, selector => selector({ byId: {} }), actions)
  runEffects(fixture)
  runTimers(fixture)
  await flush()
  assert.deepEqual(calls, [])
})

test('an unowned blank Session yields to the pending Thread page, which then opens', async () => {
  const fixture = await sidebarFixture()
  rememberThreadPage(PAGE, fixture.storage)
  const rows = { 'workspace-blank': { id: 'workspace-blank', blank: true, retainedBy: { mainView: 1 } } }
  const threadStore = fixture.m.createThreadsStore({ request: async () => ({ threads: [] }) })
  const resolver = fixture.m.threadOwnerResolver({ request: async () => ({ botId: 'secretary', threadId: 't5' }), remember: (id, bot) => threadStore.remember(id, bot) })
  const calls = []
  const actions = {
    hasThreadPage: () => fixture.m.readThreadPage(fixture.storage) !== undefined,
    isAgentSession: () => false,
    threadBotOfSession: id => threadStore.botOfSession(id),
    threadOwnerOf: id => resolver(id),
    landOn: (bot, last) => calls.push(['landOn', bot, last]),
    openSession: id => calls.push(['openSession', id]),
  }
  fixture.m.useLandOnMainBot(ROSTER, selector => selector({ byId: rows }), actions)
  runEffects(fixture)
  runTimers(fixture)
  await flush()
  assert.deepEqual(calls, [])
  const verdict = await fixture.m.restoreThreadPage({ page: fixture.m.readThreadPage(fixture.storage), open: id => calls.push(['thread', id]), ownerOf: id => resolver(id), forget: () => {} })
  assert.equal(verdict, 'opened')
  assert.deepEqual(calls, [['thread', 'session-5']])
})
