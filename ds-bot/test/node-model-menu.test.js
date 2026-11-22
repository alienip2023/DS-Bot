import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { install as installModels } from '../src/host/models.js'
import { install as installRoster } from '../src/host/roster.js'
import { joinedUpdateBot, createBotUpdateReceiver } from '../src/host/joined-page.js'
import { buildConfigPayload } from '../src/host/config-source.js'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { installLocale as installLocaleHere } from '../src/client/i18n.js'
import { realTeamActions, hostRoster, joinedRuntime } from './bot-home-fixtures.js'

// A remote Bot offers node models and configured main API models for the node to validate. The REAL
// DetailsDrawer is rendered with a small stateful React stand-in; the REAL BotModelMenu fetches
// the node's catalog through the real teamActions (botCreateTargets -> call), the REAL ModelMenu
// opens through its trigger, and its rows are clicked.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { DetailsDrawer } from './src/client/details-drawer.js'",
      "export { BotSettingsForm } from './src/client/bot-settings.js'",
      "export { ModelMenu } from './src/client/model-menu.js'",
      "export { ModelChoiceDock } from './src/client/model-menu.js'",
      "export { installLocale } from './src/client/i18n.js'",
      "export { FolderMenu } from './src/client/folder-menu.js'",
      "export { MemoryDialog } from './src/client/memory-panel.js'",
      "export { joinedUpdateErrorText } from './src/client/joined-errors.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

let hooks
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect(fn) { hooks.effects.push(fn) }, useLayoutEffect(fn) { (hooks.layouts ??= []).push(fn) },
  useState(initial) {
    const own = hooks // setters keep writing to the render they came from
    const i = own.i++
    if (!(i in own.slots)) own.slots[i] = i in own.seed ? own.seed[i] : (typeof initial === 'function' ? initial() : initial)
    return [own.slots[i], (value) => { own.sets.push(value); own.slots[i] = typeof value === 'function' ? value(own.slots[i]) : value }]
  },
  useMemo: make => make(),
  useRef(initial) { const i = hooks.i++; hooks.slots[i] ??= { current: initial }; return hooks.slots[i] },
  useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
  document: { body: {} },
  navigator: {},
  Element: class {},
})
const { DetailsDrawer, BotSettingsForm, ModelMenu, ModelChoiceDock, installLocale, FolderMenu, MemoryDialog, joinedUpdateErrorText } = module.exports

const settle = () => new Promise(resolve => setTimeout(resolve, 5))
// Render a component as a function; run its effects once, let the promises settle, render again.
async function render(Component, props, { seed = {}, effects = true } = {}) {
  const own = { i: 0, slots: {}, effects: [], layouts: [], seed, sets: [] }
  const draw = () => {
    hooks = own
    hooks.i = 0
    hooks.effects = []
    hooks.layouts = []
    const tree = Component(props)
    return Component === ModelMenu && typeof tree?.type === 'function' ? tree.type(tree.props) : tree
  }
  draw()
  if (effects) {
    for (const effect of hooks.effects) effect()
    await settle()
  }
  return { tree: draw(), sets: own.sets, rerender: draw }
}
const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}
// Components without hooks that make up the menu body are rendered in place (ModelChoices, ModelRows).
const INLINE = new Set(['ModelChoices', 'ModelRows', 'ModelGroupList'])
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object' || node.props === undefined) return node
  // Upstream v0.3.2 folds a provider's models under its heading (only the current model's provider starts open).
  // These tests are about WHICH models the list holds, so every group is expanded here.
  if (typeof node.type === 'function' && node.type.name === 'ModelGroupList') return expand(node.type({ ...node.props, manual: new Proxy({}, { get: () => true }) }))
  if (typeof node.type === 'function' && node.type.name === 'Collapse') {
    const parent = hooks
    hooks = { i: 0, slots: {}, effects: [], seed: {}, sets: [] }
    const tree = node.type(node.props)
    hooks = parent
    return expand(tree)
  }
  if (typeof node.type === 'function' && INLINE.has(node.type.name)) return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const find = (tree, match) => { const hits = []; walk(tree, node => { if (match(node)) hits.push(node) }); return hits }
const textOf = node => { const parts = []; walk(node, n => { for (const c of [n.props?.children].flat()) if (typeof c === 'string') parts.push(c) }); return parts.join('|') }

const MAIN_MODELS = [
  { ref: 'ccmax/claude-sonnet-5-5', provider: 'ccmax', providerName: 'ccmax', name: 'Claude Sonnet 5.5' },
  { ref: 'piion/m1', provider: 'piion', providerName: 'piion', name: 'Piion M1' },
  { ref: 'xai/grok-4.3', provider: 'xai', providerName: 'xai', name: 'Grok 4.3' },
  { ref: 'claude-code/sonnet', provider: 'claude-code', providerName: 'Claude Code', name: 'Claude Code Sonnet' },
]
const NODE_MODELS = [
  { ref: 'ccmax/claude-sonnet-5-5', provider: 'ccmax', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { ref: 'piion/m1', provider: 'piion', id: 'm1', name: 'Piion M1' },
]

// A page whose roster comes from a real runtime (joined Bot `bot-j1` on node n1 + a local Bot).
function page({ nodeModels = NODE_MODELS, targetsFail = false, targets = null, update, bot: botPatch = {} } = {}) {
  const rt = joinedRuntime({ mirrorSessionId: 'sess-mirror' })
  Object.assign(rt.state.bots['bot-j1'], botPatch)
  rt.state.bots['bot-local'] = { id: 'bot-local', name: 'Local', type: 'bot', model: 'piion/m1' }
  const calls = []
  const effortCalls = []
  const roster = { ...hostRoster(rt), models: MAIN_MODELS, ready: true }
  const actions = {
    ...realTeamActions(roster, {
      roster: { getSnapshot: () => roster },
      call: async (endpoint, body) => {
        calls.push([endpoint, body])
        if (endpoint === 'update-bot' && update) {
          const result = await update(rt, body)
          if (!result.ok) throw Object.assign(new Error(result.error), { code: 'bot/refused' })
          return result
        }
        if (endpoint === 'bot-create-targets') { if (targetsFail) throw new Error('boom'); return targets ?? [{ nodeId: 'n1', hostname: 'node-1', online: true, models: nodeModels, defaultModel: null }] }
        return {}
      },
    }),
    closeOverlay() {}, refreshModels: async () => {},
    efforts: async (ref) => { effortCalls.push(ref); return {} },
  }
  return { calls, roster, actions, effortCalls, bot: id => roster.byId[id] }
}

const drawerProps = (p, sessionId) => ({
  sessionId, roster: p.roster, actions: p.actions, hasStrip: false,
  useSessions: pick => pick({ byId: {}, projectionsBySession: {} }), useSessionStatus: pick => pick(new Map()),
  useActivity: pick => pick({}), useWork: pick => pick({ rooms: {}, waiting: {} }),
  useBrowserTabs: () => [], useBrowserPages: () => ({}), useComputer: () => ({}),
})

// The open menu of the Bot's model picker, as rendered by the drawer: BotModelMenu (fetches the
// node catalog) -> NodeModelMenu -> ModelMenu -> its inline or popup component.
async function openDrawerMenu(p, sessionId, { menuEffects = false } = {}) {
  const { tree, sets } = await render(DetailsDrawer, drawerProps(p, sessionId), { effects: false })
  const [bm] = find(tree, n => n.type?.name === 'BotModelMenu')
  assert.ok(bm, 'the drawer must render BotModelMenu for the Bot model')
  const { tree: bmOut } = await render(bm.type, bm.props)
  const [nmEl] = find(bmOut, n => n.type?.name === 'NodeModelMenu')
  assert.ok(nmEl, 'BotModelMenu must render NodeModelMenu')
  const { tree: nm } = await render(nmEl.type, nmEl.props, { effects: false })
  const [menuEl] = find(nm, n => n.type === ModelMenu)
  assert.ok(menuEl, 'BotModelMenu must render ModelMenu')
  const menu = await render(ModelMenu, menuEl.props, { effects: menuEffects })
  const [trigger] = find(menu.tree, n => n.props?.className === 'bt-model-trigger')
  trigger.props.ref.current = { focus() {}, getBoundingClientRect: () => ({ top: 20, bottom: 40, right: 300, width: 240 }) }
  trigger.props.onClick()
  menu.rerender()
  for (const layout of hooks.layouts) layout()
  const open = expand(menu.rerender())
  if (menuEl.props.inline) assert.equal(find(open, n => n.props?.className === 'bt-collapse')[0].props['data-open'], true)
  const items = find(open, n => n.type === 'button' && /^menuitem/.test(n.props.role ?? ''))
  return {
    props: menuEl.props, drawerSets: sets, tree: open,
    pickable: items.filter(n => n.props.role === 'menuitemradio'),
    off: items.filter(n => n.props.className === 'bt-model-off'),
    text: textOf(open),
    all: items,
    triggerName: textOf(find(open, n => n.props?.className === 'bt-model-name')[0]),
    triggerProvider: textOf(find(open, n => n.props?.className === 'bt-model-provider')[0]),
  }
}

test('M5-a: a joined remote Bot can pick configured API models missing from its report; absent CLIs stay disabled', async () => {
  const p = page()
  const m = await openDrawerMenu(p, 'bot-j1')
  assert.deepEqual(m.pickable.map(n => n.props['aria-description']), ['ccmax/claude-sonnet-5-5', 'piion/m1', 'xai/grok-4.3'])
  assert.deepEqual(m.off.map(n => textOf(n)), [
    'Claude Code Sonnet|The node has no matching CLI yet, or its setup is not synced',
  ])
  assert.match(m.text, /Not synced to the node yet/)
  assert.equal(m.props.notice, null)
})

// R10 (acceptance): with several nodes the picker must show the catalog of THE BOT'S node, not the first target's.
const OTHER_NODE_MODELS = [{ ref: 'xai/grok-4.3', provider: 'xai', id: 'grok-4.3', name: 'Grok 4.3' }]
const twoNodes = order => {
  const mine = { nodeId: 'n1', hostname: 'node-1', online: true, models: NODE_MODELS, defaultModel: null }
  const other = { nodeId: 'n-other', hostname: 'node-other', online: true, models: OTHER_NODE_MODELS, defaultModel: null }
  return order === 'other-first' ? [other, mine] : [mine, other]
}

test('M5-R10: with two nodes the drawer lists the catalog of the Bot\'s own node, whichever order the targets come in', async () => {
  for (const order of ['other-first', 'mine-first']) {
    const m = await openDrawerMenu(page({ targets: twoNodes(order) }), 'bot-j1')
    assert.deepEqual(m.pickable.map(n => n.props['aria-description']), ['ccmax/claude-sonnet-5-5', 'piion/m1', 'xai/grok-4.3'], order)
    assert.equal(m.props.notice, null, order)
  }
})

test('M5-R10b: the Bot\'s node is not among the targets (other nodes only) → no catalog for it: main list with the notice, never another node\'s list', async () => {
  const other = { nodeId: 'n-other', hostname: 'node-other', online: true, models: OTHER_NODE_MODELS, defaultModel: null }
  const m = await openDrawerMenu(page({ targets: [other] }), 'bot-j1')
  assert.deepEqual(m.pickable.map(n => n.props['aria-description']), MAIN_MODELS.map(x => x.ref), 'the main list, all pickable')
  assert.ok(m.props.notice, 'the notice says the node reported nothing')
  assert.equal(m.off.length, 0, 'nothing is greyed out against another node\'s list')
})

// Same model, same name: the trigger of a Bot whose model the node cannot run, and that model's greyed row.
test('M5-names: a Bot on a model the node has not synced shows it in the trigger under the same name as its greyed row (not the raw ref tail)', async () => {
  const m = await openDrawerMenu(page({ bot: { model: 'claude-code/sonnet' } }), 'bot-j1')
  const row = m.off.find(n => n.props.title !== undefined && textOf(n).startsWith('Claude Code Sonnet'))
  assert.ok(row, 'the greyed row is named by the main')
  assert.equal(m.triggerName, 'Claude Code Sonnet', 'the trigger uses that same name')
  assert.match(m.triggerProvider, /Claude Code/, 'and the provider display name, not the raw id')
  assert.match(m.triggerProvider, /not available/)
})

test('M5-names-served: a model the node does serve keeps its node name in the trigger', async () => {
  const m = await openDrawerMenu(page({ bot: { model: 'ccmax/claude-sonnet-5-5' } }), 'bot-j1')
  assert.equal(m.triggerName, 'Claude Sonnet 5.5')
})

test('a remote model is not marked unavailable while its node catalog is loading or unknown', async () => {
  const p = page({ bot: { model: 'node/only' } })
  const { tree } = await render(DetailsDrawer, drawerProps(p, 'bot-j1'), { effects: false })
  const [bm] = find(tree, n => n.type?.name === 'BotModelMenu')
  const { tree: bmOut } = await render(bm.type, bm.props, { effects: false })
  const [nm] = find(bmOut, n => n.type?.name === 'NodeModelMenu')
  for (const nodeModels of [null, []]) {
    const { tree: menu } = await render(nm.type, { ...nm.props, nodeModels }, { effects: false })
    const { tree: trigger } = await render(menu.type, menu.props, { effects: false })
    assert.doesNotMatch(textOf(trigger), /not available/)
    assert.equal(find(trigger, n => n.props?.className === 'bt-model-trigger')[0].props['data-missing'], undefined)
  }
})

test('a node-only model has no unavailable hint in Bot settings', async () => {
  const p = page({ nodeModels: [{ ref: 'node/only', provider: 'node', id: 'only', name: 'Only' }], bot: { model: 'node/only' } })
  const { tree } = await render(BotSettingsForm, { bot: p.bot('bot-j1'), roster: p.roster, actions: p.actions, run: x => x }, { effects: false })
  assert.doesNotMatch(textOf(tree), /This model is not available now/)
  const menu = await openDrawerMenu(p, 'bot-j1')
  assert.equal(menu.triggerName, 'Only')
  assert.doesNotMatch(menu.triggerProvider, /not available/)
})

test('the local model repair dock does not offer hub models for a working node-only model', async () => {
  const p = page({ bot: { model: 'node/only', appliedModel: 'node/only' } })
  const { tree } = await render(ModelChoiceDock, { sessionId: 'sess-mirror', useRoster: pick => pick(p.roster), actions: p.actions }, { effects: false })
  assert.equal(tree, null)
})

test('switching node Bots does not render the previous node catalog while the next lookup is pending', async () => {
  const p = page({ bot: { model: 'piion/m1' } })
  const { tree } = await render(DetailsDrawer, drawerProps(p, 'bot-j1'), { effects: false })
  const [bm] = find(tree, n => n.type?.name === 'BotModelMenu')
  await render(bm.type, bm.props)
  hooks.i = 0
  hooks.effects = []
  const next = bm.type({ ...bm.props, bot: { ...bm.props.bot, id: 'joined:n2:other', model: 'other/only', worker: { ...bm.props.bot.worker, nodeId: 'n2' } } })
  const [menu] = find(next, n => n.type?.name === 'NodeModelMenu')
  assert.equal(menu.props.nodeModels, null)
})

test('a changed model on the same node Bot rechecks its catalog instead of keeping the earlier model list', async () => {
  const p = page({ bot: { model: 'piion/m1' } })
  const { tree } = await render(DetailsDrawer, drawerProps(p, 'bot-j1'), { effects: false })
  const [bm] = find(tree, n => n.type?.name === 'BotModelMenu')
  await render(bm.type, bm.props)
  hooks.i = 0
  hooks.effects = []
  const next = bm.type({ ...bm.props, bot: { ...bm.props.bot, model: 'node/new' } })
  const [menu] = find(next, n => n.type?.name === 'NodeModelMenu')
  assert.equal(menu.props.nodeModels, null)
})

test('M5-a2: picking a node model saves it (updateBot -> update-bot); a greyed-out row is disabled and saves nothing', async () => {
  const p = page({ bot: { model: 'piion/m1' } })
  const m = await openDrawerMenu(p, 'bot-j1')
  p.calls.length = 0
  m.pickable.find(n => n.props['aria-description'] === 'ccmax/claude-sonnet-5-5').props.onClick()
  await settle()
  assert.deepEqual(p.calls.filter(c => c[0] === 'update-bot'), [['update-bot', { id: 'bot-j1', model: 'ccmax/claude-sonnet-5-5' }]])
  p.calls.length = 0
  assert.equal(m.off.length, 1)
  for (const row of m.off) {
    assert.equal(row.props.disabled, true)
    assert.equal(row.props['aria-disabled'], true)
    row.props.onClick?.()
  }
  await settle()
  assert.deepEqual(p.calls.filter(c => c[0] === 'update-bot'), [], 'a greyed-out model must never reach update-bot')
})

test('M5-b: a local Bot drawer is unchanged: the whole main list, nothing greyed out, no notice, no node lookup', async () => {
  const p = page()
  const m = await openDrawerMenu(p, 'bot-local')
  assert.deepEqual(m.pickable.map(n => n.props['aria-description']), MAIN_MODELS.map(x => x.ref))
  assert.deepEqual(m.off, [])
  assert.equal(m.props.notice, null)
  assert.equal(p.calls.some(c => c[0] === 'bot-create-targets'), false)
})

test('M5-c: no node catalog (empty, or the lookup failed): the main list with a notice on top', async () => {
  for (const opts of [{ nodeModels: [] }, { targetsFail: true }]) {
    const p = page(opts)
    const m = await openDrawerMenu(p, 'bot-j1')
    assert.deepEqual(m.pickable.map(n => n.props['aria-description']), MAIN_MODELS.map(x => x.ref))
    assert.deepEqual(m.off, [])
    assert.equal(m.props.notice, 'The node has not reported its models; some may be unavailable.')
    assert.match(m.text, /The node has not reported its models; some may be unavailable\./)
  }
})

test('M5-d: the Bot settings form picks from the same node catalog (shared BotModelMenu)', async () => {
  const p = page()
  const { tree } = await render(BotSettingsForm, { bot: p.bot('bot-j1'), roster: p.roster, actions: p.actions, run: x => x }, { effects: false })
  assert.ok(find(tree, n => n.type?.name === 'BotModelMenu').length === 1, 'BotSettingsForm must render BotModelMenu')
})

test('M5-e: a node refusal reaches the drawer as a sentence in its error line (run -> setError), not the raw code', async () => {
  const p = page()
  const m = await openDrawerMenu(p, 'bot-j1')
  const refusals = {
    'bot-update-model-unknown': 'The node has no provider for this model. Pick a model the node already has.',
    'bot-update-workdir-denied': 'The node does not allow this working folder. Pick a folder the node allows.',
    'node-offline': 'The node is offline, so the change did not reach it. Try again when it is back.',
    'bridge-down': 'The node is offline, so the change did not reach it. Try again when it is back.',
    'bot-update-timeout': 'The node did not answer in time, so the change may not have applied. Try again in a moment.',
    'bot-update-not-found': 'The node cannot find this Bot.',
    'bot-update-failed: disk full': 'The node refused this change: disk full',
    'something-new': 'The node refused this change: something-new',
  }
  for (const [raw, sentence] of Object.entries(refusals)) {
    const refused = page()
    const shown = await refusedUpdate(refused, raw)('bot-j1', { model: 'x/y' }).then(() => null, error => error)
    assert.equal(shown.message, sentence, raw)
    assert.equal(shown.code, 'bot/refused')
    assert.equal(shown.message.includes('bot-update-'), false)
  }
  m.drawerSets.length = 0
  await m.props.run(Promise.reject(Object.assign(new Error('The node refused this change: x'), { code: 'bot/refused' })))
  assert.ok(m.drawerSets.includes('The node refused this change: x'), 'the drawer keeps the error line (setError) with that sentence')
})

// teamActions over a host that refuses update-bot with `raw`, the way channel.js does.
function refusedUpdate(p, raw) {
  const roster = p.roster
  const actions = realTeamActions(roster, {
    roster: { getSnapshot: () => roster },
    call: async () => { throw Object.assign(new Error(raw), { code: 'bot/refused' }) },
  })
  return actions.updateBot
}

test('M5-e2: only a refusal of a joined remote Bot is rewritten (local Bot and other codes keep their message)', async () => {
  const p = page()
  const local = await refusedUpdate(p, 'bot-update-model-unknown')('bot-local', { model: 'x/y' }).then(() => null, e => e)
  assert.equal(local.message, 'bot-update-model-unknown')
  const roster = p.roster
  const other = realTeamActions(roster, {
    roster: { getSnapshot: () => roster },
    call: async () => { throw Object.assign(new Error('bot-update-model-unknown'), { code: 'NETWORK' }) },
  })
  const e = await other.updateBot('bot-j1', { model: 'x/y' }).then(() => null, error => error)
  assert.equal(e.message, 'bot-update-model-unknown')
})

test('M5-f: in Chinese the group, the reasons, the notice and the refusals read as the user was told', async () => {
  const dicts = new Map()
  const zhLocale = {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = dicts.get(`${ns}:zh`)?.[key] ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active: 'zh' }),
  }
  // The bundle has its own i18n state (the drawer); teamActions here uses this module's.
  const offBundle = installLocale(zhLocale)
  const offHere = installLocaleHere(zhLocale)
  try {
    const m = await openDrawerMenu(page(), 'bot-j1')
    assert.match(m.text, /节点尚未同步/)
    assert.deepEqual(m.off.map(n => textOf(n)), [
      'Claude Code Sonnet|节点还没装对应 CLI 或配置未同步',
    ])
    const empty = await openDrawerMenu(page({ nodeModels: [] }), 'bot-j1')
    assert.equal(empty.props.notice, '节点未上报模型清单，部分模型可能不可用')
    const e = await refusedUpdate(page(), 'bot-update-model-unknown')('bot-j1', { model: 'x/y' }).then(() => null, error => error)
    assert.equal(e.message, '节点没有这个模型的提供商，请换节点已有的模型')
    const f = await refusedUpdate(page(), 'bot-update-failed: disk full')('bot-j1', { model: 'x/y' }).then(() => null, error => error)
    assert.equal(f.message, '节点拒绝了这次修改：disk full')
  } finally { offBundle(); offHere() }
})


// ── s60-C: a node model's thinking levels come from the node's own catalog ──────
// The node reports levels as `models[].efforts`; the picker reads `reasoning.efforts`.
// Before s60 the picker saw no levels (no bar) AND asked the host over RPC for nothing.
const WITH_EFFORTS = NODE_MODELS.map(model => model.ref === 'piion/m1'
  ? { ...model, efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }
  : model)

test('s60-C: a node model that reports thinking levels shows the level bar, and is not re-asked over RPC', async () => {
  const p = page({ nodeModels: WITH_EFFORTS, bot: { model: 'piion/m1' } })
  const m = await openDrawerMenu(p, 'bot-j1', { menuEffects: true })
  const [barEl] = find(m.tree, n => n.type?.name === 'EffortBar')
  assert.ok(barEl, 'the levels the node reported must reach the picker (a Thinking section is built)')
  // Render the bar itself and read its stops: the node's own names, in order, after a Default stop.
  hooks = { i: 0, slots: {}, effects: [], seed: {}, sets: [] }
  const bar = barEl.type(barEl.props)
  assert.equal(find(bar, n => n.props?.className === 'bt-effort-bar').length, 1)
  // The bar is a slider since 0.3.10: its dots carry no names; the stops are counted and the shown one is named.
  const [slider] = find(bar, n => n.props?.role === 'slider')
  assert.equal(find(bar, n => n.props?.className === 'bt-effort-dot').length, 3, 'Default, Low, High')
  assert.deepEqual([slider.props['aria-valuemin'], slider.props['aria-valuemax'], slider.props['aria-valuetext']], [0, 2, 'Default'])
  assert.deepEqual(p.effortCalls, [], 'the node already said its levels: no efforts RPC')
})

test('s60-C: a node model without levels shows no level bar', async () => {
  const p = page({ bot: { model: 'piion/m1' } })
  const m = await openDrawerMenu(p, 'bot-j1', { menuEffects: true })
  assert.equal(find(m.tree, n => n.type?.name === 'EffortBar').length, 0)
})

// The reported policy is a snapshot; the live catalog changes after config-sync.
// Keep the menu, action, bridge, node receiver, roster and model selection real.
function modelNode() {
  const policy = { models: NODE_MODELS }
  const providers = Object.fromEntries(NODE_MODELS.map(m => [m.provider, [{ id: m.id, name: m.name }]]))
  const selections = []
  const bot = { id: 'rb1', name: 'Remote', managedBy: 'hub', model: 'piion/m1', appliedModel: 'piion/m1' }
  const rt = {
    state: { bots: { rb1: bot }, rooms: {}, threads: {}, prefs: {} }, defaults: {},
    ctx: {
      get: name => name === 'remote-agent:node-policy' ? policy : undefined,
      llm: { listProviders: () => Object.keys(providers).map(id => ({ id })), listModels: async id => providers[id] ?? [] },
      sessionController: { selectModel: async choice => { selections.push(choice); return { selected: choice } } },
    },
    botOf: id => id === bot.id ? bot : undefined,
    chatOf: () => 'node-session', groupSessionsOf: () => [],
    checkPrivacyChange: async () => {}, save: async () => {},
  }
  installModels(rt)
  installRoster(rt)
  return { rt, bot, policy, providers, selections, accept: createBotUpdateReceiver(rt) }
}

const updateSpec = model => ({ remoteBotId: 'rb1', model, effort: null, instructions: null, workDir: null })

test('a node accepts its live exact model after config-sync while its policy and cached catalog lag', async () => {
  const node = modelNode()
  await node.rt.catalog()
  // Only the transport's application to the fake LLM service is simulated.
  const payload = buildConfigPayload({ ctx: {
    get: () => ({ describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
      xai: { api: 'openai-responses', apiKeyEnv: 'TEST_ONLY', models: [{ id: 'grok-4.3' }] },
    } } }] }),
    llm: { listConfigurableProviders: () => [{ provider: 'xai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'xai'] }] },
  } }, { readRefs: () => new Map([['TEST_ONLY', 'fixture-only']]) })
  for (const provider of payload.providers) node.providers[provider.id] = provider.models
  const result = await node.accept(updateSpec('xai/grok-4.3'))
  assert.equal(result.ok, true, result.error)
  assert.equal(node.bot.model, 'xai/grok-4.3')
  assert.equal(node.bot.appliedModel, 'xai/grok-4.3')
  assert.deepEqual(node.selections, [{ sessionId: 'node-session', provider: 'xai', model: 'grok-4.3' }])
})

test('picking a main API model reaches the node session before updating the hub shadow', async () => {
  const node = modelNode()
  node.providers.xai = [{ id: 'grok-4.3', name: 'Grok 4.3' }]
  const registry = new EventEmitter()
  registry.onlineNodes = () => [{ nodeId: 'n1', models: NODE_MODELS }]
  registry.send = (nodeId, type, frame) => {
    assert.equal(nodeId, 'n1')
    assert.equal(type, 'bot/update')
    void node.accept(frame).then(result => registry.emit('botUpdateResult', { ...result, nodeId, requestId: frame.requestId }))
    return true
  }
  let pending
  let shadow
  const p = page({ bot: { model: 'piion/m1', appliedModel: 'piion/m1' }, update: (rt, body) => {
    shadow = rt.state.bots[body.id]
    rt.ctx.get = name => name === 'remote-agent:registry' ? registry : undefined
    rt.save = async () => {}
    pending = joinedUpdateBot(rt, body.id, body)
    assert.equal(shadow.model, 'piion/m1', 'the hub must wait for the node result')
    return pending
  } })
  const menu = await openDrawerMenu(p, 'bot-j1')
  const row = menu.pickable.find(n => n.props['aria-description'] === 'xai/grok-4.3')
  assert.ok(row, 'a main API model must be selectable despite the stale node report')
  row.props.onClick()
  const result = await pending
  assert.equal(result.ok, true, result.error)
  assert.equal(node.bot.model, 'xai/grok-4.3')
  assert.equal(node.bot.appliedModel, 'xai/grok-4.3')
  assert.deepEqual(node.selections, [{ sessionId: 'node-session', provider: 'xai', model: 'grok-4.3' }])
  assert.equal(shadow.model, node.bot.model)
  assert.equal(shadow.appliedModel, node.bot.appliedModel)
  assert.equal(shadow.worker.model, node.bot.model)
})

test('the live node rejects an absent exact ref even if its policy lists it and another provider has the same model id', async () => {
  const node = modelNode()
  node.providers.other = [{ id: 'grok-4.3' }]
  node.policy.models = [...NODE_MODELS, { ref: 'xai/grok-4.3' }]
  const result = await node.accept(updateSpec('xai/grok-4.3'))
  assert.equal(result.ok, false)
  assert.equal(node.bot.model, 'piion/m1')
  assert.deepEqual(node.selections, [])
})


test('a configured main API model is not labelled unavailable merely because the node report lags', async () => {
  const menu = await openDrawerMenu(page({ bot: { model: 'xai/grok-4.3' } }), 'bot-j1')
  assert.equal(menu.triggerName, 'Grok 4.3')
  assert.doesNotMatch(menu.triggerProvider, /not available/)
})

test('a refused node pick leaves both model records and the node session unchanged', async () => {
  const node = modelNode()
  const registry = new EventEmitter()
  registry.onlineNodes = () => [{ nodeId: 'n1', models: NODE_MODELS }]
  registry.send = (nodeId, type, frame) => {
    assert.equal(type, 'bot/update')
    void node.accept(frame).then(result => registry.emit('botUpdateResult', { ...result, nodeId, requestId: frame.requestId }))
    return true
  }
  let pending
  let shadow
  const p = page({ bot: { model: 'piion/m1', appliedModel: 'piion/m1' }, update: (rt, body) => {
    shadow = rt.state.bots[body.id]
    rt.ctx.get = name => name === 'remote-agent:registry' ? registry : undefined
    rt.save = async () => {}
    pending = joinedUpdateBot(rt, body.id, body)
    return pending
  } })
  const menu = await openDrawerMenu(p, 'bot-j1')
  const row = menu.pickable.find(n => n.props['aria-description'] === 'xai/grok-4.3')
  assert.ok(row)
  row.props.onClick()
  const result = await pending
  await settle()
  assert.equal(result.ok, false)
  assert.equal(node.bot.model, 'piion/m1')
  assert.equal(node.bot.appliedModel, 'piion/m1')
  assert.deepEqual(node.selections, [])
  assert.equal(shadow.model, 'piion/m1')
  assert.equal(shadow.appliedModel, 'piion/m1')
  assert.ok(menu.drawerSets.some(value => typeof value === 'string' && value.length > 0), 'the drawer shows the refusal')
})

// A node Bot is used like a hub Bot: what cannot act on the node says so, it does not pretend.
const NODE_REASON = 'This Bot runs on a node: change it there'

test('the drawer of a node Bot gives the reason where Permissions, Connectors, Browser and Computer would be, and a node folder picker', async () => {
  const p = page()
  p.roster.permissions = { defaultPreset: 'ask', options: [{ id: 'ask', name: 'Ask' }] }
  p.roster.computer = { enabled: true }
  p.roster.browser = true
  const named = (node, names) => {
    if (Array.isArray(node)) return node.map(child => named(child, names))
    if (!node || typeof node !== 'object' || node.props === undefined) return node
    if (typeof node.type === 'function' && names.includes(node.type.name)) return named(node.type(node.props), names)
    return { ...node, props: { ...node.props, children: named(node.props.children, names) } }
  }
  const drawn = async id => named((await render(DetailsDrawer, drawerProps(p, id), { effects: false })).tree, ['PermissionRow', 'BotConnectors'])
  const tree = await drawn('bot-j1')
  assert.equal(find(tree, n => n.type?.name === 'PermissionPicker').length, 0, 'no preset picker that would only edit the shadow row')
  assert.equal(find(tree, n => n.type?.name === 'BotConnectors').length, 0)
  const notes = find(tree, n => n.props?.className === 'bt-note').map(n => textOf(n))
  assert.equal(notes.filter(text => text === NODE_REASON).length, 2, 'one for Permissions, one for Browser, computer use and connectors')
  const titles = find(tree, n => n.props?.className === 'bt-section-title').map(n => textOf(n))
  assert.ok(titles.includes('Permissions') && titles.includes('Browser, computer use and connectors'))
  const tabs = find(tree, n => n.props?.role === 'tab').map(n => textOf(n))
  assert.ok(!tabs.includes('Browser') && !tabs.includes('Computer'), `no Browser or Computer tab for a node Bot, got ${tabs}`)
  const [folder] = find(tree, n => n.type?.name === 'FolderMenu')
  assert.equal(folder.props.node, true, 'the folder is typed as a path on the node, not browsed on this disk')
  // A hub Bot keeps all of them.
  const local = await drawn('bot-local')
  assert.equal(find(local, n => n.type?.name === 'PermissionPicker').length, 1)
  const [localFolder] = find(local, n => n.type?.name === 'FolderMenu')
  assert.equal(localFolder.props.node, false)
})

test('the settings of a node Bot: no Private switch, Type, Hub URL or Token, Capabilities, Control or Duplicate that would only edit the shadow row', async () => {
  const p = page()
  const { tree } = await render(BotSettingsForm, { bot: p.bot('bot-j1'), roster: { ...p.roster, computer: { enabled: true }, capabilities: [{ name: 'x', kind: 'skill' }] }, actions: p.actions, run: x => x }, { effects: false })
  const all = textOf(tree)
  assert.doesNotMatch(all, /Hub URL|Remote Port|Enrollment token|Worker Bot \(Remote Machine\)/)
  assert.equal(find(tree, n => n.type === 'select' && n.props['aria-label'] === 'Bot type').length, 0)
  assert.equal(find(tree, n => n.type === 'select' && n.props['aria-label'] === 'Memory backend').length, 1, 'the memory backend is the node\'s and stays')
  const [priv] = find(tree, n => n.type?.name === 'SwitchRow' && n.props.label === 'Private')
  assert.equal(priv.props.disabled, true)
  assert.equal(priv.props.hint, NODE_REASON)
  assert.equal(find(tree, n => n.type?.name === 'BotCapabilitiesCard' || n.type?.name === 'BotComputerCard').length, 0)
  const cards = find(tree, n => n.type?.name === 'Card').map(n => n.props.title)
  assert.ok(cards.includes('Capabilities') && cards.includes('Control'))
  assert.equal(all.split(NODE_REASON).length - 1, 2, 'the reason shows in the Capabilities and Control cards (the Private switch carries it as its hint)')
  const duplicate = find(tree, n => n.type === 'button' && textOf(n).includes('Duplicate'))
  assert.equal(duplicate.length, 0, 'Duplicate is not a button for a node Bot')
  assert.match(all, /A node Bot cannot be copied here/)
  const [folder] = find(tree, n => n.type?.name === 'FolderMenu')
  assert.equal(folder.props.node, true)
})

test('a node Bot\'s folder trigger names the node\'s default, not this machine\'s team workspace', async () => {
  const noFolder = await render(FolderMenu, { value: undefined, node: true, actions: {}, run: x => x, onPick() {} }, { effects: false })
  assert.equal(textOf(find(noFolder.tree, n => n.props?.className === 'bt-model-name')[0]), "The node's default folder")
  const hub = await render(FolderMenu, { value: undefined, actions: {}, run: x => x, onPick() {} }, { effects: false })
  assert.equal(textOf(find(hub.tree, n => n.props?.className === 'bt-model-name')[0]), 'Team workspace')
})

test('the memory dialog of a node Bot opens on its entries and has no assistant box that would refuse', async () => {
  const props = owner => ({ owner, actions: { memoryView: async () => ({ entries: [], summary: null }), closeMemory() {} } })
  const node = await render(MemoryDialog, props({ id: 'bot-j1', name: 'Scout', node: true }), { effects: false })
  const [input] = find(node.tree, n => n.props?.className === 'bt-mem-input')
  assert.equal(input.props.disabled, true)
  assert.equal(input.props.placeholder, 'Not available for a node Bot: edit the entries in the list')
  assert.equal(find(node.tree, n => n.props?.['aria-label'] === 'Back to the summary').length, 0)
  assert.equal(textOf(find(node.tree, n => n.type === 'h2')[0]), 'All entries')
  const hub = await render(MemoryDialog, props({ id: 'bot-local', name: 'Local' }), { effects: false })
  assert.equal(find(hub.tree, n => n.props?.className === 'bt-mem-input')[0].props.placeholder, 'Ask or update')
  assert.equal(textOf(find(hub.tree, n => n.type === 'h2')[0]), 'Memory summary')
})

test('the host\'s node-only refusal reads as its own sentence, not as "the node refused"', () => {
  assert.equal(joinedUpdateErrorText(NODE_REASON), NODE_REASON)
})
