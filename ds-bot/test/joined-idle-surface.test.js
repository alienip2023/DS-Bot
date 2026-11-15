import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { migrateLegacyJoined, markNodeOffline } from '../src/host/roster-join.js'

const bundle = await build({
  stdin: {
    contents: "export { apply } from './src/client/index.js'; export { createSource, indexRoster } from './src/client/sources.js'; export { threadsStore } from './src/client/threads.js'; export { useLandOnMainBot } from './src/client/sidebar.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function page() {
  const effects = new Map()
  const reactEffects = []
  const values = new Map()
  const module = { exports: {} }
  const react = {
    Component: class {},
    createContext: value => ({ value }), useContext: ctx => ctx.value,
    createElement() {}, useRef: current => ({ current }), useEffect: fn => reactEffects.push(fn),
  }
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: name => name === 'react' ? react : {},
    window: { innerWidth: 1280 }, localStorage: storage,
    setTimeout, clearTimeout, console,
    fetch: async (_url, options) => {
      const { endpoint, payload } = JSON.parse(options.body)
      assert.equal(endpoint, 'threads', 'the fixture must not make external requests')
      return { ok: true, json: async () => ({ ok: true, value: { threads: [{ id: `${payload.botId}:main`, botId: payload.botId, isMain: true, sessionId: 'old' }] } }) }
    },
  })
  const { apply, createSource, indexRoster, threadsStore, useLandOnMainBot } = module.exports
  const list = createSource({ phase: 'ready', byId: { old: { id: 'old', blank: false, retainedBy: { mainView: 1 } } } })
  const opened = []
  let face
  apply({
    effect: (fn, label) => effects.set(label, fn), inject() {}, get() {},
    sessions: { list },
    uiWorkspace: { openSession: id => {
      opened.push(id)
      list.set(state => ({ ...state, byId: Object.fromEntries(Object.entries(state.byId).map(([key, row]) => [key, { ...row, retainedBy: { mainView: key === id ? 1 : 0 } }])) }))
    } },
    slots: {
      entries: () => [], inject: (_name, fn) => fn(),
      register: (options) => { if (options.inject) face = options.inject(); return () => {} },
    },
  })
  const setRoster = (bots, agents = []) => face.hooks.roster.set(indexRoster({ bots, rooms: [], agents, mainBotId: 'chief', mainBotIds: ['chief'] }))
  return { effects, reactEffects, list, opened, face, setRoster, threadsStore, useLandOnMainBot }
}

const remote = () => ({ id: 'joined:n1:rb1', name: 'Remote', sessionId: 'old', origin: 'joined', worker: { home: 'remote', nodeId: 'n1', online: true } })
const chief = { id: 'chief', name: 'Chief' }

test('an idle joined mirror keeps its Bot surface across offline, list refresh and Main Thread cache updates', async () => {
  const p = page()
  const bot = remote()
  p.setRoster([chief, bot])
  const off = p.effects.get('ds-bot: agent surface')()
  try {
    await p.threadsStore.load(bot.id)
    markNodeOffline({ bots: { [bot.id]: bot } }, 'n1')
    p.setRoster([chief, { ...bot }])
    p.list.set(state => ({ ...state, byId: { ...state.byId } }))
    assert.equal(p.face.hooks.surface.getSnapshot().mode, 'bot')
    assert.equal(p.face.hooks.surface.getSnapshot().plain, false)
    assert.deepEqual(p.opened, [])
  } finally { off() }
})

test('a delayed legacy mirror rebuild keeps the idle page on the Bot surface and lets it follow the replacement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-idle-surface-'))
  const p = page()
  const bot = remote()
  p.setRoster([chief, bot])
  const off = p.effects.get('ds-bot: agent surface')()
  try {
    // An expanded row has loaded its Main Thread before background history returns.
    await p.threadsStore.load(bot.id)
    let answer
    let started
    const historyStarted = new Promise(resolve => { started = resolve })
    const sessions = new Map([['old', { session: new Session('old') }]])
    const rt = {
      state: { bots: { [bot.id]: bot } }, dshHome: home,
      resolveAgent: async id => sessions.get(id),
      joinedChatPage: () => new Promise(resolve => { answer = resolve; started() }),
      createSession: async () => { sessions.set('replacement', { session: new Session('replacement') }); return 'replacement' },
      save: async () => {},
    }
    const pending = migrateLegacyJoined(rt)
    await historyStarted
    assert.equal(p.face.hooks.surface.getSnapshot().plain, false)
    answer({ items: [{ kind: 'user', text: 'Hello', turn: 1, seq: 1 }, { kind: 'bot', text: 'Hi', turn: 1, seq: 2 }], cursor: null })
    const result = await pending
    assert.equal(result.migrated.length, 1)
    assert.equal(bot.sessionId, 'replacement')
    assert.equal(bot.legacyMirrorSessionId, 'old')
    p.list.set(state => ({ ...state, byId: { ...state.byId, replacement: { id: 'replacement', retainedBy: {} } } }))
    p.setRoster([chief, { ...bot }])
    assert.equal(p.face.hooks.surface.getSnapshot().mode, 'bot')
    assert.equal(p.face.hooks.surface.getSnapshot().plain, false, 'the old Main mirror must not turn into a plain Thread page')
    p.useLandOnMainBot(p.face.hooks.roster.getSnapshot(), pick => pick(p.list.getSnapshot()), p.face.actions)
    for (const effect of p.reactEffects) effect()
    assert.deepEqual(p.opened, ['replacement'])
    assert.equal(p.list.getSnapshot().byId.replacement.retainedBy.mainView, 1)
    assert.equal(p.face.hooks.surface.getSnapshot().plain, false)
  } finally { off(); rmSync(home, { recursive: true, force: true }) }
})

test('a true Thread and an Agent Session still withdraw the Bot conversation, and explicit Classic mode stays selected', () => {
  const p = page()
  const bot = remote()
  p.setRoster([chief, bot], [{ id: 'agent', sessions: ['agent-session'] }])
  const off = p.effects.get('ds-bot: agent surface')()
  try {
    p.threadsStore.remember('thread-session', bot.id)
    for (const id of ['thread-session', 'agent-session']) {
      p.list.set({ phase: 'ready', byId: { [id]: { id, blank: true, retainedBy: { mainView: 1 } } } })
      assert.equal(p.face.hooks.surface.getSnapshot().plain, true)
    }
    p.face.actions.setSurface('agent')
    p.setRoster([chief, { ...bot, sessionId: 'replacement', legacyMirrorSessionId: 'old' }])
    assert.equal(p.face.hooks.surface.getSnapshot().mode, 'agent')
  } finally { off() }
})
