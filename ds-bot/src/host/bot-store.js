// bot-store.js — BotRecord schema + bySessionId reverse index for mirror session
// Pure data layer; no cordis, no IO.

/**
 * @typedef {{
 *   id: string,
 *   kind: 'local' | 'joined',
 *   origin?: string,
 *   sessionId: string | null,
 *   worker?: {nodeId: string, remoteBotId: string, hostname: string, home: string, online: boolean, lastSeen: number | null},
 *   model?: string | null,
 *   parts?: string[],
 * }} BotRecord
 *
 * Note: `origin` and `worker` are preserved so that joinedShadow(bot) — which checks
 * `bot.origin === 'joined' && bot.worker && bot.worker.home === 'remote'` — works on a BotRecord
 * returned from bySessionId without needing the full raw state entry.
 */

/**
 * Extract a BotRecord from a raw state.bots[id] entry.
 * Preserves `origin` and `worker` so that joinedShadow() returns the correct value.
 * @param {object} raw
 * @returns {BotRecord}
 */
export function toBotRecord(raw) {
  return {
    id: raw.id,
    kind: raw.origin === 'joined' ? 'joined' : 'local',
    origin: raw.origin,          // kept so joinedShadow(record) → true for joined bots
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    worker: raw.worker ?? undefined,  // kept so joinedShadow(record) can check worker.home
    model: raw.model ?? null,
    // segments shape: {sessionId: string, ...} — extract only the sessionId strings
    parts: Array.isArray(raw.segments)
      ? raw.segments.map(s => (typeof s?.sessionId === 'string' ? s.sessionId : (typeof s === 'string' ? s : null))).filter(Boolean)
      : [],
  }
}

/**
 * Build a Map<sessionId, botId> from an iterable of BotRecord / raw bot entries.
 * Indexes both the current sessionId AND all historical segment sessionIds (raw.segments),
 * so that archived segments can still be resolved to their bot.
 * @param {Iterable<object>} bots  - raw state.bots values or BotRecords
 * @returns {Map<string, string>}
 */
export function buildBySessionId(bots) {
  const m = new Map()
  for (const bot of bots) {
    if (typeof bot.sessionId === 'string' && bot.sessionId !== '') {
      m.set(bot.sessionId, bot.id)
    }
    // Also cover historical segment sessionIds (bot.segments or bot.parts)
    const segs = bot.segments ?? bot.parts ?? []
    for (const seg of segs) {
      const sid = typeof seg?.sessionId === 'string' ? seg.sessionId
        : typeof seg === 'string' ? seg : null
      if (sid) m.set(sid, bot.id)
    }
  }
  return m
}

/**
 * Update the bySessionId index after a bot's sessionId changes.
 * Does NOT remove segment entries (those are append-only).
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
