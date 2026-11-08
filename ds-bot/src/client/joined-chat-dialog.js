import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { useEscape } from './overlay-hooks.js'
import { CloseIcon } from './icons.js'
import { t } from './i18n.js'
import { classifyItem, sendJoined } from './joined-chat-actions.js'

const POLL_MS = 2500

function ChatItem({ item }) {
  const kind = classifyItem(item)
  if (kind === 'skip') return null
  if (kind === 'divider') return h('div', { className: 'jcd-divider' }, item.label ?? '')
  if (kind === 'event') return h('div', { className: 'jcd-event' }, item.text ?? item.label ?? '')
  return h('div', { className: kind === 'mine' ? 'jcd-bubble jcd-mine' : 'jcd-bubble jcd-theirs' },
    h('div', { className: 'jcd-bubble-text' }, item.text ?? ''))
}

export function JoinedChatDialog({ botId, roster, actions, leaving }) {
  const bot = roster.byId?.[botId]
  const botName = bot?.name ?? botId
  const [items, setItems] = useState(null)
  const [offline, setOffline] = useState(false)
  const [sendError, setSendError] = useState(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef(null)
  const stopRef = useRef(false)

  useEscape(() => actions.closeJoinedChat())

  const load = async () => {
    if (stopRef.current) return
    try {
      const result = await actions.joinedChatView(botId)
      if (stopRef.current) return
      if (result?.ok === false) { setOffline(true); return }
      setOffline(false)
      if (Array.isArray(result?.value?.items)) setItems(result.value.items)
      else if (Array.isArray(result?.items)) setItems(result.items)
      else if (result?.value != null) setItems([])
    } catch {
      if (stopRef.current) return
      setOffline(true)
    }
  }

  useEffect(() => {
    stopRef.current = false
    load()
    const poll = setInterval(() => { if (!document.hidden) load() }, POLL_MS)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { stopRef.current = true; clearInterval(poll); document.removeEventListener('visibilitychange', onVisible) }
  }, [botId])

  useEffect(() => { if (items) endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [items?.length])

  const doSend = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    setSendError(null)
    try {
      // botId is the joined shadow id; sendJoined sets sessionId = botId
      const r = await sendJoined(actions._call ?? ((n, b) => actions.joinedChatView.__call?.(n, b)), botId, text.trim())
      // Fall back: actions.sendJoined wires to the same underlying call fn
      const result = r ?? await actions.sendJoined(botId, text.trim())
      if (result?.ok === false) throw new Error(result.error?.message ?? result.error ?? t('Failed to send'))
      setText('')
      await load()
    } catch (e) {
      setSendError(e?.message ?? t('Failed to send'))
    } finally {
      setSending(false)
    }
  }

  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() } }

  return h('div', { className: 'jcd-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'jcd-scrim', onClick: () => actions.closeJoinedChat() }),
    h('div', { className: 'jcd-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Chat with {name}', { name: botName }) },
      h('div', { className: 'jcd-head' },
        h('h2', null, t('Chat with {name}', { name: botName })),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: () => actions.closeJoinedChat() }, h(CloseIcon))),
      h('div', { className: 'jcd-body' },
        offline
          ? h('div', { className: 'jcd-offline' },
              h('p', null, t('Node is offline or unreachable')),
              h('button', { type: 'button', className: 'bt-btn', onClick: load }, t('Retry')))
          : items === null
            ? h('div', { className: 'jcd-loading' }, t('Loading…'))
            : h('div', { className: 'jcd-messages' },
                items.length === 0 ? h('div', { className: 'jcd-empty' }, t('No messages yet')) : null,
                items.map((item, i) => h(ChatItem, { key: i, item })),
                h('div', { ref: endRef }))),
      h('div', { className: 'jcd-foot' },
        sendError ? h('div', { className: 'jcd-error', role: 'alert' }, sendError) : null,
        h('textarea', {
          className: 'jcd-input',
          value: text,
          disabled: sending || offline,
          placeholder: t('Message…'),
          rows: 2,
          onKeyDown: onKey,
          onChange: (e) => setText(e.target.value),
        }),
        h('button', {
          type: 'button',
          className: 'bt-btn jcd-send',
          disabled: !text.trim() || sending || offline,
          onClick: doSend,
        }, sending ? t('Sending…') : t('Send')))))
}
