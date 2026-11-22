// W1-2: pure presentation rules for the native approval card. No React, no host access.
// The card only ever reflects structured evidence: it never names an outcome (the client
// view carries open rows only, and the host may still downgrade an allow to `cancelled`).

export const CARD_STATES = Object.freeze(['open', 'sending', 'sent', 'unavailable', 'unbound', 'unverified'])

const filled = value => typeof value === 'string' && value !== ''

// The binding comes from the host's own row only; a row without both strings has none.
export const rowBinding = row => (
  filled(row?.sessionId) && filled(row?.fingerprint)
    ? { sessionId: row.sessionId, fingerprint: row.fingerprint }
    : undefined)

// What a click does. `send` carries everything the single call needs; `block` makes no call
// and names the fixed text to show. `answerable: false` is unavailable; a row that is
// unbound or belongs to another Bot or room is never answered from this card.
export function planAnswer(row, { botId, roomId } = {}, choice) {
  if (choice !== 'allow' && choice !== 'reject') return { kind: 'block', state: 'unbound' }
  if (row?.answerable !== true) return { kind: 'block', state: 'unavailable' }
  // A background-task approval (taskId) may belong to a Bot's own chat, which has no room:
  // it only has to match the Bot, and the room too when the card knows one.
  const task = filled(row.taskId)
  const roomOk = task ? (roomId === undefined || row.roomId === roomId) : (filled(roomId) && row.roomId === roomId)
  if (!filled(row.id) || !filled(botId) || row.botId !== botId || !roomOk) {
    return { kind: 'block', state: 'unbound' }
  }
  const binding = rowBinding(row)
  if (binding === undefined) return { kind: 'block', state: 'unbound' }
  return { kind: 'send', id: row.id, choice, binding }
}

// Only the host's structured stale rejection is "no longer available"; anything else
// (including a network failure) is unconfirmed and may still be pending.
export const stateAfterError = error => (error?.code === 'bot/stale' ? 'unavailable' : 'unverified')
