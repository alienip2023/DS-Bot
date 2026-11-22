import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: { contents: "export { TeamSidebar } from './src/client/sidebar.js'", resolveDir: PLUGIN },
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
  module, exports: module.exports, window: { innerWidth: 1280 },
  document: { body: {}, documentElement: { hasAttribute: () => false }, querySelector: () => null },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: child => child } : {}),
})
const { TeamSidebar } = module.exports

const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props ?? {}))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}

const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const classes = node => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean)

const noopActions = Object.fromEntries(
  ['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread', 'openTaskDeck', 'saveSection', 'beginSectionRename', 'endSectionRename', 'reportError'].map(name => [name, () => {}]),
)

function renderSidebar({
  bots = [],
  rooms = [],
  sections = [],
  rosterExtra = {},
  work = { waiting: {}, rooms: {}, approvals: [] },
  computer = { asks: {} },
  activity = {},
  statusMap = new Map(),
  activeSession = null,
  wide = true,
} = {}) {
  const byId = Object.fromEntries(bots.flatMap(bot => [[bot.id, bot], ...(bot.sessionId ? [[bot.sessionId, bot]] : [])]))
  const roomsById = Object.fromEntries(rooms.flatMap(room => [[room.id, room], ...(room.sessionId ? [[room.sessionId, room]] : [])]))
  const roster = {
    bots, rooms, agents: [], sections, byId, roomsById, agentsById: {},
    exchangeTurns: {}, questions: {}, views: {}, learning: {},
    secretRequests: {}, connectorRequests: {}, mailRequests: {},
    ready: true, ...rosterExtra,
  }
  const tree = TeamSidebar({
    actions: noopActions,
    useSidebarPref: () => (wide ? 'open' : 'rail'),
    useRoster: pick => pick(roster),
    useUi: pick => pick({ unread: {} }),
    useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: activeSession ? [activeSession] : [], byId: activeSession ? { [activeSession]: { id: activeSession, retainedBy: { mainView: 1 } } } : {} }),
    useUpdate: () => ({}),
    useSessionStatus: pick => pick(statusMap),
    useSessionRetainInfo: (id, pick) => pick(id === activeSession ? { retainedBy: { mainView: 1 } } : {}),
    useActivity: pick => pick(activity),
    useWork: pick => pick(work),
    useComputer: pick => pick(computer),
  })
  return expand(tree)
}

const node = (over = {}) => ({
  id: 'joined:n1:rb1', name: 'Remote', origin: 'joined', type: 'remote-worker', sessionId: 'mirror-1', createdAt: 2,
  worker: { nodeId: 'n1', remoteBotId: 'rb1', hostname: 'desk-1', home: 'remote', online: true },
  ...over,
})
const rowOf = tree => walk(tree, item => item.props?.['data-bot-id'] === 'joined:n1:rb1')[0]
const lineOf = row => walk(row, item => classes(item).includes('bt-row-preview'))[0]

test('a quiet node Bot row names where it runs', () => {
  const line = lineOf(rowOf(renderSidebar({ bots: [node()] })))
  assert.equal(textOf(line), 'Running on desk-1')
})

test('a node Bot waiting for the user shows the wait line, like a hub Bot, not the machine', () => {
  const learning = { 'joined:n1:rb1': [{ id: 'p1', kind: 'skill', name: 'release-notes' }] }
  const line = lineOf(rowOf(renderSidebar({ bots: [node()], rosterExtra: { learning } })))
  assert.equal(textOf(line), 'Waiting for your approval')
  assert.ok(classes(line).includes('bt-row-preview-wait'))
})

test('a node Bot that is working shows what it does, not the machine', () => {
  const line = lineOf(rowOf(renderSidebar({
    bots: [node()], activity: { 'joined:n1:rb1': 'tool' }, statusMap: new Map([['mirror-1', { running: true }]]),
  })))
  assert.ok(line !== undefined)
  assert.doesNotMatch(textOf(line), /Running on/)
  assert.match(textOf(line), /…$/)
})

test('a node Bot that waits for another Bot shows who, not the machine', () => {
  const helper = { id: 'helper', name: 'Helper', createdAt: 3 }
  const line = lineOf(rowOf(renderSidebar({
    bots: [node(), helper], activity: { 'joined:n1:rb1': 'waiting' },
    work: { waiting: { 'joined:n1:rb1': { bots: ['helper'], rooms: [] } }, rooms: {}, approvals: [] },
  })))
  assert.equal(textOf(line), 'Waiting for Helper')
})

test('an offline node, or one that needs an update, rides on whichever line the row shows', () => {
  const offline = node({ worker: { nodeId: 'n1', remoteBotId: 'rb1', hostname: 'desk-1', home: 'remote', online: false } })
  assert.equal(textOf(lineOf(rowOf(renderSidebar({ bots: [offline] })))), 'Running on desk-1 · 离线')
  const learning = { 'joined:n1:rb1': [{ id: 'p1', kind: 'skill', name: 'x' }] }
  assert.equal(textOf(lineOf(rowOf(renderSidebar({ bots: [offline], rosterExtra: { learning } })))), 'Waiting for your approval · 离线')
})
