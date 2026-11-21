// Bot 市场：浏览模板库、搜索、一键创建 Bot。
// 数据源：POST /api/bot endpoint=list-templates（本地模板库）。
// 未来扩展：market-browse / market-install（远程注册表）。
import { createElement as h, useEffect, useMemo, useState } from 'react'
import { ChevronLeftIcon, PlusIcon, SearchIcon } from './icons.js'
import { t } from './i18n.js'

const CATEGORIES = ['工程', '运维', '数据', '产品', '写作', '管理', '研究']

function MarketCard({ tmpl, onInstall, busy }) {
  const duty = tmpl.duty ? h('span', { className: 'bt-market-duty' }, tmpl.duty) : null
  const tags = Array.isArray(tmpl.tags) && tmpl.tags.length > 0
    ? h('div', { className: 'bt-market-tags' }, tmpl.tags.slice(0, 4).map(tag => h('span', { key: tag, className: 'bt-market-tag' }, tag)))
    : null
  return h('div', { className: 'bt-market-card' },
    h('div', { className: 'bt-market-card-head' },
      h('span', { className: 'bt-market-name' }, tmpl.name),
      duty),
    h('div', { className: 'bt-market-role' }, tmpl.role || '—'),
    h('p', { className: 'bt-market-desc' }, tmpl.description || ''),
    tags,
    h('div', { className: 'bt-market-foot' },
      h('button', {
        type: 'button',
        className: 'bt-send bt-market-install',
        disabled: busy,
        onClick: () => onInstall(tmpl),
      }, busy ? t('Creating…') : t('Create from template'))))
}

export function MarketPage({ actions, onBack }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [installing, setInstalling] = useState(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    let cancelled = false
    if (typeof actions.marketBrowse !== 'function') { setLoading(false); return }
    setLoading(true)
    actions.marketBrowse(query, category).then(res => {
      if (cancelled) return
      const list = Array.isArray(res?.templates) ? res.templates : []
      setTemplates(list)
      setError('')
    }).catch(err => {
      if (!cancelled) setError(err?.message ?? String(err))
    }).then(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, category])

  const onInstall = async (tmpl) => {
    setInstalling(tmpl.id)
    setNote('')
    try {
      const result = typeof actions.marketInstall === 'function'
        ? await actions.marketInstall(tmpl.id, tmpl.name, tmpl.model)
        : await actions.createBot({
            name: tmpl.name,
            role: tmpl.role || '',
            model: tmpl.model || undefined,
            instructions: tmpl.instructions || tmpl.description || '',
          })
      const name = result?.bot?.name ?? result?.name ?? tmpl.name
      setNote(t('Created {name} from template "{tmpl}".', { name, tmpl: tmpl.id }))
    } catch (err) {
      setNote(t('Could not create: {error}', { error: err?.message ?? String(err) }))
    } finally {
      setInstalling(null)
    }
  }

  const grouped = useMemo(() => {
    const map = {}
    for (const tmpl of templates) {
      const cat = tmpl.category || t('Other')
      ;(map[cat] ??= []).push(tmpl)
    }
    return map
  }, [templates])

  return h('div', { className: 'bt-market' },
    h('div', { className: 'bt-market-head' },
      onBack ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), onClick: onBack }, h(ChevronLeftIcon)) : null,
      h('span', { className: 'bt-page-title' }, t('Bot Market')),
      h('span', { className: 'bt-market-count' }, loading ? t('Loading…') : `${templates.length} ${t('templates')}`)),
    h('div', { className: 'bt-market-toolbar' },
      h('div', { className: 'bt-market-search' },
        h(SearchIcon ? SearchIcon : 'span', { className: 'bt-market-search-icon' }),
        h('input', {
          className: 'bt-input bt-market-search-input',
          type: 'search',
          placeholder: t('Search templates by name, role, tag…'),
          value: query,
          onChange: e => setQuery(e.target.value),
          'aria-label': t('Search'),
        })),
      h('select', {
        className: 'bt-input bt-market-cat',
        value: category,
        onChange: e => setCategory(e.target.value),
        'aria-label': t('Category'),
      },
        h('option', { value: '' }, t('All categories')),
        CATEGORIES.map(cat => h('option', { key: cat, value: cat }, cat)))),
    note ? h('div', { className: 'bt-market-note' }, note) : null,
    error ? h('div', { className: 'bt-error', role: 'alert' }, t('Could not load templates: {error}', { error })) : null,
    loading ? h('div', { className: 'bt-market-loading' }, t('Loading templates…'))
      : templates.length === 0 ? h('div', { className: 'bt-market-empty' }, t('No templates found. Try a different search.'))
      : h('div', { className: 'bt-market-grid' },
          Object.keys(grouped).sort().map(cat =>
            h('div', { key: cat, className: 'bt-market-section' },
              h('div', { className: 'bt-market-section-title' }, cat),
              h('div', { className: 'bt-market-section-items' },
                grouped[cat].map(tmpl =>
                  h(MarketCard, { key: tmpl.id, tmpl, onInstall, busy: installing === tmpl.id }))))))
  )
}
