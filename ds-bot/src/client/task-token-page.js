import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { PlusIcon } from './icons.js'
import { KeyIcon } from './secret-card.js'

const PREFIX = 'task-token:'
const blankForm = () => ({ name: '', value: '' })

export function TaskTokenPage({ actions }) {
  const [secrets, setSecrets] = useState([])
  const [form, setForm] = useState(blankForm())
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    Promise.resolve(actions.listSecrets?.())
      .then(result => {
        const all = result?.secrets ?? []
        setSecrets(all.filter(s => s.name && s.name.startsWith(PREFIX)))
      })
      .catch(err => setError(err?.message ?? String(err)))
  }, [])

  const setField = (key, value) => setForm(f => ({ ...f, [key]: value }))

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      const key = PREFIX + form.name.trim()
      await Promise.resolve(actions.setSecret(key, form.value))
      setSecrets(prev => {
        const next = prev.filter(s => s.name !== key)
        return [...next, { name: key }]
      })
      setForm(blankForm())
      setShowForm(false)
      setNote(t('Credential saved.'))
    } catch (err) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      await Promise.resolve(actions.deleteSecret(name))
      setSecrets(prev => prev.filter(s => s.name !== name))
      setNote(t('Credential deleted.'))
    } catch (err) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  const displayName = name => name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name

  return h('section', { className: 'bt-set-section' },
    h('div', { className: 'bt-la-sec-head' },
      h('h3', null, t('Credentials')),
      showForm ? null : h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon',
        onClick: () => { setShowForm(true); setError(''); setNote('') },
      }, h(PlusIcon), t('Add Credential'))),
    h('div', { className: 'bt-set-card' },
      h('div', { className: 'bt-set-row' },
        h('span', { className: 'bt-set-hint' },
          t('API keys stored here are never shown to Bots — they receive a temporary tt_* token instead.')))),
    note ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, note)) : null,
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    showForm ? h('form', {
      className: 'bt-set-card bt-task-form',
      onSubmit: event => { event.preventDefault(); void save() },
    },
      h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-bs-label' }, t('Name')),
          h('span', { className: 'bt-set-hint' }, t('service/field format, e.g. github/token'))),
        h('input', {
          className: 'bt-input', value: form.name, maxLength: 128,
          placeholder: 'github/token', spellCheck: false, autoFocus: true,
          onChange: e => setField('name', e.target.value),
        })),
      h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Value'))),
        h('input', {
          className: 'bt-input', type: 'password', value: form.value,
          placeholder: t('Paste the secret value'),
          autoComplete: 'new-password', autoCorrect: 'off', autoCapitalize: 'off',
          spellCheck: false, 'data-1p-ignore': '', 'data-lpignore': 'true',
          onChange: e => setField('value', e.target.value),
        })),
      h('div', { className: 'bt-set-row bt-task-foot' },
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
          onClick: () => { setShowForm(false); setForm(blankForm()); setError('') },
        }, t('Cancel')),
        h('button', {
          type: 'submit', className: 'bt-send bt-soft-sm',
          disabled: busy || !form.name.trim() || !form.value,
        }, busy ? t('Saving…') : t('Save')))) : null,
    h('div', { className: 'bt-set-card bt-connectors-card' },
      secrets.length === 0
        ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No credentials saved.')))
        : secrets.map(secret => h('div', { key: secret.name, className: 'bt-connector' },
            h('div', { className: 'bt-connector-head' },
              h('span', { className: 'bt-connector-text' },
                h('span', { className: 'bt-connector-title' },
                  h(KeyIcon),
                  h('span', { className: 'bt-connector-name' }, displayName(secret.name)))),
              h('span', { className: 'bt-connector-actions' },
                h('button', {
                  type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
                  onClick: () => void remove(secret.name),
                }, t('Delete'))))))))
}
