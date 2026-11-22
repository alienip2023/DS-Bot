// Bot 市场：精选行 + 分类分区 + 搜索/分类筛选 + 详情页，一键从模板创建 Bot。
// 数据源：POST /api/bot endpoint=market-browse（本地模板库；字段见 host/bot-templates.js marketEntry）。
// 结构：
//   总览   搜索框、分类条、「Featured」精选行、每个分类一排卡片（多于一排时「See all」进入该分类）
//   筛选   有搜索词或选了分类时，平铺结果
//   详情   点卡片进入：它做什么、完整指令、不能用的工具、改名后创建
import { createElement as h, useEffect, useMemo, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon, PlusIcon, SearchIcon } from './icons.js'
import { inkFill } from './inks.js'
import { BotMark } from './mark.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'

// The order of the shelves; a category outside it (a user template's own) follows, alphabetical.
const CATEGORY_ORDER = ['管理', '工程', '运维', '数据', '产品', '研究', '写作']
// A category's color, one of the Bot inks (themed, light and dark).
const CATEGORY_INK = { 管理: 'green', 工程: 'blue', 运维: 'orange', 数据: 'cyan', 产品: 'violet', 研究: 'yellow', 写作: 'magenta' }
const INK_CYCLE = ['rose', 'sky', 'tangerine', 'cobalt', 'deepseek', 'aurora']
const SHELF_SIZE = 6
const INSTRUCTIONS_PREVIEW = 700

const DUTY_LABEL = { lead: 'Leads the team', qa: 'Reviews the work', executor: 'Does the work' }

export const categoryInk = (category) => {
  if (CATEGORY_INK[category]) return CATEGORY_INK[category]
  let sum = 0
  for (const ch of String(category ?? '')) sum = (sum + ch.charCodeAt(0)) % 997
  return INK_CYCLE[sum % INK_CYCLE.length]
}

const needleOf = tmpl => [tmpl.id, tmpl.name, tmpl.role, tmpl.description, tmpl.category, tmpl.creator, ...(tmpl.tags ?? [])]
  .filter(Boolean).join(' ').toLowerCase()

// Templates matching every word of the query (the same way the host filters), in the category if one is set.
export function filterMarket(templates, query, category) {
  const words = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  return templates.filter(tmpl => (category === '' || tmpl.category === category)
    && words.every(word => needleOf(tmpl).includes(word)))
}

// Categories in shelf order, each with how many templates it holds.
export function shelvesOf(templates) {
  const groups = new Map()
  for (const tmpl of templates) {
    const key = tmpl.category || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(tmpl)
  }
  const known = CATEGORY_ORDER.filter(key => groups.has(key))
  const rest = [...groups.keys()].filter(key => !CATEGORY_ORDER.includes(key)).sort()
  return [...known, ...rest].map(key => ({ category: key, items: groups.get(key) }))
}

function Avatar({ tmpl, size }) {
  return h('span', { className: 'bt-market-avatar', style: { '--mk': inkFill(categoryInk(tmpl.category)), width: size, height: size } },
    h(BotMark, { bot: { id: `market:${tmpl.id}`, name: tmpl.name }, size: Math.round(size * 0.78) }))
}

function Card({ tmpl, featured = false, onOpen, onAdd, busy }) {
  const label = tmpl.category || t('Other')
  return h('div', { className: featured ? 'bt-market-card bt-market-card-featured' : 'bt-market-card', style: { '--mk': inkFill(categoryInk(tmpl.category)) } },
    h('button', { type: 'button', className: 'bt-market-open', onClick: () => onOpen(tmpl), 'aria-label': tmpl.name },
      h(Avatar, { tmpl, size: featured ? 52 : 40 }),
      h('span', { className: 'bt-market-card-text' },
        h('span', { className: 'bt-market-name' }, tmpl.name),
        h('span', { className: 'bt-market-meta' },
          tmpl.role ? h('span', { className: 'bt-market-role' }, tmpl.role) : null,
          h('span', { className: 'bt-market-creator' }, t('by {creator}', { creator: tmpl.creator || 'DS Bot' }))),
        h('span', { className: 'bt-market-desc' }, tmpl.description || ''),
        featured ? h('span', { className: 'bt-market-cat-label' }, label) : null)),
    h('button', {
      type: 'button', className: 'bt-market-add', disabled: busy,
      'aria-label': t('Create {name}', { name: tmpl.name }), title: t('Create from template'),
      onClick: () => onAdd(tmpl),
    }, busy ? h('span', { className: 'bt-market-spin', 'aria-hidden': true }) : h(PlusIcon)))
}

function Detail({ tmpl, onBack, onCreate, busy, result }) {
  const [name, setName] = useState(tmpl.name)
  const [whole, setWhole] = useState(false)
  useEscape(onBack, true)
  const instructions = String(tmpl.instructions || '').trim()
  const long = instructions.length > INSTRUCTIONS_PREVIEW
  const shown = whole || !long ? instructions : `${instructions.slice(0, INSTRUCTIONS_PREVIEW).trimEnd()}…`
  const denied = Array.isArray(tmpl.denyTools) ? tmpl.denyTools : []
  const duty = DUTY_LABEL[tmpl.duty]
  return h('div', { className: 'bt-market bt-market-detail', style: { '--mk': inkFill(categoryInk(tmpl.category)) } },
    h('button', { type: 'button', className: 'bt-market-back', onClick: onBack },
      h(ChevronLeftIcon), t('Bot Market')),
    h('div', { className: 'bt-market-hero' },
      h(Avatar, { tmpl, size: 76 }),
      h('div', { className: 'bt-market-hero-text' },
        h('h2', { className: 'bt-market-title' }, tmpl.name),
        h('div', { className: 'bt-market-meta' },
          h('span', { className: 'bt-market-creator' }, t('by {creator}', { creator: tmpl.creator || 'DS Bot' })),
          tmpl.source === 'user' ? h('span', { className: 'bt-market-badge' }, t('Your template')) : null),
        h('div', { className: 'bt-market-chips' },
          tmpl.category ? h('span', { className: 'bt-chip' }, tmpl.category) : null,
          tmpl.role ? h('span', { className: 'bt-chip' }, tmpl.role) : null,
          duty ? h('span', { className: 'bt-chip' }, t(duty)) : null))),
    h('form', {
      className: 'bt-market-create',
      onSubmit: (event) => { event.preventDefault(); onCreate(tmpl, name.trim() || tmpl.name) },
    },
      h('input', {
        className: 'bt-input', value: name, maxLength: 60, disabled: busy,
        onChange: event => setName(event.target.value), 'aria-label': t('Name'),
      }),
      h('button', { type: 'submit', className: 'bt-send bt-market-create-btn', disabled: busy },
        busy ? t('Creating…') : t('Create Bot'))),
    result ? h('div', { className: result.ok ? 'bt-market-note' : 'bt-market-note bt-market-note-error', role: 'status' },
      result.ok ? h(CheckIcon) : null, result.text) : null,
    tmpl.description ? h('section', { className: 'bt-market-block' },
      h('h3', null, t('What it does')),
      h('p', null, tmpl.description)) : null,
    instructions ? h('section', { className: 'bt-market-block' },
      h('h3', null, t('Instructions')),
      h('pre', { className: 'bt-market-instructions' }, shown),
      long ? h('button', { type: 'button', className: 'bt-market-link', onClick: () => setWhole(!whole) }, whole ? t('Show less') : t('Show all')) : null) : null,
    denied.length > 0 ? h('section', { className: 'bt-market-block' },
      h('h3', null, t('Tools it cannot use')),
      h('div', { className: 'bt-market-chips' }, denied.map(tool => h('code', { key: tool, className: 'bt-chip' }, tool)))) : null,
    Array.isArray(tmpl.tags) && tmpl.tags.length > 0 ? h('section', { className: 'bt-market-block' },
      h('div', { className: 'bt-market-chips' }, tmpl.tags.map(tag => h('span', { key: tag, className: 'bt-chip' }, tag)))) : null)
}

export function MarketPage({ actions }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [openId, setOpenId] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [result, setResult] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (typeof actions.marketBrowse !== 'function') { setLoading(false); return undefined }
    actions.marketBrowse('', '').then((res) => {
      if (cancelled) return
      setTemplates(Array.isArray(res?.templates) ? res.templates : [])
      setError('')
    }).catch((err) => {
      if (!cancelled) setError(err?.message ?? String(err))
    }).then(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const create = async (tmpl, name) => {
    setBusyId(tmpl.id)
    setResult(null)
    try {
      const made = typeof actions.marketInstall === 'function'
        ? await actions.marketInstall(tmpl.id, name, tmpl.model)
        : await actions.createBot({ name, role: tmpl.role || '', model: tmpl.model || undefined, instructions: tmpl.instructions || tmpl.description || '' })
      const created = made?.bot?.name ?? made?.name ?? name
      setResult({ ok: true, text: t('Created {name} from template "{tmpl}".', { name: created, tmpl: tmpl.name }) })
    } catch (err) {
      setResult({ ok: false, text: t('Could not create: {error}', { error: err?.message ?? String(err) }) })
    } finally {
      setBusyId(null)
    }
  }

  const open = (tmpl) => { setResult(null); setOpenId(tmpl.id) }
  const categories = useMemo(() => shelvesOf(templates), [templates])
  const shown = useMemo(() => filterMarket(templates, query, category), [templates, query, category])
  const featured = useMemo(() => templates.filter(tmpl => tmpl.featured), [templates])
  const current = openId === null ? undefined : templates.find(tmpl => tmpl.id === openId)

  if (current) {
    return h(Detail, { key: current.id, tmpl: current, onBack: () => setOpenId(null), onCreate: create, busy: busyId === current.id, result })
  }

  const overview = query.trim() === '' && category === ''
  const card = (tmpl, featuredCard = false) => h(Card, { key: tmpl.id, tmpl, featured: featuredCard, onOpen: open, onAdd: tmpl2 => create(tmpl2, tmpl2.name), busy: busyId === tmpl.id })

  return h('div', { className: 'bt-market' },
    h('header', { className: 'bt-market-head' },
      h('h2', { className: 'bt-market-title' }, t('Bot Market')),
      h('p', { className: 'bt-market-sub' }, loading ? t('Loading…') : `${t('Ready-made Bots for your team')} · ${templates.length} ${t('templates')}`)),
    h('div', { className: 'bt-market-search' },
      h('span', { className: 'bt-market-search-icon', 'aria-hidden': true }, h(SearchIcon)),
      h('input', {
        className: 'bt-input bt-market-search-input', type: 'search', value: query,
        placeholder: t('Search templates by name, role, tag…'), onChange: event => setQuery(event.target.value), 'aria-label': t('Search'),
      })),
    categories.length > 1 ? h('div', { className: 'bt-market-cats', role: 'group', 'aria-label': t('Category') },
      h('button', { type: 'button', className: 'bt-market-chip', 'aria-pressed': category === '', onClick: () => setCategory('') }, t('All')),
      categories.map(({ category: key, items }) => h('button', {
        key: key || '-', type: 'button', className: 'bt-market-chip', 'aria-pressed': category === key,
        style: { '--mk': inkFill(categoryInk(key)) }, onClick: () => setCategory(category === key ? '' : key),
      }, key || t('Other'), h('span', { className: 'bt-market-chip-n' }, items.length)))) : null,
    result ? h('div', { className: result.ok ? 'bt-market-note' : 'bt-market-note bt-market-note-error', role: 'status' }, result.ok ? h(CheckIcon) : null, result.text) : null,
    error ? h('div', { className: 'bt-error', role: 'alert' }, t('Could not load templates: {error}', { error })) : null,
    loading ? h('div', { className: 'bt-market-loading' }, t('Loading templates…'))
      : shown.length === 0 ? h('div', { className: 'bt-market-empty' }, t('No templates found. Try a different search.'))
      : overview ? h('div', { className: 'bt-market-shelves' },
          featured.length > 0 ? h('section', { className: 'bt-market-shelf' },
            h('h3', { className: 'bt-market-shelf-title' }, t('Featured')),
            h('div', { className: 'bt-market-featured' }, featured.map(tmpl => card(tmpl, true)))) : null,
          categories.map(({ category: key, items }) => h('section', { key: key || '-', className: 'bt-market-shelf' },
            h('div', { className: 'bt-market-shelf-head' },
              h('h3', { className: 'bt-market-shelf-title' }, key || t('Other')),
              items.length > SHELF_SIZE ? h('button', { type: 'button', className: 'bt-market-link', onClick: () => setCategory(key) },
                t('See all {count}', { count: items.length }), h(ChevronRightIcon)) : null),
            h('div', { className: 'bt-market-grid' }, items.slice(0, SHELF_SIZE).map(tmpl => card(tmpl))))))
      : h('section', { className: 'bt-market-shelf' },
          h('h3', { className: 'bt-market-shelf-title' }, category !== '' && query.trim() === '' ? category : t('{count} results', { count: shown.length })),
          h('div', { className: 'bt-market-grid' }, shown.map(tmpl => card(tmpl)))))
}
