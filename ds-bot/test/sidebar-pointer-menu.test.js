import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const SIDEBAR = join(PLUGIN, 'src/client/sidebar.js')
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The wide Bot-row button, not the main-bot tile. The tile keeps its ref inline.
// Deleting this line must turn the clientX assertion red.
function botRowRefPattern() {
  return /('data-bot-id': id, title: wide \? undefined : bot\.name,)\r?\n    ref: bindPointerMenu\(actions\.openMenu, \(\) => \(\{ kind: 'bot', id \}\)\),/
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function stripBotRowRef(source) {
  const pattern = botRowRefPattern()
  if (!pattern.test(source)) return source
  return source.replace(botRowRefPattern(), '$1')
}

// esbuild reads the disk source. A string snapshot of the handler is not the assertion.
async function loadSidebar() {
  const { outputFiles } = await build({
    stdin: {
      contents: "export { TeamSidebar } from './src/client/sidebar.js'",
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
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length <= 1 ? children[0] : children } }),
    Fragment: Symbol('Fragment'),
    useEffect() {},
    useLayoutEffect() {},
    useState: initial => [initial, () => {}],
    useMemo: make => make(),
    useRef: current => ({ current }),
    useId: () => 'id',
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    require: name => (name === 'react' ? react : {}),
    window: { innerWidth: 1280 },
  })
  return module.exports
}

function teamRoster() {
  const main = { id: 'lead', name: 'Lead', createdAt: 1 }
  const worker = { id: 'worker', name: 'Worker', createdAt: 2 }
  return {
    bots: [main, worker],
    rooms: [],
    agents: [],
    byId: { lead: main, worker },
    roomsById: {},
    ready: true,
    mainBotId: 'lead',
    groups: { fleet: { id: 'fleet', name: '执行机', botIds: ['worker'], order: 0, collapsed: false } },
    exchangeTurns: {},
  }
}

function propsFor(opened) {
  const names = ['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openPalette', 'openNewChat', 'toggleSidebar', 'toggleLeftHidden', 'clearUnread', 'renameGroup', 'deleteBotGroup', 'toggleBotGroup', 'createBotGroup', 'setLeftDrawer', 'landOn']
  const actions = Object.fromEntries(names.map(name => [name, () => {}]))
  actions.openMenu = (menu) => { opened.push(menu) }
  return {
    wide: true,
    actions,
    useRoster: pick => pick(teamRoster()),
    useUi: pick => pick({ unread: {} }),
    useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }),
    useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map()),
    useSessionRetainInfo: () => null,
    useActivity: pick => pick({}),
    useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
    useFrame: () => ({ viewport: 1280, sidebarWidth: 280, collapsedWidth: 0 }),
    useSidebarPref: () => 'open',
  }
}

function walk(node, visit) {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}

function renderedRows(TeamSidebar, opened) {
  const found = []
  walk(TeamSidebar(propsFor(opened)), (node) => {
    if (node.type?.name === 'BotRow' || node.type?.name === 'GroupHeaderRow') found.push(node.type(node.props))
  })
  return found
}

function elementsOf(node) {
  const out = []
  walk(node, (item) => { if (typeof item.type === 'string') out.push(item) })
  return out
}

function pointer(window, type, { button = 0, clientX = 0, clientY = 0 } = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'button', { value: button })
  Object.defineProperty(event, 'clientX', { value: clientX })
  Object.defineProperty(event, 'clientY', { value: clientY })
  return event
}

function bind(ref) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const el = dom.window.document.createElement('button')
  dom.window.document.body.appendChild(el)
  if (typeof ref === 'function') ref(el)
  return { dom, el }
}

// Same assertion the mutation runs. A missing ref dispatches nothing, so x is not 12.
function openBotRowAtPointer(TeamSidebar) {
  const opened = []
  const button = renderedRows(TeamSidebar, opened).flatMap(elementsOf)
    .find(el => el.props?.['data-bot-id'] === 'worker' && el.props?.className === 'bt-row')
  assert.ok(button, 'wide sidebar must render the worker bot row')
  const bound = bind(button.props.ref)
  const event = pointer(bound.dom.window, 'pointerdown', { button: 2, clientX: 12, clientY: 34 })
  bound.el.dispatchEvent(event)
  assert.equal(opened[0]?.x, 12, 'right-click must open the bot menu at clientX 12')
  assert.equal(opened[0]?.kind, 'bot')
  assert.equal(opened[0]?.id, 'worker')
  assert.equal(opened[0]?.y, 34)
  return { opened, event, button, ...bound }
}

test('disk source: a wide bot-row right-click opens kind bot at the click', async () => {
  const { TeamSidebar } = await loadSidebar()
  const { opened, event, el, dom } = openBotRowAtPointer(TeamSidebar)
  assert.equal(event.defaultPrevented, true)
  let bubbled = 0
  el.parentElement.addEventListener('pointerdown', () => { bubbled += 1 })
  const again = pointer(dom.window, 'pointerdown', { button: 2, clientX: 12, clientY: 34 })
  el.dispatchEvent(again)
  assert.equal(bubbled, 0)
  assert.equal(again.defaultPrevented, true)
  const before = opened.length
  const left = pointer(dom.window, 'pointerdown', { button: 0, clientX: 12, clientY: 34 })
  el.dispatchEvent(left)
  assert.equal(opened.length, before)
  assert.equal(left.defaultPrevented, false)
  const ctx = pointer(dom.window, 'contextmenu', { button: 2, clientX: 18, clientY: 22 })
  el.dispatchEvent(ctx)
  assert.equal(ctx.defaultPrevented, true)
  assert.equal(opened.at(-1).kind, 'bot')
  assert.equal(opened.at(-1).id, 'worker')
  assert.equal(opened.at(-1).x, 18)
  assert.equal(opened.at(-1).y, 22)
})

test('disk source: the main-bot tile and the group header use the same pointer path', async () => {
  const { TeamSidebar } = await loadSidebar()
  const opened = []
  const rows = renderedRows(TeamSidebar, opened)
  const flat = rows.flatMap(elementsOf)
  const tile = flat.find(el => el.props?.className === 'bt-tile-wrap')
  assert.equal(typeof tile?.props.ref, 'function')
  const tileBound = bind(tile.props.ref)
  const tileEvent = pointer(tileBound.dom.window, 'pointerdown', { button: 2, clientX: 12, clientY: 8 })
  tileBound.el.dispatchEvent(tileEvent)
  assert.equal(opened[0]?.kind, 'bot')
  assert.equal(opened[0]?.id, 'lead')
  assert.equal(opened[0]?.x, 12)
  assert.equal(tileEvent.defaultPrevented, true)
  const header = flat.find(el => el.props?.className === 'bt-group-header')
  assert.equal(typeof header?.props.ref, 'function')
  const headerBound = bind(header.props.ref)
  const headerEvent = pointer(headerBound.dom.window, 'pointerdown', { button: 2, clientX: 12, clientY: 40 })
  headerBound.el.dispatchEvent(headerEvent)
  const group = opened.at(-1)
  assert.equal(group.kind, 'group')
  assert.equal(group.id, 'fleet')
  assert.equal(group.name, '执行机')
  assert.equal(group.x, 12)
  assert.equal(group.y, 40)
  assert.equal(typeof group.onRename, 'function')
  assert.equal(headerEvent.defaultPrevented, true)
})

test('disk source: the kebab still opens the same menu from the button rect', async () => {
  const { TeamSidebar } = await loadSidebar()
  const opened = []
  const flat = renderedRows(TeamSidebar, opened).flatMap(elementsOf)
  const isKebab = (el) => el.props?.children === '⋮' || (Array.isArray(el.props?.children) && el.props.children.includes('⋮'))
  const kebabs = flat.filter(isKebab)
  assert.equal(kebabs.length >= 2, true)
  for (const kebab of kebabs) {
    const event = {
      prevented: false,
      stopped: false,
      preventDefault() { event.prevented = true },
      stopPropagation() { event.stopped = true },
      currentTarget: { getBoundingClientRect: () => ({ left: 7, bottom: 19 }) },
    }
    kebab.props.onClick(event)
    assert.equal(event.prevented, true)
    assert.equal(event.stopped, true)
    assert.equal(opened.at(-1).x, 7)
    assert.equal(opened.at(-1).y, 19)
    assert.equal(['bot', 'group'].includes(opened.at(-1).kind), true)
  }
  assert.equal(opened.some(menu => menu.kind === 'bot' && menu.id === 'worker'), true)
  assert.equal(opened.some(menu => menu.kind === 'group' && menu.id === 'fleet'), true)
})

test('deleting the bot-row pointer handler turns the same clientX assertion red', async () => {
  const original = readFileSync(SIDEBAR)
  const hash = sha256(original)
  const restore = () => {
    if (sha256(readFileSync(SIDEBAR)) !== hash) writeFileSync(SIDEBAR, original)
  }
  process.on('exit', restore)
  try {
    writeFileSync(SIDEBAR, stripBotRowRef(original.toString('utf8')))
    const { TeamSidebar } = await loadSidebar()
    let failed = null
    try {
      openBotRowAtPointer(TeamSidebar)
    } catch (error) {
      failed = error
    }
    assert.ok(failed, 'the same assertion must fail once the bot-row handler line is gone')
    assert.equal(failed.expected, 12, failed.message)
    assert.equal(failed.actual, undefined)
    assert.match(failed.message, /clientX 12/)
  } finally {
    restore()
    process.removeListener('exit', restore)
    assert.equal(sha256(readFileSync(SIDEBAR)), hash)
  }
})
