// s50 (D1 = A): the sidebar of the merged build shows upstream's sections (state.sections) AND this fork's custom Bot
// groups (state.groups: collapsible header, delete, rename, "+ 新建分组") — the groups render old-style with the
// ungrouped rows, sections render as SectionBlocks, and a Bot row still opens a joined (remote) Bot through
// openJoinedHome while carrying upstream's drag handle. The REAL TeamSidebar is bundled from disk and rendered with a
// stand-in React, every component expanded to plain elements.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

async function loadSidebar() {
  const { outputFiles } = await build({
    stdin: { contents: "export { TeamSidebar } from './src/client/sidebar.js'", resolveDir: PLUGIN },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const react = {
    createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
    useContext: ctx => ctx.value,
    useCallback: fn => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length <= 1 ? children[0] : children } }),
    Fragment: Symbol('Fragment'),
    useEffect() {}, useLayoutEffect() {},
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: make => make(),
    useRef: current => ({ current }),
    useId: () => 'id',
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : {}), window: { innerWidth: 1280 } })
  return module.exports
}

// Render every function component down to host elements (strings) so the whole list can be searched.
function expand(node, seen = 0) {
  if (Array.isArray(node)) return node.map(child => expand(child, seen))
  if (!node || typeof node !== 'object' || !('props' in node)) return node
  if (seen > 200) throw new Error('expand too deep')
  // LeftColumn / TitleToggle portal into document.body (not the list); their children are the list.
  if (node.type?.name === 'TitleToggle') return null
  if (node.type?.name === 'LeftColumn') return expand(node.props.children, seen + 1)
  if (typeof node.type === 'function') return { name: node.type.name, props: node.props, out: expand(node.type(node.props), seen + 1) }
  return { type: node.type, props: node.props, kids: expand(node.props?.children, seen + 1) }
}
function find(tree, pred, out = []) {
  if (Array.isArray(tree)) { tree.forEach(child => find(child, pred, out)); return out }
  if (!tree || typeof tree !== 'object') return out
  if (pred(tree)) out.push(tree)
  find(tree.out, pred, out)
  find(tree.kids, pred, out)
  return out
}

const joinedBot = { id: 'joined:n1:rb1', name: 'Remote', createdAt: 5, origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true } }

function roster({ sections = [], groups = {}, extraBots = [] } = {}) {
  const main = { id: 'lead', name: 'Lead', createdAt: 1 }
  const bots = [main, { id: 'a', name: 'Alpha', createdAt: 2 }, { id: 'b', name: 'Beta', createdAt: 3, sectionId: 's1' }, { id: 'g1bot', name: 'GroupMember', createdAt: 4 }, joinedBot, ...extraBots]
  return {
    bots, rooms: [], agents: [], byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), roomsById: {}, ready: true, mainBotId: 'lead',
    sections, groups, exchangeTurns: {},
  }
}

function render(TeamSidebar, rosterValue, calls = []) {
  const names = ['openSession', 'openJoinedHome', 'openAgent', 'openAgentSession', 'newAgentSession', 'openPalette', 'openNewChat', 'toggleSidebar', 'toggleLeftHidden', 'clearUnread', 'renameGroup', 'deleteBotGroup', 'toggleBotGroup', 'createBotGroup', 'saveSection', 'reorderSections', 'deleteSection', 'moveToSection', 'setLeftDrawer', 'openMenu']
  const actions = Object.fromEntries(names.map(name => [name, (...args) => { calls.push([name, ...args]) }]))
  const props = {
    wide: true, actions,
    useRoster: pick => pick(rosterValue), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}), useSessions: pick => pick({ ids: [], byId: {} }),
    useUpdate: () => ({}), useSessionStatus: pick => pick(new Map()), useSessionRetainInfo: () => null, useActivity: pick => pick({}),
    useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }), useFrame: () => ({ viewport: 1280, sidebarWidth: 280, collapsedWidth: 0 }), useSidebarPref: () => 'open',
  }
  return expand(TeamSidebar(props))
}

const rowOf = (tree, id) => find(tree, node => node.type === 'button' && node.props?.['data-bot-id'] === id && node.props?.className === 'bt-row')[0]
const sectionNamed = (tree, name) => find(tree, node => node.name === 'SectionBlock' && node.props.section.name === name)[0]
const hasRow = (tree, id) => rowOf(tree, id) !== undefined

const SECTIONS = [{ id: 's1', name: 'Work', collapsed: false, order: 0 }]
const GROUPS = { fleet: { id: 'fleet', name: '执行机', botIds: ['g1bot'], order: 0, collapsed: false } }

test('M-side-groups: custom Bot groups keep their header, member rows and the "+ 新建分组" row next to upstream sections', async () => {
  const { TeamSidebar } = await loadSidebar()
  const calls = []
  const tree = render(TeamSidebar, roster({ sections: SECTIONS, groups: GROUPS }), calls)
  const headers = find(tree, node => node.name === 'GroupHeaderRow')
  assert.equal(headers.length, 1)
  assert.equal(headers[0].props.group.id, 'fleet')
  assert.equal(headers[0].props.wideContent, true, 'the header is told the sidebar is wide')
  assert.equal(find(tree, node => node.name === 'NewGroupRow').length, 1)
  assert.equal(hasRow(tree, 'g1bot'), true, 'a member of an open group is listed under the header')
  // the header's controls reach the group endpoints
  const toggle = find(headers[0], node => node.props?.role === 'button' && node.props?.['aria-expanded'] !== undefined)[0]
  toggle.props.onClick()
  assert.deepEqual([...calls.at(-1)], ['toggleBotGroup', 'fleet'])
})

test('M-side-collapsed: a collapsed group lists its header but not its members', async () => {
  const { TeamSidebar } = await loadSidebar()
  const tree = render(TeamSidebar, roster({ sections: SECTIONS, groups: { fleet: { ...GROUPS.fleet, collapsed: true } } }))
  assert.equal(find(tree, node => node.name === 'GroupHeaderRow').length, 1)
  assert.equal(hasRow(tree, 'g1bot'), false)
})

test('M-side-sections: a Bot with a sectionId is listed in its section, the others with the ungrouped', async () => {
  const { TeamSidebar } = await loadSidebar()
  const tree = render(TeamSidebar, roster({ sections: SECTIONS, groups: GROUPS }))
  const work = sectionNamed(tree, 'Work')
  assert.ok(work, 'the section renders as a SectionBlock')
  assert.deepEqual([...work.props.entries.map(entry => entry.item.id)], ['b'])
  assert.equal(find(work, node => node.type === 'button' && node.props?.['data-bot-id'] === 'b').length, 1)
  const ungrouped = find(tree, node => node.props?.className === 'bt-sec-ungrouped')[0]
  assert.ok(ungrouped, 'with sections present the ungrouped rows sit in the drop area')
  assert.equal(hasRow(ungrouped, 'a'), true)
  assert.equal(hasRow(ungrouped, 'b'), false, 'a Bot in a section is not listed twice')
  assert.equal(find(ungrouped, node => node.name === 'GroupHeaderRow').length, 1, 'the group header lists with the ungrouped (D1 = A)')
})

test('M-side-no-sections: without sections the list is the fork.76 list — groups, rows, new-group row, no section area', async () => {
  const { TeamSidebar } = await loadSidebar()
  const tree = render(TeamSidebar, roster({ groups: GROUPS }))
  assert.equal(find(tree, node => node.name === 'SectionBlock').length, 0)
  assert.equal(find(tree, node => node.props?.className === 'bt-sec-ungrouped').length, 0)
  assert.equal(find(tree, node => node.name === 'GroupHeaderRow').length, 1)
  assert.equal(find(tree, node => node.name === 'NewGroupRow').length, 1)
  for (const id of ['a', 'b', 'g1bot', joinedBot.id]) assert.equal(hasRow(tree, id), true, id)
})

test('M-side-joined-click: a joined Bot row opens through openJoinedHome, a local one through openSession', async () => {
  const { TeamSidebar } = await loadSidebar()
  const calls = []
  const tree = render(TeamSidebar, roster({ sections: SECTIONS, groups: GROUPS }), calls)
  rowOf(tree, joinedBot.id).props.onClick()
  assert.deepEqual(calls.at(-1), ['openJoinedHome', joinedBot.id])
  rowOf(tree, 'a').props.onClick()
  assert.deepEqual(calls.at(-1), ['openSession', 'a'])
})

test('M-side-drag: a Bot row is draggable in the wide list (upstream drag-to-section), the main tile is not', async () => {
  const { TeamSidebar } = await loadSidebar()
  const tree = render(TeamSidebar, roster({ sections: SECTIONS, groups: GROUPS }))
  const row = rowOf(tree, 'a')
  assert.equal(row.props.draggable, true)
  let seen = null
  // the drag handler is wired to the sidebar's own state; here only that it forwards the Bot id
  assert.equal(typeof row.props.onDragStart, 'function')
  try { row.props.onDragStart({ dataTransfer: { setData() {}, effectAllowed: '' }, preventDefault() {} }) } catch (error) { seen = error }
  assert.equal(seen, null, 'starting a drag does not throw')
  const tile = find(tree, node => node.props?.className === 'bt-tile-wrap')
  assert.ok(tile.length >= 1, 'the main Bot is the tile')
  assert.equal(hasRow(tree, 'lead'), false)
})

test('M-side-group-and-section: a Bot that is in a group AND a section is listed once, in the section', async () => {
  const { TeamSidebar } = await loadSidebar()
  const r = roster({ sections: SECTIONS, groups: { fleet: { ...GROUPS.fleet, botIds: ['b'] } } })
  const tree = render(TeamSidebar, r)
  const rows = find(tree, node => node.type === 'button' && node.props?.['data-bot-id'] === 'b' && node.props?.className === 'bt-row')
  assert.equal(rows.length, 1)
  assert.equal(find(sectionNamed(tree, 'Work'), node => node.props?.['data-bot-id'] === 'b').length, 1)
})
