// Settings → Remote nodes: how many tasks each online remote node runs at once.
// The main pushes the value to the node, which applies it to its running task
// engine; the node answers with what it actually applied. A node too old to know
// the frame never answers, and the row says so instead of showing the saved value
// as if it had taken effect.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

const MIN = 1
const MAX = 64

function stateText(node) {
  if (node.status === 'applied') return t('Applied: {count} at a time', { count: node.appliedMaxConcurrent ?? node.maxConcurrent ?? '' })
  if (node.status === 'pending') return t('Sent, waiting for the node to confirm…')
  if (node.status === 'unsupported') return t('This node\'s version does not support a custom limit. It keeps running {count} at a time.', { count: node.legacyConcurrency ?? 4 })
  if (node.status === 'refused' || node.status === 'error') return node.lastError ?? t('The node refused the change.')
  return t('Not set. The node runs its own default of {count} at a time.', { count: node.defaultConcurrency ?? 8 })
}

function queueText(node) {
  const queue = node.queue
  if (!queue || typeof queue !== 'object') return t('The node does not report its queue yet.')
  const running = Number(queue.running ?? 0)
  const limit = Number(queue.maxConcurrent ?? 0)
  const queued = Number(queue.queued ?? 0)
  const text = t('{running} running of {limit}, {queued} queued', { running, limit, queued })
  return queue.starved === true ? h('span', { className: 'bt-note bt-danger' }, t('{text} — the queue looks stuck', { text })) : text
}

function NodeRow({ node, save }) {
  const [value, setValue] = useState(String(node.maxConcurrent ?? node.defaultConcurrency ?? 8))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setValue(String(node.maxConcurrent ?? node.defaultConcurrency ?? 8)) }, [node.maxConcurrent, node.defaultConcurrency])
  const submit = () => {
    const number = Number(value)
    if (!Number.isInteger(number) || number < MIN || number > MAX) { setError(t('Enter a whole number from 1 to 64.')); return }
    setError('')
    setBusy(true)
    Promise.resolve(save(node.nodeId, number)).catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  return h('div', { className: 'bt-set-row bt-node-row', 'data-node': node.nodeId },
    h('div', { className: 'bt-set-copy' },
      h('span', null, node.hostname ?? node.nodeId),
      h('span', { className: 'bt-set-hint' }, `${node.nodeId} · ${queueText(node)}`),
      h('span', { className: 'bt-set-hint', 'data-status': node.status ?? 'unknown' }, stateText(node))),
    h('div', { className: 'bt-set-control bt-node-limit' },
      h('input', {
        className: 'bt-input bt-set-number', type: 'number', min: MIN, max: MAX, step: 1,
        'aria-label': t('Tasks at once on {node}', { node: node.hostname ?? node.nodeId }),
        value, disabled: busy, onChange: event => setValue(event.target.value),
        onKeyDown: event => { if (event.key === 'Enter') event.currentTarget.blur() },
      }),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy, onClick: submit }, busy ? t('Saving…') : t('Save')),
      error !== '' ? h('span', { className: 'bt-note bt-danger', role: 'alert' }, error) : null))
}

export function NodeConfigPage({ Section }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const load = useCallback(() => call('node-config').then(setData, failure => setError(failure?.message ?? String(failure))), [])
  useEffect(() => { void load() }, [load])
  const save = useCallback((nodeId, maxConcurrent) => call('node-config', { nodeId, maxConcurrent }).then((row) => {
    setData(previous => previous === null ? previous : {
      ...previous,
      nodes: previous.nodes.map(node => node.nodeId === nodeId ? { ...node, ...row } : node),
    })
  }), [])
  if (error !== '') return h(Section, { title: t('Remote nodes') }, h('div', { className: 'bt-note bt-danger', role: 'alert' }, error))
  if (data === null) return h(Section, { title: t('Remote nodes') }, h('div', { className: 'bt-set-hint' }, t('Loading…')))
  return h(Section, { title: t('Remote nodes') },
    h('div', { className: 'bt-set-hint' }, t('How many tasks each online node runs at once. The node applies a change immediately, without a restart.')),
    data.nodes.length === 0
      ? h('div', { className: 'bt-set-hint' }, t('No remote node is online right now.'))
      : data.nodes.map(node => h(NodeRow, { key: node.nodeId, node: { ...data, ...node, defaultConcurrency: data.defaultConcurrency, legacyConcurrency: data.legacyConcurrency }, save })))
}
