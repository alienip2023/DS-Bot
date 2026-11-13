// The three-layer memory panel of a hub: the team, every machine the hub has heard
// from, and each machine's Bots. It only talks to the hub endpoints (memory-hub-*),
// so a remote scope has no summary and no model call behind it. The Bot's own memory
// dialog (`memory-panel.js`) stays exactly as it was.
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEscape } from './overlay-hooks.js'
import { ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, MemoryIcon, TrashIcon } from './icons.js'
import { dateLocale, hostText, t } from './i18n.js'
import { hubBotCount, hubBots, hubEntryTotal, hubFindBot, hubMachines, hubNodeEntries, hubPlaceKey, hubPlaceScope, hubTeamEntries } from './memory-hub-model.js'

const countText = count => (count === 0 ? t('Nothing saved yet') : count === 1 ? t('1 entry') : t('{count} entries', { count }))

function whenText(at, now) {
  if (!Number.isFinite(at) || at <= 0) return null
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return t('just now')
  const format = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return format.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return format.format(-hours, 'hour')
  return format.format(-Math.round(hours / 24), 'day')
}

function useNow(every) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(id)
  }, [every])
  return now
}

// The details pane's row: it opens the hub's panel. Only a hub that has federated
// memory installed draws it (the caller checks `roster.federation.hub`).
export function MemoryHubRow({ actions }) {
  return h('div', null,
    h('div', { className: 'bt-section-title' }, t('Federated memory')),
    h('button', { type: 'button', className: 'bt-mem-row', 'aria-label': t('Team, machines, and their Bots'), onClick: () => actions.openMemoryHub?.() },
      h(MemoryIcon),
      h('span', { className: 'bt-mem-row-copy' }, t('Team, machines, and their Bots')),
      h('span', { className: 'bt-mem-row-go' }, t('Manage'), h(ChevronRightIcon))))
}

function MachineSection({ node, now, open }) {
  const when = whenText(node.lastSeen, now)
  const meta = [node.online ? t('Online') : t('Offline'), node.nodeId].filter(Boolean).join(' · ')
  const bots = hubBots(node)
  return h('section', { className: 'bt-mem-section' },
    h('button', { type: 'button', className: 'bt-mem-row', onClick: () => open({ kind: 'node', nodeId: node.nodeId }) },
      h(MemoryIcon),
      h('span', { className: 'bt-mem-row-copy' },
        h('span', { className: 'bt-mem-row-title' }, node.hostname ?? node.nodeId),
        h('span', { className: 'bt-mem-row-sub' }, meta)),
      h('span', { className: 'bt-mem-row-go' }, countText(hubNodeEntries(node)), h(ChevronRightIcon))),
    h('div', { className: 'bt-mem-hub-meta' },
      h('span', null, t('Applied {last} · sent {sent}', { last: Number(node.lastSeq ?? 0), sent: Number(node.sentSeq ?? 0) })),
      when === null ? null : h('span', null, t('last seen {time}', { time: when }))),
    bots.length === 0
      ? h('div', { className: 'bt-mem-none' }, t('No Bots from this machine yet'))
      : h('ul', { className: 'bt-mem-list' }, bots.map(bot => h('li', { key: bot.remoteBotId, className: 'bt-mem-entry' },
          h('button', {
            type: 'button', className: 'bt-mem-hub-bot',
            onClick: () => open({ kind: 'bot', nodeId: node.nodeId, remoteBotId: bot.remoteBotId }),
          },
            h('span', { className: 'bt-mem-entry-text' }, bot.name ?? bot.remoteBotId),
            h('span', { className: 'bt-mem-entry-meta' }, bot.remoteBotId)),
          h('span', { className: 'bt-mem-size' }, countText(Number(bot.entries ?? 0)))))))
}

function EntryList({ view, remove }) {
  if (view === null) return h('div', { className: 'bt-mem-skel', 'aria-busy': true })
  if (view.entries.length === 0) return h('div', { className: 'bt-mem-none' }, t('Nothing saved yet'))
  return h('div', { className: 'bt-mem-entries' },
    h('ul', { className: 'bt-mem-list' }, view.entries.map(entry => h('li', { key: entry.id ?? `${entry.topic ?? ''}:${entry.text}`, className: 'bt-mem-entry' },
      h('div', { className: 'bt-mem-entry-copy' },
        entry.topic ? h('span', { className: 'bt-mem-entry-topic' }, entry.topic) : null,
        h('span', { className: 'bt-mem-entry-text' }, entry.text),
        h('span', { className: 'bt-mem-entry-meta' }, [entry.added, entry.by ? t('by {name}', { name: entry.by }) : null].filter(Boolean).join(' · '))),
      h('button', {
        type: 'button', className: 'bt-mem-remove', 'aria-label': t('Remove from memory'), title: t('Remove from memory'),
        onClick: () => void remove(entry),
      }, h(TrashIcon))))))
}

function placeName(place, scopes) {
  if (place === null || place.kind === 'team') return t('Team memory')
  if (place.kind === 'node') {
    const node = hubMachines(scopes).find(machine => machine.nodeId === place.nodeId)
    return node?.hostname ?? place.nodeId
  }
  const bot = hubFindBot(scopes, place.nodeId, place.remoteBotId)
  return bot?.name ?? place.remoteBotId
}

// The dialog: the place list, or the entries of one place with an add field. Every
// write answers with the view of that place, so the list updates at once.
export function MemoryHubDialog({ actions, leaving = false }) {
  const [scopes, setScopes] = useState(null)
  const [team, setTeam] = useState(null)
  const [place, setPlace] = useState(null)
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  const now = useNow(30_000)
  const close = useCallback(() => actions.closeMemoryHub?.(), [actions])
  useEscape(close)

  const load = useCallback(async () => {
    try {
      const next = await actions.memoryHubScopes()
      setScopes(next)
      setTeam(await actions.memoryHubView({ kind: 'team' }))
      setError('')
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }, [actions])

  useEffect(() => { void load() }, [load])

  const open = async (next) => {
    setPlace(next)
    setView(null)
    setText('')
    try {
      setView(await actions.memoryHubView(hubPlaceScope(next)))
      setError('')
      inputRef.current?.focus()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }

  const back = () => {
    setPlace(null)
    setView(null)
    setText('')
    void load()
  }

  const add = async (event) => {
    event.preventDefault()
    const value = text.trim()
    if (value === '' || busy) return
    setBusy(true)
    try {
      setView(await actions.memoryHubAdd(hubPlaceScope(place), value))
      setText('')
      await load()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const remove = async (entry) => {
    try {
      setView(await actions.memoryHubForget(hubPlaceScope(place), entry.text))
      await load()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }

  const label = placeName(place, scopes)
  const depth = place === null || place.kind === 'team' ? 0 : place.kind === 'node' ? 1 : 2
  return h('div', { className: 'bt-mem-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim bt-mem-scrim', onMouseDown: close }),
    h('div', { className: 'bt-mem', role: 'dialog', 'aria-modal': true, 'aria-label': t('Federated memory') },
      h('div', { className: 'bt-mem-head' },
        place === null ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to the machines'), onClick: back }, h(ChevronLeftIcon)),
        h('h2', null, place === null ? t('Federated memory') : label),
        h('span', { className: 'bt-mem-status' }, place === null ? '' : countText(view?.entries.length ?? 0)),
        h('span', { className: 'bt-mem-head-gap' }),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close memory'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-mem-body' },
        error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, hostText(error)) : null,
        place === null
          ? h(Fragment, null,
              h('section', { className: 'bt-mem-section' },
                h('button', { type: 'button', className: 'bt-mem-row', onClick: () => open({ kind: 'team' }) },
                  h(MemoryIcon),
                  h('span', { className: 'bt-mem-row-copy' }, t('Team memory')),
                  h('span', { className: 'bt-mem-row-go' }, countText(hubTeamEntries(scopes)), h(ChevronRightIcon))),
                team === null ? null : h('div', { className: 'bt-mem-hub-meta' },
                  h('span', null, t('{used} of {limit} characters', {
                    used: Number(team.sizes?.team ?? 0).toLocaleString(dateLocale()),
                    limit: Number(team.limits?.team ?? 0).toLocaleString(dateLocale()),
                  })))),
              h('div', { className: 'bt-section-title', style: { marginTop: 14 } }, t('Machines')),
              scopes === null
                ? h('div', { className: 'bt-mem-skel', 'aria-busy': true })
                : hubMachines(scopes).length === 0
                  ? h('div', { className: 'bt-mem-none' }, t('No machines have joined yet'))
                  : hubMachines(scopes).map(node => h(MachineSection, { key: node.nodeId, node, now, open })))
          : h(Fragment, null,
              h('div', { className: 'bt-mem-hub-meta' }, h('span', null, hubPlaceKey(place)), depth === 2 ? h('span', null, t('Its own memory')) : null),
              h(EntryList, { view, remove }))),
      place === null ? null : h('div', { className: 'bt-mem-foot' },
        h('form', { className: 'bt-mem-ask', onSubmit: add },
          h('input', {
            ref: inputRef, className: 'bt-mem-input', value: text, maxLength: 2000, disabled: busy,
            placeholder: t('Add an entry to {scope}', { scope: label }),
            'aria-label': t('Add an entry to {scope}', { scope: label }),
            onChange: event => setText(event.target.value),
          }),
          h('button', { type: 'submit', className: 'bt-mem-send', disabled: busy || text.trim() === '', 'aria-label': t('Send') },
            busy ? h('span', { className: 'bt-mem-spin', 'aria-hidden': true }) : h(ArrowUpIcon))))))
}
