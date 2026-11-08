// bot-store.js — BotRecord schema + bySessionId reverse index for mirror session
// Pure data layer; no cordis, no IO.

/**
 * @typedef {{
 *   id: string,
 *   kind: 'local' | 'joined',
 *   sessionId: string | null,
 *   worker?: {nodeId: string, remoteBotId: string, hostname: string, home: string, online: boolean, lastSeen: number | null},
 *   model?: string | null,
 *   parts?: string[],
 * }} BotRecord
 */

/**
 * Extract a BotRecord from a raw state.bots[id] entry.
 * @param {object} raw
 * @returns {BotRecord}
 */
export function toBotRecord(raw) {
  return {
    id: raw.id,
    kind: raw.origin === 'joined' ? 'joined' : 'local',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    worker: raw.worker ?? undefined,
    model: raw.model ?? null,
    parts: Array.isArray(raw.segments) ? raw.segments.map(s => s?.id ?? s) : [],
  }
}

/**
 * Build a Map<sessionId, botId> from an iterable of BotRecord / raw bot entries.
 * Only entries with a non-empty sessionId are indexed.
 * @param {Iterable<{id: string, sessionId: string | null}>} bots
 * @returns {Map<string, string>}
 */
export function buildBySessionId(bots) {
  const m = new Map()
  for (const bot of bots) {
    if (typeof bot.sessionId === 'string' && bot.sessionId !== '') {
      m.set(bot.sessionId, bot.id)
    }
  }
  return m
}

/**
 * Update the bySessionId index after a bot's sessionId changes.
 * @param {Map<string, string>} index
 * @param {string} botId
 * @param {string | null} oldSessionId
 * @param {string | null} newSessionId
 */
export function updateBySessionId(index, botId, oldSessionId, newSessionId) {
  if (typeof oldSessionId === 'string' && oldSessionId !== '') {
    if (index.get(oldSessionId) === botId) index.delete(oldSessionId)
  }
  if (typeof newSessionId === 'string' && newSessionId !== '') {
    index.set(newSessionId, botId)
  }
}
