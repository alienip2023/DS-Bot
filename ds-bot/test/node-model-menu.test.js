import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { installLocale as installLocaleHere } from '../src/client/i18n.js'
import { realTeamActions, hostRoster, joinedRuntime } from './bot-home-fixtures.js'

// fork.64: the model picker of a remote (joined) Bot lists what its NODE can run. The REAL
// DetailsDrawer is rendered with a small stateful React stand-in; the REAL BotModelMenu fetches
// the node's catalog through the real teamActions (botCreateTargets -> call), the REAL ModelMenu
// is opened (state slot seeded), and its rows are clicked.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { DetailsDrawer } from './src/client/details-drawer.js'",
      "export { BotSettingsForm } from './src/client/bot-settings.js'",
      "export { ModelMenu } from './src/client/model-menu.js'",
      "export { installLocale } from './src/client/i18n.js'",
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
  useEffect(fn) { hooks.effects.push(fn) }, useLayoutEffect() {},
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
const { DetailsDrawer, BotSettingsForm, ModelMenu, installLocale } = module.exports

const settle = () => new Promise(resolve => setTimeout(resolve, 5))
// Render a component as a function; run its effects once, let the promises settle, render again.
async function render(Component, props, { seed = {}, effects = true } = {}) {
  hooks = { i: 0, slots: {}, effects: [], seed, sets: [] }
  Component(props)
  if (effects) {
    for (const effect of hooks.effects) effect()
    await settle()
  }
  hooks.i = 0
  hooks.effects = []
  const tree = Component(props)
  return { tree, sets: hooks.sets }
}
const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}
// Components without hooks that make up the menu body are rendered in place (ModelChoices, ModelRows).
const INLINE = new Set(['ModelChoices', 'ModelRows'])
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object' || node.props === undefined) return node
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
function page({ nodeModels = NODE_MODELS, targetsFail = false, bot: botPatch = {} } = {}) {
  const rt = joinedRuntime({ mirrorSessionId: 'sess-mirror' })
  Object.assign(rt.state.bots['bot-j1'], botPatch)
  rt.state.bots['bot-local'] = { id: 'bot-local', name: 'Local', type: 'bot', model: 'piion/m1' }
  const calls = []
  const roster = { ...hostRoster(rt), models: MAIN_MODELS, ready: true }
  const actions = {
    ...realTeamActions(roster, {
      roster: { getSnapshot: () => roster },
      call: async (endpoint, body) => {
        calls.push([endpoint, body])
        if (endpoint === 'bot-create-targets') { if (targetsFail) throw new Error('boom'); return [{ nodeId: 'n1', hostname: 'node-1', online: true, models: nodeModels, defaultModel: null }] }
        return {}
      },
    }),
    closeOverlay() {}, refreshModels: async () => {}, efforts: async () => ({}),
  }
  return { calls, roster, actions, bot: id => roster.byId[id] }
}

const drawerProps = (p, sessionId) => ({
  sessionId, roster: p.roster, actions: p.actions, hasStrip: false,
  useSessions: pick => pick({ byId: {}, projectionsBySession: {} }), useSessionStatus: pick => pick(new Map()),
  useActivity: pick => pick({}), useWork: pick => pick({ rooms: {}, waiting: {} }),
  useBrowserTabs: () => [], useBrowserPages: () => ({}), useComputer: () => ({}),
})

// The open menu of the Bot's model picker, as rendered by the drawer: BotModelMenu (fetches the
// node catalog) -> NodeModelMenu -> ModelMenu, whose popup is opened by seeding its `place` state.
async function openDrawerMenu(p, sessionId) {
  const { tree, sets } = await render(DetailsDrawer, drawerProps(p, sessionId), { effects: false })
  const [bm] = find(tree, n => n.type?.name === 'BotModelMenu')
  assert.ok(bm, 'the drawer must render BotModelMenu for the Bot model')
  const { tree: bmOut } = await render(bm.type, bm.props)
  const [nmEl] = find(bmOut, n => n.type?.name === 'NodeModelMenu')
  assert.ok(nmEl, 'BotModelMenu must render NodeModelMenu')
  const { tree: nm } = await render(nmEl.type, nmEl.props, { effects: false })
  const [menuEl] = find(nm, n => n.type === ModelMenu)
  assert.ok(menuEl, 'BotModelMenu must render ModelMenu')
  const { tree: opened } = await render(ModelMenu, menuEl.props, { effects: false, seed: { 1: { left: 0, width: 240, top: 0, maxHeight: 400 } } })
  const open = expand(opened)
  const items = find(open, n => n.type === 'button' && /^menuitem/.test(n.props.role ?? ''))
  return {
    props: menuEl.props, drawerSets: sets,
    pickable: items.filter(n => n.props.role === 'menuitemradio'),
    off: items.filter(n => n.props.className === 'bt-model-off'),
    text: textOf(open),
    all: items,
  }
}

test('M5-a: a joined remote Bot drawer lists the node catalog, plus the rest greyed out under "Not synced to the node yet"', async () => {
  const p = page()
  const m = await openDrawerMenu(p, 'bot-j1')
  assert.deepEqual(m.pickable.map(n => n.props.title), ['ccmax/claude-sonnet-5-5', 'piion/m1'])
  assert.deepEqual(m.off.map(n => textOf(n)), [
    'Grok 4.3|This model\'s provider setup is not synced to the node yet',
    'Claude Code Sonnet|The node has no matching CLI yet, or its setup is not synced',
  ])
  assert.match(m.text, /Not synced to the node yet/)
  assert.equal(m.props.notice, null)
})

test('M5-a2: picking a node model saves it (updateBot -> update-bot); a greyed-out row is disabled and saves nothing', async () => {
  const p = page({ bot: { model: 'piion/m1' } })
  const m = await openDrawerMenu(p, 'bot-j1')
  p.calls.length = 0
  m.pickable.find(n => n.props.title === 'ccmax/claude-sonnet-5-5').props.onClick()
  await settle()
  assert.deepEqual(p.calls.filter(c => c[0] === 'update-bot'), [['update-bot', { id: 'bot-j1', model: 'ccmax/claude-sonnet-5-5' }]])
  p.calls.length = 0
  assert.equal(m.off.length, 2)
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
  assert.deepEqual(m.pickable.map(n => n.props.title), MAIN_MODELS.map(x => x.ref))
  assert.deepEqual(m.off, [])
  assert.equal(m.props.notice, null)
  assert.equal(p.calls.some(c => c[0] === 'bot-create-targets'), false)
})

test('M5-c: no node catalog (empty, or the lookup failed): the main list with a notice on top', async () => {
  for (const opts of [{ nodeModels: [] }, { targetsFail: true }]) {
    const p = page(opts)
    const m = await openDrawerMenu(p, 'bot-j1')
    assert.deepEqual(m.pickable.map(n => n.props.title), MAIN_MODELS.map(x => x.ref))
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
      'Grok 4.3|该模型的提供商配置还没同步到节点',
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
