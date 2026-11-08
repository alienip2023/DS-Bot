import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { useEscape } from './overlay-hooks.js'
import { CloseIcon } from './icons.js'
import { t } from './i18n.js'

const POLL_MS = 2500

// Map a chat item to a bubble/row element.
function ChatItem({ item }) {
  if (item.kind === 'divider') {
    return h('div', { className: 'jcd-divider' }, item.label ?? '')
  }
  if (item.kind === 'event') {
    if (!item.text && !item.label) return null
    return h('div', { className: 'jcd-event' }, item.text ?? item.label ?? '')
  }
  const isMine = item.kind === 'user'
  return h('div', { className: isMine ? 'jcd-bubble jcd-mine' : 'jcd-bubble jcd-theirs' },
    h('div', { className: 'jcd-bubble-text' }, item.text ?? ''))
}

export function JoinedChatDialog({ botId, roster, actions, leaving }) {
  const bot = roster.byId?.[botId]
  const botName = bot?.name ?? botId
  const [items, setItems] = useState(null)
  const [sessionId, setSessionId] = useState(null)
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
      if (result?.sessionId) setSessionId(result.sessionId)
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
    const poll = setInterval(() => {
      if (document.hidden) return
      load()
    }, POLL_MS)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopRef.current = true
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [botId])

  useEffect(() => {
    if (items) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items?.length])

  const sendMessage = async () => {
    if (!text.trim() || sending) return
    const sid = bot?.worker?.remoteBotId ?? sessionId ?? botId
    setSending(true)
    setSendError(null)
    try {
      const r = await actions.sendJoined(sid, text.trim())
      if (r?.ok === false) throw new Error(r.error ?? 'send failed')
      setText('')
      await load()
    } catch (e) {
      setSendError(e?.message ?? t('Failed to send'))
    } finally {
      setSending(false)
    }
  }

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  return h('div', { className: 'jcd-backdrop', 'data-leaving': leaving || undefined, onClick: (e) => { if (e.target === e.currentTarget) actions.closeJoinedChat() } },
    h('div', { className: 'jcd-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Chat with {name}', { name: botName }) },
      h('div', { className: 'jcd-header' },
        h('span', { className: 'jcd-title' }, t('Chat with {name}', { name: botName })),
        h('button', { type: 'button', className: 'jcd-close', 'aria-label': t('Close'), onClick: () => actions.closeJoinedChat() },
          h(CloseIcon))),
      h('div', { className: 'jcd-body' },
        offline
          ? h('div', { className: 'jcd-offline' },
              h('p', null, t('Node is offline or unreachable.')),
              h('button', { type: 'button', className: 'jcd-retry', onClick: load }, t('Retry')))
          : items === null
            ? h('div', { className: 'jcd-loading' }, t('Loading…'))
            : h('div', { className: 'jcd-messages' },
                items.length === 0 ? h('div', { className: 'jcd-empty' }, t('No messages yet.')) : null,
                items.map((item, i) => h(ChatItem, { key: i, item })),
                h('div', { ref: endRef }))),
      h('div', { className: 'jcd-footer' },
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
          className: 'jcd-send',
          disabled: !text.trim() || sending || offline,
          onClick: sendMessage,
        }, sending ? t('Sending…') : t('Send')))))
}
