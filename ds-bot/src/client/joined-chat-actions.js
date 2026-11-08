// Pure helpers for the joined-chat overlay — no React, importable in Node tests.

/**
 * Set ui.joinedChat to open the overlay for a joined bot.
 * @param {object} ui
 * @param {string} botId  — the joined shadow id (e.g. "joined:dshtest-1:session-…")
 */
export function openJoinedChat(ui, botId) {
  if (!botId) return
  ui.set(state => ({ ...state, joinedChat: botId, menu: null, palette: null }))
}

/**
 * Classify one chat item for rendering.
 * @param {object} item
 * @returns {'mine'|'theirs'|'event'|'divider'|'skip'}
 */
export function classifyItem(item) {
  if (item.kind === 'divider') return 'divider'
  if (item.kind === 'event') {
    if (!item.text && !item.label) return 'skip'
    return 'event'
  }
  return item.kind === 'user' ? 'mine' : 'theirs'
}

/**
 * Send a message to a joined bot's remote session.
 * sessionId MUST be the joined shadow id (botId) — the main-side wrapSendUser
 * only recognises joined:<nodeId>:<remoteBotId>, not the bare remote session id.
 * @param {function} call  — the host call transport
 * @param {string} botId   — joined shadow id, used directly as sessionId
 * @param {string} text
 */
export function sendJoined(call, botId, text) {
  return call('send', { sessionId: botId, text })
}
