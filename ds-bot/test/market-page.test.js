// The Bot Market page: featured row, category shelves, search and category filter, the detail
// page, and creating a Bot from a template. The REAL market.js is bundled and driven by a small
// stateful React stand-in (components, useState, useEffect, useMemo); the avatar and the Escape
// hook are stubbed, since neither is what is tested.
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { BUILTIN_TEMPLATES, FEATURED_TEMPLATE_IDS, marketEntry } from '../src/host/bot-templates.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const stubs = {
  './mark.js': 'export const BotMark = props => ({ type: "mark", props })',
  './overlay-hooks.js': 'export const escapes = []; export const useEscape = (fn, active) => { if (active) escapes.push(fn) }',
}
const { outputFiles } = await build({
  stdin: { contents: "export * from './src/client/market.js'; export { escapes } from './src/client/overlay-hooks.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /\/(mark|overlay-hooks)\.js$/ }, args => ({ path: `./${args.path.split('/').pop()}`, namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})

// ── a small stateful renderer ────────────────────────────────────────────────
let current
let dirty = false
const instances = new Map()
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState(initial) {
    const own = current
    const i = own.i++
    if (!(i in own.slots)) own.slots[i] = typeof initial === 'function' ? initial() : initial
    return [own.slots[i], (value) => {
      const next = typeof value === 'function' ? value(own.slots[i]) : value
      if (Object.is(next, own.slots[i])) return
      own.slots[i] = next
      dirty = true
    }]
  },
  useMemo(make, deps) {
    const own = current
    const i = own.i++
    const slot = own.slots[i]
    if (slot && deps.length === slot.deps.length && deps.every((dep, at) => Object.is(dep, slot.deps[at]))) return slot.value
    const value = make()
    own.slots[i] = { deps, value }
    return value
  },
  useEffect(effect, deps) {
    const own = current
    const i = own.i++
    const slot = own.slots[i]
    if (slot && deps && slot.deps && deps.length === slot.deps.length && deps.every((dep, at) => Object.is(dep, slot.deps[at]))) return
    own.slots[i] = { deps }
    own.effects.push(effect)
  },
}
const cjs = { exports: {} }
runInNewContext(outputFiles[0].text, { module: cjs, exports: cjs.exports, require: name => (name === 'react' ? react : {}) })
const { MarketPage, filterMarket, shelvesOf, categoryInk, escapes } = cjs.exports

function expand(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child, at) => expand(child, `${path}/${child?.props?.key ?? at}`))
  if (typeof node.type === 'function') {
    const key = `${path}:${node.type.name}:${node.props.key ?? ''}`
    const own = instances.get(key) ?? { slots: [], effects: [], i: 0 }
    instances.set(key, own)
    own.i = 0
    own.effects = []
    current = own
    const out = node.type({ ...node.props, children: node.children })
    for (const effect of own.effects) effect()
    return expand(out, key)
  }
  return { type: node.type, props: node.props, children: (node.children ?? []).map((child, at) => expand(child, `${path}/${child?.props?.key ?? at}`)) }
}

async function mount(props) {
  instances.clear()
  escapes.length = 0
  const state = { tree: null }
  const draw = () => { dirty = false; state.tree = expand({ type: MarketPage, props, children: [] }, 'root') }
  draw()
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) {
      await new Promise(resolve => setImmediate(resolve))
      if (!dirty) return
      draw()
    }
    throw new Error('the page never settled')
  }
  await settle()
  return { get tree() { return state.tree }, settle: async (fn) => { await fn?.(); dirty = true; await settle() } }
}

const walk = (node, visit) => {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  visit(node)
  node.children?.forEach(child => walk(child, visit))
}
const all = (tree, match) => { const hits = []; walk(tree, node => { if (match(node)) hits.push(node) }); return hits }
const textOf = (node) => { let text = ''; walk(node, n => n.children?.forEach(child => { if (typeof child === 'string' || typeof child === 'number') text += child })); return text }
const byClass = (tree, name) => all(tree, node => String(node.props?.className ?? '').split(/\s+/).includes(name))

// Arrays made inside the bundle come from another realm; compare plain copies.
const ids = list => Array.from(list, item => item.id)
const plain = list => Array.from(list)

const tmpl = (id, category, extra = {}) => ({
  id, name: `Bot ${id}`, role: `Role ${id}`, duty: 'executor', category, tags: [id, 'tag'], description: `Does ${id} work`,
  model: null, denyTools: [], instructions: `Instructions of ${id}`, creator: 'DS Bot', source: 'builtin', featured: false, ...extra,
})
const CATALOG = [
  tmpl('a1', '工程', { featured: true }), tmpl('a2', '工程'), tmpl('a3', '工程'), tmpl('a4', '工程'), tmpl('a5', '工程'), tmpl('a6', '工程'), tmpl('a7', '工程'),
  tmpl('b1', '数据', { featured: true, denyTools: ['write', 'edit'] }), tmpl('c1', '写作'),
  tmpl('u1', '我的', { creator: 'You', source: 'user' }),
]
const actionsOf = ({ templates = CATALOG, install } = {}) => {
  const calls = { browse: [], install: [] }
  return {
    calls,
    actions: {
      marketBrowse: async (query, category) => { calls.browse.push([query, category]); return { templates } },
      marketInstall: install ?? (async (id, name, model) => { calls.install.push([id, name, model]); return { bot: { id: 'new', name } } }),
    },
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('filterMarket needs every word, in the name, role, description, category, creator or tags', () => {
  assert.equal(filterMarket(CATALOG, '', '').length, CATALOG.length)
  assert.deepEqual(ids(filterMarket(CATALOG, 'a1', '')), ['a1'])
  assert.deepEqual(ids(filterMarket(CATALOG, 'tag 数据', '')), ['b1'], 'two words, both matched')
  assert.deepEqual(ids(filterMarket(CATALOG, 'work', '写作')), ['c1'])
  assert.deepEqual(ids(filterMarket(CATALOG, 'you', '')), ['u1'], 'the creator is searchable')
  assert.deepEqual(plain(filterMarket(CATALOG, 'a1 b1', '')), [], 'every word has to match one template')
  assert.equal(filterMarket(CATALOG, '  ', '工程').length, 7)
})

test('shelvesOf keeps the shelf order and puts an unknown category last', () => {
  const shelves = shelvesOf(CATALOG)
  assert.deepEqual(plain(shelves.map(shelf => shelf.category)), ['工程', '数据', '写作', '我的'])
  assert.deepEqual(plain(shelves.map(shelf => shelf.items.length)), [7, 1, 1, 1])
})

test('a category keeps its ink, and an unknown one gets a stable ink of the palette', () => {
  assert.equal(categoryInk('工程'), 'blue')
  assert.equal(categoryInk('我的'), categoryInk('我的'))
  assert.ok(['rose', 'sky', 'tangerine', 'cobalt', 'deepseek', 'aurora'].includes(categoryInk('我的')))
})

// ── the host's view of a template ────────────────────────────────────────────

test('built-in templates are DS Bot\'s, a user file is the user\'s, and the top shelf is a short list', () => {
  const builtin = marketEntry(BUILTIN_TEMPLATES.find(item => item.id === 'fullstack-engineer'))
  assert.equal(builtin.creator, 'DS Bot')
  assert.equal(builtin.source, 'builtin')
  assert.equal(builtin.featured, true)
  assert.equal(marketEntry(BUILTIN_TEMPLATES.find(item => item.id === 'debugger')).featured, false)
  for (const id of FEATURED_TEMPLATE_IDS) assert.ok(BUILTIN_TEMPLATES.some(item => item.id === id), `${id} is a built-in template`)
  const own = marketEntry({ id: 'mine', name: 'Mine', _source: 'user' })
  assert.deepEqual([own.creator, own.source, own.featured], ['You', 'user', false])
  assert.equal(marketEntry({ id: 'x', name: 'X', _source: 'user', creator: 'Team A', featured: 'true' }).creator, 'Team A')
  assert.equal(marketEntry({ id: 'x', name: 'X', _source: 'user', featured: 'true' }).featured, true)
  assert.equal(marketEntry({ id: 'fullstack-engineer', name: 'X', featured: false }).featured, false, 'an explicit no keeps it off the shelf')
})

// ── the page ─────────────────────────────────────────────────────────────────

test('the overview shows the featured row, then one shelf per category, with See all past six', async () => {
  const { actions, calls } = actionsOf()
  const page = await mount({ actions })
  assert.deepEqual(calls.browse, [['', '']], 'the catalog is read once; the filtering is local')
  const titles = byClass(page.tree, 'bt-market-shelf-title').map(textOf)
  assert.deepEqual(titles, ['Featured', '工程', '数据', '写作', '我的'])
  assert.deepEqual(byClass(page.tree, 'bt-market-featured').flatMap(row => byClass(row, 'bt-market-name')).map(textOf), ['Bot a1', 'Bot b1'])
  const engineering = byClass(page.tree, 'bt-market-shelf').find(shelf => textOf(byClass(shelf, 'bt-market-shelf-title')[0]) === '工程')
  assert.equal(byClass(engineering, 'bt-market-card').length, 6, 'a shelf shows two rows')
  assert.match(textOf(byClass(engineering, 'bt-market-link')[0]), /See all 7/)
  assert.equal(byClass(page.tree, 'bt-market-link').length, 1, 'only the shelf with more has it')
  assert.match(textOf(byClass(page.tree, 'bt-market-sub')[0]), /10 templates/)
})

test('a search shows the matches flat, with their count, and nothing else', async () => {
  const page = await mount(actionsOf())
  const input = byClass(page.tree, 'bt-market-search-input')[0]
  await page.settle(() => input.props.onChange({ target: { value: 'work' } }))
  assert.deepEqual(byClass(page.tree, 'bt-market-shelf-title').map(textOf), ['10 results'])
  assert.equal(byClass(page.tree, 'bt-market-featured').length, 0)
  await page.settle(() => byClass(page.tree, 'bt-market-search-input')[0].props.onChange({ target: { value: 'zzz' } }))
  assert.match(textOf(byClass(page.tree, 'bt-market-empty')[0]), /No templates found/)
})

test('a category chip shows that category flat, and the same chip again goes back', async () => {
  const page = await mount(actionsOf())
  const chips = byClass(page.tree, 'bt-market-chip')
  assert.deepEqual(chips.map(chip => chip.props['aria-pressed']), [true, false, false, false, false])
  assert.deepEqual(chips.map(textOf), ['All', '工程7', '数据1', '写作1', '我的1'], 'each category chip counts its templates')
  await page.settle(() => chips[1].props.onClick())
  assert.deepEqual(byClass(page.tree, 'bt-market-shelf-title').map(textOf), ['工程'])
  assert.equal(byClass(page.tree, 'bt-market-card').length, 7, 'the whole category, not two rows')
  await page.settle(() => byClass(page.tree, 'bt-market-chip')[1].props.onClick())
  assert.equal(byClass(page.tree, 'bt-market-featured').length, 1)
})

test('a card opens its detail page; Escape and the back button leave it', async () => {
  const page = await mount(actionsOf())
  const card = byClass(page.tree, 'bt-market-card-featured').find(node => textOf(node).includes('Bot b1'))
  await page.settle(() => byClass(card, 'bt-market-open')[0].props.onClick())
  assert.equal(byClass(page.tree, 'bt-market-detail').length, 1)
  assert.equal(textOf(byClass(page.tree, 'bt-market-title')[0]), 'Bot b1')
  assert.match(textOf(byClass(page.tree, 'bt-market-creator')[0]), /by DS Bot/)
  assert.match(textOf(byClass(page.tree, 'bt-market-instructions')[0]), /Instructions of b1/)
  assert.deepEqual(byClass(page.tree, 'bt-market-block').flatMap(block => all(block, node => node.type === 'code')).map(textOf), ['write', 'edit'], 'the tools it cannot use are listed')
  assert.equal(escapes.length, 1, 'Escape is registered while a detail page is open')
  await page.settle(() => escapes[0]())
  assert.equal(byClass(page.tree, 'bt-market-detail').length, 0)
  assert.equal(byClass(page.tree, 'bt-market-featured').length, 1)
})

test('the detail page creates the Bot under the name typed, and says so', async () => {
  const { actions, calls } = actionsOf()
  const page = await mount({ actions })
  await page.settle(() => byClass(byClass(page.tree, 'bt-market-card')[0], 'bt-market-open')[0].props.onClick())
  const form = byClass(page.tree, 'bt-market-create')[0]
  const input = all(form, node => node.type === 'input')[0]
  assert.equal(input.props.value, 'Bot a1', 'the template\'s name is the default')
  await page.settle(() => input.props.onChange({ target: { value: 'Mina' } }))
  await page.settle(() => byClass(page.tree, 'bt-market-create')[0].props.onSubmit({ preventDefault() {} }))
  assert.deepEqual(calls.install, [['a1', 'Mina', null]])
  assert.match(textOf(byClass(page.tree, 'bt-market-note')[0]), /Created Mina from template "Bot a1"/)
})

test('the + on a card creates the Bot at once under the template\'s name, without opening it', async () => {
  const { actions, calls } = actionsOf()
  const page = await mount({ actions })
  await page.settle(() => byClass(byClass(page.tree, 'bt-market-card')[0], 'bt-market-add')[0].props.onClick())
  assert.deepEqual(calls.install, [['a1', 'Bot a1', null]])
  assert.equal(byClass(page.tree, 'bt-market-detail').length, 0)
  assert.match(textOf(byClass(page.tree, 'bt-market-note')[0]), /Created Bot a1/)
})

test('a creation that fails says why, as an error', async () => {
  const { actions } = actionsOf({ install: async () => { throw new Error('No model is set') } })
  const page = await mount({ actions })
  await page.settle(() => byClass(byClass(page.tree, 'bt-market-card')[0], 'bt-market-add')[0].props.onClick())
  const note = byClass(page.tree, 'bt-market-note-error')[0]
  assert.match(textOf(note), /Could not create: No model is set/)
})

test('a catalog that cannot be read shows the error and no shelves', async () => {
  const page = await mount({ actions: { marketBrowse: async () => { throw new Error('offline') } } })
  assert.match(textOf(byClass(page.tree, 'bt-error')[0]), /Could not load templates: offline/)
  assert.equal(byClass(page.tree, 'bt-market-shelf').length, 0)
})
