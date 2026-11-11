// bot-store.js — BotRecord schema + bySessionId reverse index for mirror session
// Pure data layer; no cordis, no IO.

import { MAIN_THREAD_ID, MAIN_THREAD_TITLE } from './constants.js'

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

/**
 * @typedef {{
 *   id: string, botId: string, title: string, createdAt: number, updatedAt: number,
 *   archived: boolean, model: string | null, effort: string | null, workDir: string | null,
 *   sessionId: string | null, parentThreadId: string | null, parentTurn: number | null,
 *   lastSeq: number, unread: number, running: boolean, queued: number,
 * }} ThreadRecord
 */

/**
 * Id of a Bot's default Main thread. Derived from the Bot id, so the v1 → v2 migration
 * finds an already saved Main thread again instead of creating a second one.
 * @param {string} botId
 * @returns {string}
 */
export function mainThreadId(botId) {
  return `${botId}:${MAIN_THREAD_ID}`
}

/**
 * The saved Thread row `threadId`, or undefined.
 * @param {object} state
 * @param {string | undefined} threadId
 * @returns {ThreadRecord | undefined}
 */
export function threadOf(state, threadId) {
  if (typeof threadId !== 'string' || threadId === '') return undefined
  return state?.threads != null && Object.hasOwn(state.threads, threadId) ? state.threads[threadId] : undefined
}

/**
 * Every Thread row of a Bot, in `bot.threadIds` order. A Bot saved before `threadIds`
 * existed (or one whose list lost an entry) falls back to scanning the Thread table.
 * @param {object} state
 * @param {string} botId
 * @returns {ThreadRecord[]}
 */
export function threadsOfBot(state, botId) {
  const bot = state?.bots != null && Object.hasOwn(state.bots, botId) ? state.bots[botId] : undefined
  const ids = Array.isArray(bot?.threadIds) ? bot.threadIds : []
  const rows = ids.map(id => threadOf(state, id)).filter(row => row !== undefined)
  if (rows.length > 0) return rows
  return Object.values(state?.threads ?? {}).filter(row => row?.botId === botId)
}

/**
 * The Bot's Main thread: the conversation its next turn starts in when no thread is named.
 * @param {object} state
 * @param {string} botId
 * @returns {ThreadRecord | undefined}
 */
export function mainThreadOf(state, botId) {
  return threadOf(state, mainThreadId(botId)) ?? threadsOfBot(state, botId).find(row => row.title === MAIN_THREAD_TITLE)
}

/**
 * Write one Thread row (insert or replace) into the saved team. The caller owns
 * `bot.threadIds`; like the read helpers, this touches only the Thread table.
 * @param {object} state
 * @param {ThreadRecord} thread
 * @returns {ThreadRecord | undefined}
 */
export function saveThread(state, thread) {
  if (thread === null || typeof thread !== 'object' || typeof thread.id !== 'string' || thread.id === '') return undefined
  if (state.threads === null || typeof state.threads !== 'object' || Array.isArray(state.threads)) state.threads = {}
  state.threads[thread.id] = thread
  return thread
}

/**
 * The Main Thread row the v1 → v2 migration gives a Bot. Field set per
 * docs/thread-model.md §1.1; only `sessionId` comes from the Bot.
 * @param {object} bot
 * @param {number} now
 * @returns {ThreadRecord}
 */
export function newMainThread(bot, now = Date.now()) {
  const sessionId = typeof bot?.sessionId === 'string' && bot.sessionId !== '' ? bot.sessionId : null
  return {
    id: mainThreadId(bot.id),
    botId: bot.id,
    title: MAIN_THREAD_TITLE,
    createdAt: typeof bot?.createdAt === 'number' ? bot.createdAt : now,
    updatedAt: now,
    archived: false,
    model: null,
    effort: null,
    workDir: null,
    sessionId,
    parentThreadId: null,
    parentTurn: null,
    lastSeq: 0,
    unread: 0,
    running: false,
    queued: 0,
  }
}

/**
 * Give a Bot its Main thread, once. Called wherever a Bot row is written without going
 * through createBot (a joined shadow's first upsert, a roster report) so the Thread table
 * never lags behind the Bot. Idempotent: a second call finds the saved row and only
 * restores a missing `threadIds` entry or a Session the Bot moved to.
 * @param {object} state
 * @param {object} bot   raw state.bots[id] row
 * @param {number} [now]
 * @returns {ThreadRecord | undefined}
 */
export function ensureMainThread(state, bot, now = Date.now()) {
  if (bot === null || typeof bot !== 'object' || typeof bot.id !== 'string' || bot.id === '') return undefined
  if (state.threads === null || typeof state.threads !== 'object') state.threads = {}
  const id = mainThreadId(bot.id)
  const sessionId = typeof bot.sessionId === 'string' && bot.sessionId !== '' ? bot.sessionId : null
  let thread = threadOf(state, id)
  if (thread === undefined) {
    thread = newMainThread(bot, now)
    saveThread(state, thread)
  } else if (thread.sessionId !== sessionId) {
    // A mirror Session re-keyed or a fresh part made: the Main row follows the Bot.
    thread.sessionId = sessionId
    thread.updatedAt = now
  }
  if (!Array.isArray(bot.threadIds)) bot.threadIds = [id]
  else if (!bot.threadIds.includes(id)) bot.threadIds = [id, ...bot.threadIds]
  return thread
}

/**
 * Keep the full session index ({botId, threadId}) in step when a Bot's current Session
 * is replaced: the old id leaves the index, the new one points at the same thread.
 * @param {Map<string, {botId: string, threadId: string}>} index
 * @param {string} botId
 * @param {string | null} oldSessionId
 * @param {string | null} newSessionId
 * @param {string} threadId
 */
export function updateBySessionIdFull(index, botId, oldSessionId, newSessionId, threadId) {
  if (typeof oldSessionId === 'string' && oldSessionId !== '') {
    if (index.get(oldSessionId)?.botId === botId) index.delete(oldSessionId)
  }
  if (typeof newSessionId === 'string' && newSessionId !== '' && typeof threadId === 'string' && threadId !== '') {
    index.set(newSessionId, { botId, threadId })
  }
}

/**
 * Which Bot and Thread a Session belongs to, for the serial gate. A local Bot's current
 * chat Session is not in the full index until its Main row carries it, so the Bot's own
 * chat is resolved through `chatOf`/Main row.
 * @param {object} rt
 * @param {string} sessionId
 * @returns {{botId: string, threadId: string} | undefined}
 */
export function ownerOfSession(rt, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const full = rt.bySessionIdFull?.(sessionId)
  if (full !== undefined) return full
  const bot = rt.botOf?.(sessionId)
  if (bot === undefined) return undefined
  return { botId: bot.id, threadId: rt.mainThreadOf?.(bot.id)?.id ?? mainThreadId(bot.id) }
}
