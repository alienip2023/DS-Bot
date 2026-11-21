import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { PlusIcon, CloseIcon } from './icons.js'

const APP_TYPES = ['github', 'jira', 'slack', 'linear', 'http', 'custom']
const blankForm = () => ({ name: '', type: 'custom', label: '', notes: '' })

export function BotConnectPage({ actions }) {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState(blankForm())
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    Promise.resolve(actions.listConnectedApps?.())
      .then(result => { setApps(result?.apps ?? []); setLoading(false) })
      .catch(err => { setError(err?.message ?? String(err)); setLoading(false) })
  }, [])

  const setField = (key, value) => setForm(f => ({ ...f, [key]: value }))

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      const result = await Promise.resolve(actions.registerConnectedApp(form))
      setApps(prev => [...prev, result?.app ?? { ...form, id: Date.now().toString(36) }])
      setForm(blankForm())
      setShowForm(false)
      setNote(t('App registered.'))
    } catch (err) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const unregister = async (id) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      await Promise.resolve(actions.unregisterConnectedApp(id))
      setApps(prev => prev.filter(a => a.id !== id))
      setNote(t('App removed.'))
    } catch (err) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  return h('section', { className: 'bt-set-section' },
    h('div', { className: 'bt-la-sec-head' },
      h('h3', null, t('Connected Apps')),
      showForm ? null : h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon',
        onClick: () => { setShowForm(true); setError(''); setNote('') },
      }, h(PlusIcon), t('Register App'))),
    note ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, note)) : null,
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    showForm ? h('form', {
      className: 'bt-set-card bt-task-form',
      onSubmit: event => { event.preventDefault(); void save() },
    },
      h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Name'))),
        h('input', {
          className: 'bt-input', value: form.name, maxLength: 64,
          placeholder: 'my-github-app', spellCheck: false, autoFocus: true,
          onChange: e => setField('name', e.target.value),
        })),
      h('label', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Type'))),
        h('select', {
          className: 'bt-select bt-task-bot', value: form.type,
          onChange: e => setField('type', e.target.value),
        }, APP_TYPES.map(type => h('option', { key: type, value: type }, type)))),
      h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Label'))),
        h('input', {
          className: 'bt-input', value: form.label,
          placeholder: t('Display label (optional)'), spellCheck: false,
          onChange: e => setField('label', e.target.value),
        })),
      h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Notes'))),
        h('textarea', {
          className: 'bt-input bt-input-area', value: form.notes,
          placeholder: t('Notes (optional)'), spellCheck: false,
          onChange: e => setField('notes', e.target.value),
        })),
      h('div', { className: 'bt-set-row bt-task-foot' },
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
          onClick: () => { setShowForm(false); setForm(blankForm()); setError('') },
        }, t('Cancel')),
        h('button', {
          type: 'submit', className: 'bt-send bt-soft-sm',
          disabled: busy || !form.name.trim(),
        }, busy ? t('Saving…') : t('Save')))) : null,
    h('div', { className: 'bt-set-card bt-connectors-card' },
      loading
        ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('Loading…')))
        : apps.length === 0
          ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No connected apps registered.')))
          : apps.map(app => h('div', { key: app.id, className: 'bt-connector' },
              h('div', { className: 'bt-connector-head' },
                h('span', { className: 'bt-connector-text' },
                  h('span', { className: 'bt-connector-title' },
                    h('span', { className: 'bt-connector-name' }, app.name),
                    h('span', { className: 'bt-tag' }, app.type)),
                  app.label ? h('span', { className: 'bt-connector-status' }, app.label) : null),
                h('span', { className: 'bt-connector-actions' },
                  h('button', {
                    type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
                    onClick: () => void unregister(app.id),
                  }, t('Remove'))))))))
}
