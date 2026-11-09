import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { realTeamActions, hostRoster, joinedRuntime } from './bot-home-fixtures.js'

// Wiring: the REAL sidebar BotRow and the REAL cells GroupMessage lead button, rendered with
// a minimal React stand-in (components run as plain functions, like sidebar-switch.test.js),
// must route a joined Bot click through botRowClick -> the real teamActions
// (botHomeEnabled / botHasHome) -> the core's openSession. The roster is built from a real
// runtime's chatOf, so the "not chatted yet" shape is the one the host really sends.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar } from './src/client/sidebar.js'\nexport { GroupMessage } from './src/client/cells.js'",
    resolveDir: PLUGIN,
  },
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
const { TeamSidebar, GroupMessage } = module.exports

const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
  walk(node.props?.lead, visit) // the non-flat layout hands the lead button to Bubbles as a prop
}
const find = (tree, match) => { const hits = []; walk(tree, node => { if (match(node)) hits.push(node) }); return hits }

// The page's actions: the REAL teamActions (openJoinedHome, botHasHome) over a roster that a
// real runtime's chatOf produced, with spies for the core's navigation. `joined-ensure` is
// answered the way channel.js does: the Bot gets its mirror sessionId and the team is read again.
function pageActions(rt) {
  const calls = []
  let roster = hostRoster(rt)
  const real = realTeamActions(roster, {
    roster: { getSnapshot: () => roster },
    call: async (endpoint, body) => {
      calls.push([endpoint, body.botId])
      if (endpoint === 'joined-ensure') rt.state.bots[body.botId].sessionId = 'sess-mirror-new'
      return {}
    },
    after: async (promise) => { const value = await promise; roster = hostRoster(rt); return value },
    openSession: id => calls.push(['openSession', id]),
  })
  const actions = {
    ...real,
    openSession: id => calls.push(['openSession', id]),
    openJoinedChat: id => calls.push(['openJoinedChat', id]),
    openMenu() {}, toggleSidebar() {}, setLeftDrawer() {}, clearUnread() {},
  }
  return { calls, actions, roster: () => roster }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

async function sidebarClick(rt, botId) {
  const { calls, actions, roster } = pageActions(rt)
  const tree = TeamSidebar({
    wide: true, actions,
    useRoster: pick => pick(roster()), useUi: pick => pick({ unread: {}, leftDrawer: false }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map()), useSessionRetainInfo: (part, pick) => pick(undefined),
    useActivity: pick => pick({}), useWork: pick => pick({ rooms: {}, waiting: {} }),
  })
  const [row] = find(tree, node => node.type?.name === 'BotRow' && node.props.bot.id === botId)
  assert.ok(row, 'the sidebar must render a BotRow for the Bot')
  const [button] = find(row.type(row.props), node => node.type === 'button' && node.props.className === 'bt-row')
  assert.ok(button, 'BotRow must render its bt-row button')
  button.props.onClick()
  await settle()
  return calls
}

async function cellsClick(rt, botId) {
  const { calls, actions, roster } = pageActions(rt)
  const bot = roster().byId[botId]
  const tree = GroupMessage({
    bot, text: 'hi', room: { id: 'room', name: 'Team', members: [bot.id], createdAt: 1 }, roster: roster(), actions,
    useUi: pick => pick({}), time: 1, duration: 1,
  })
  const [lead] = find(tree, node => node.type === 'button' && node.props.className === 'bt-lead')
  assert.ok(lead, 'GroupMessage must render its bt-lead button')
  lead.props.onClick()
  await settle()
  return calls
}

for (const [name, click] of [['sidebar BotRow', sidebarClick], ['cells GroupMessage lead', cellsClick]]) {
  test(`S23b-wiring ${name}: joined Bot not chatted yet -> joined-ensure, then openSession(bot.id); never the dialog`, async () => {
    assert.deepEqual(await click(joinedRuntime(), 'bot-j1'), [['joined-ensure', 'bot-j1'], ['openSession', 'bot-j1']])
  })

  test(`S23b-wiring ${name}: joined Bot with a mirror session -> openSession(bot.id) once, no ensure`, async () => {
    assert.deepEqual(await click(joinedRuntime({ mirrorSessionId: 'sess-mirror' }), 'bot-j1'), [['openSession', 'bot-j1']])
  })

  test(`S23b-wiring ${name}: a local Bot always opens its session`, async () => {
    const rt = joinedRuntime()
    rt.state.bots['bot-l1'] = { id: 'bot-l1', name: 'Local', origin: 'local', type: 'local' }
    assert.deepEqual(await click(rt, 'bot-l1'), [['openSession', 'bot-l1']])
  })
}
