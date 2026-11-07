import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

function remoteAgentRepo() {
  const env = process.env.REMOTE_AGENT_REPO
  if (typeof env === 'string' && env.trim() !== '') {
    const dir = resolve(env.trim())
    const file = join(dir, 'lib/roster-report.js')
    if (!existsSync(file)) {
      return { error: `REMOTE_AGENT_REPO=${dir} 没有 lib/roster-report.js，名单侧栏测试跳过` }
    }
    return { dir }
  }
  const candidates = [
    resolve(PLUGIN, '../../dsh-remote-agent-roster-join'),
    resolve(PLUGIN, '../dsh-remote-agent'),
    resolve(PLUGIN, '../../dsh-remote-agent'),
  ]
  const dir = candidates.find((item) => existsSync(join(item, 'lib/roster-report.js')))
  if (!dir) {
    return { error: `未设置 REMOTE_AGENT_REPO，相对路径也没有 lib/roster-report.js：${candidates.join(', ')}` }
  }
  return { dir }
}

const remote = remoteAgentRepo()
if (remote.error) console.error(remote.error)

async function loadRemote() {
  const base = pathToFileURL(join(remote.dir, 'lib/')).href
  const [report, ingest, node] = await Promise.all([
    import(new URL('roster-report.js', base).href),
    import(new URL('hub/registry-ingest.js', base).href),
    import(new URL('node/index.js', base).href),
  ])
  return { bindRosterReport: report.bindRosterReport, withIngest: ingest.withIngest, buildNodeHello: node.buildNodeHello }
}

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
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length <= 1 ? children[0] : children } }),
    Fragment: Symbol('Fragment'),
    useEffect() {},
    useLayoutEffect() {},
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: make => make(),
    useRef: current => ({ current }),
    useId: () => 'id',
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    require: name => (name === 'react' || name === 'react-dom' ? react : {}),
    window: { innerWidth: 1280 },
  })
  return module.exports
}

function makeRegistry(withIngest, nodeId) {
  const listeners = {}
  class Core {
    constructor() {
      this.nodes = new Map([[nodeId, { nodeId, lastSeen: 0, online: true }]])
      this.tasks = new Map()
    }
    log() {}
    send() {}
    on(name, fn) {
      (listeners[name] ??= []).push(fn)
      return () => {}
    }
    emit(name, payload) {
      for (const fn of listeners[name] ?? []) fn(payload)
    }
  }
  return new (withIngest(Core))()
}

function feed(bindRosterReport, report, registry, nodeId) {
  const sent = []
  const bound = bindRosterReport({ set() {} }, {
    send: (type, data) => { sent.push({ type, data }); return true },
    nodeId,
    hostname: 'desk-1',
  })
  const ok = bound(report)
  if (ok && sent[0]) registry.handleFrameFor(nodeId, { t: sent.at(-1).type, d: sent.at(-1).data })
  return sent
}

function controller(install, withIngest, nodeId) {
  const registry = makeRegistry(withIngest, nodeId)
  const state = {
    bots: {
      local: { id: 'local', name: 'Local', createdAt: 1 },
      worker: { id: 'worker', name: 'Old worker', type: 'remote-worker', createdAt: 2, worker: { nodeId, home: 'local' } },
    },
  }
  const rt = {
    state,
    save() {},
    ctx: { get(name) { return name === 'remote-agent:registry' ? registry : undefined } },
  }
  install(rt)
  return { registry, state, rt }
}

function rosterOf(state) {
  const bots = Object.values(state.bots).map(bot => ({ ...bot, sessionId: bot.sessionId ?? bot.id }))
  const byId = Object.fromEntries(bots.map(bot => [bot.id, bot]))
  return {
    bots,
    rooms: [],
    agents: [],
    byId,
    roomsById: {},
    ready: true,
    mainBotId: 'local',
    groups: {},
    exchangeTurns: {},
  }
}

function propsFor(roster, opened) {
  const names = ['openAgent', 'openAgentSession', 'newAgentSession', 'openPalette', 'openNewChat', 'toggleSidebar', 'toggleLeftHidden', 'clearUnread', 'renameGroup', 'deleteBotGroup', 'toggleBotGroup', 'createBotGroup', 'setLeftDrawer', 'landOn']
  const actions = Object.fromEntries(names.map(name => [name, () => {}]))
  actions.openSession = (id) => { opened.push(id) }
  actions.openMenu = () => {}
  return {
    wide: true,
    actions,
    useRoster: pick => pick(roster),
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

function rowsOf(TeamSidebar, roster, opened) {
  const found = []
  walk(TeamSidebar(propsFor(roster, opened)), (node) => {
    if (node.type?.name === 'BotRow') found.push(node.type(node.props))
  })
  return found
}

function buttonOf(row, id) {
  const out = []
  walk(row, (item) => { if (item.props?.['data-bot-id'] === id && item.props?.className === 'bt-row') out.push(item) })
  return out[0]
}

function previewOf(button) {
  let text = ''
  walk(button, (item) => {
    if (item.props?.className === 'bt-row-preview') text = String(item.props.children ?? '')
  })
  return text
}

const TWO = {
  bots: [
    { id: 'alpha', name: 'Alpha', role: '写' },
    { id: 'beta', name: 'Beta', role: '测' },
    { id: 'shadow', name: 'Nope', type: 'remote-worker' },
  ],
}

test('disk source: a roster report becomes two sidebar rows and cannot dispatch', { skip: remote.error || false }, async () => {
  const { bindRosterReport, withIngest, buildNodeHello } = await loadRemote()
  const { install, shadowId } = await import('../src/host/roster-join.js')
  const hello = buildNodeHello({ nodeId: 'node-a' }, { roots: ['/tmp'], nodeId: 'node-a' })
  assert.equal(hello.bots, undefined)

  const nodeId = 'node-a'
  const { registry, state } = controller(install, withIngest, nodeId)
  feed(bindRosterReport, TWO, registry, nodeId)

  const { TeamSidebar } = await loadSidebar()
  const opened = []
  const alphaId = shadowId(nodeId, 'alpha')
  const betaId = shadowId(nodeId, 'beta')
  const drawn = rowsOf(TeamSidebar, rosterOf(state), opened)
  const alpha = buttonOf(drawn.find(row => buttonOf(row, alphaId)), alphaId)
    ?? drawn.map(row => buttonOf(row, alphaId)).find(Boolean)
  const beta = drawn.map(row => buttonOf(row, betaId)).find(Boolean)
  assert.ok(alpha, '侧栏没有这行')
  assert.ok(beta, '侧栏没有这行')
  assert.equal(previewOf(alpha), 'desk-1')
  assert.equal(previewOf(beta), 'desk-1')
  assert.equal(drawn.map(row => buttonOf(row, shadowId(nodeId, 'shadow'))).find(Boolean), undefined)
  assert.equal(state.bots.worker.name, 'Old worker')
  assert.equal(Object.values(state.bots).filter(bot => bot.origin === 'joined').length, 2)

  feed(bindRosterReport, TWO, registry, nodeId)
  assert.equal(Object.values(state.bots).filter(bot => bot.origin === 'joined').length, 2)

  registry.emit('nodeOffline', { nodeId })
  const offline = rowsOf(TeamSidebar, rosterOf(state), opened).map(row => buttonOf(row, alphaId)).find(Boolean)
  assert.ok(offline, '侧栏没有这行')
  assert.match(previewOf(offline), /desk-1/)
  assert.match(previewOf(offline), /离线/)
  offline.props.onClick()
  assert.deepEqual(opened, [])

  const empty = controller(install, withIngest, 'node-b')
  feed(bindRosterReport, { bots: [] }, empty.registry, 'node-b')
  assert.equal(Object.values(empty.state.bots).some(bot => bot.origin === 'joined'), false)
  const emptyRows = rowsOf(TeamSidebar, rosterOf(empty.state), [])
  assert.equal(emptyRows.map(row => buttonOf(row, shadowId('node-b', 'alpha'))).find(Boolean), undefined)
})

test('a joined shadow does not call handleRemoteTurn', async () => {
  const { install: installDelivery } = await import('../src/host/delivery.js')
  const calls = []
  const shadow = {
    id: 'joined:node-a:alpha',
    type: 'remote-worker',
    origin: 'joined',
    worker: { home: 'remote', nodeId: 'node-a', remoteBotId: 'alpha', hostname: 'desk-1' },
  }
  const rt = {
    ctx: {},
    state: { bots: { [shadow.id]: shadow } },
    botOf: () => shadow,
    handleRemoteTurn() { calls.push('turn') },
    chatOf() { calls.push('chat') },
    hideBotUnusedTools() {},
  }
  installDelivery(rt)
  const result = await rt.deliver({ fromId: 'local', toId: shadow.id, text: 'go', role: 'request' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'joined shadow cannot dispatch')
  assert.deepEqual(calls, [])
})
