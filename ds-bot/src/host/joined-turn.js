// Step 2: a sidebar or bot-to-bot message to a joined shadow runs in that
// remote Bot's existing session. It does not pick a node, does not start an
// agent task, and does not run a model on this Mac.
import { randomUUID } from 'node:crypto'
import { joinedShadow, shadowId } from './roster-join.js'
import {
  ensureMirrorSession, hasPromptRequest, mirrorStateOf,
} from './mirror.js'
import { beginJoinedMirror, closeJoinedMirror } from './joined-mirror-writer.js'

export const BRIDGE_DOWN_TEXT = '副机仍在执行，桥已断'
// What the sender is told when its exchange was settled by a stop, not by the node going away.
export const STOPPED_TEXT = '已停止'
// How long a turn waits for the node's answer. A node Bot that calls tools takes minutes (the
// first tool call alone can run for over a minute), so the wait covers that; the node's reply
// that still comes after this is not lost (executor.js startPageTurn writes it as a late reply).
export const JOINED_TURN_TIMEOUT_MS = 600_000
// How long after a timeout a late bot/turn-result is still written into the mirror Session.
export const JOINED_LATE_WINDOW_MS = 3_600_000
const MAX_TIMER_MS = 2_147_483_647
// Exchanges still waiting on a node, keyed by nodeId. A stop settles these by the exchange
// itself; the bot/stop-result frame carries no exchangeId, so the association cannot be guessed
// from the requestId. An exchange leaves the moment it settles, so a result or a nodeOffline
// that arrives afterwards finds nothing to deliver to.
const inflightByNode = new Map()

/** `config.joinedTurnTimeoutMs`: whole milliseconds between 1s and the timer limit, else the default. */
export function joinedTimeoutFrom(value) {
  return Number.isInteger(value) && value >= 1000 && value <= MAX_TIMER_MS ? value : JOINED_TURN_TIMEOUT_MS
}
const SKIP_ROLES = new Set(['reply', 'report', 'kickoff', 'continue', 'update'])
const MIRROR_RPC_PREFIX = 'joined:'

// A Bot-to-Bot message is a real exchange on the joined Bot's page too. Open a mirror turn
// before the frame goes out so the page shows the request at once; close it with the answer,
// or with the visible failure line. `duplicate` means this exchange is already on the page
// (a retried delivery): the turn is not opened again. Any mirror failure is a warning only —
// it must never block the dispatch itself.
async function openMirrorTurn(rt, bot, text, xid) {
  try {
    const session = await ensureMirrorSession(rt, bot)
    const rpcId = MIRROR_RPC_PREFIX + xid
    if (hasPromptRequest(session, rpcId)) return { duplicate: true }
    const state = mirrorStateOf(rt, bot.id, session)
    // A page turn may hold this Session: beginJoinedMirror then buffers the exchange until the
    // page turn ends, so the two writers never take turns on the same log (joined-mirror-writer.js).
    return beginJoinedMirror(rt, bot, session, { text, rpcId, state })
  } catch (error) {
    rt.warn?.('ds-bot: a Bot-to-Bot message for %s was not mirrored: %s', bot.id, error?.message ?? error)
    return undefined
  }
}

function closeMirrorTurn(rt, mirror, botId, { text, seq, error, stopped } = {}) {
  if (mirror === undefined) return
  closeJoinedMirror(rt, mirror, { text, seq, error, stopped })
}


export function joinedDispatchRole(role) {
  return !SKIP_ROLES.has(role)
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function listenBotTurnResult(registry, exchangeId, nodeId, timeoutMs) {
  let settled = false
  let received = false   // the node's answer for THIS exchange has arrived (not a cancel/timeout/offline)
  let resolve
  const pending = new Promise((res) => { resolve = res })
  const tracked = inflightByNode.get(nodeId) ?? new Map()
  inflightByNode.set(nodeId, tracked)
  const finish = (value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    registry.off?.('botTurnResult', onResult)
    registry.off?.('nodeOffline', onOffline)
    if (tracked.get(exchangeId) === finish) tracked.delete(exchangeId)
    if (tracked.size === 0) inflightByNode.delete(nodeId)
    resolve(value)
  }
  tracked.set(exchangeId, finish)
  const onResult = (payload) => {
    if (payload?.exchangeId !== exchangeId) return
    if (!settled) received = true
    finish(payload)
  }
  const onOffline = (payload) => {
    if (payload?.nodeId && payload.nodeId !== nodeId) return
    // The node was stopped on purpose. A drop that follows is the stop taking effect, not a
    // bridge that went down while the turn was still running.
    if (stoppedNodes.has(nodeId)) { finish({ ok: false, error: 'stopped', exchangeId }); return }
    finish({ ok: false, error: 'bridge-down', exchangeId })
  }
  const timer = setTimeout(() => finish(undefined), timeoutMs)
  timer.unref?.()
  registry.on?.('botTurnResult', onResult)
  registry.on?.('nodeOffline', onOffline)
  return { pending, cancel: () => finish({ ok: false, error: 'bridge-down', exchangeId }), received: () => received }
}

/**
 * A stop succeeded for this node. Settle every exchange still waiting on it as stopped, by the
 * exchange itself — the stop frame carries no exchangeId, so nothing here is matched by
 * requestId. A result or a nodeOffline for one of these exchanges that arrives afterwards finds
 * the waiter already gone and is dropped. Stopping again, or stopping a node with nothing in
 * flight, settles nothing. Returns how many exchanges were settled.
 */
// A stop settles the exchanges in flight at that moment, but the receipt that tells the Bot why
// is delivered afterwards and opens a new exchange on the same node. A nodeOffline that arrives
// before that receipt is answered is not a bridge that went down: the node was stopped on
// purpose. Remember the node so an exchange opened after the settle is closed as stopped too.
const stoppedNodes = new Set()

export function settleStoppedTurns(registry, nodeId) {
  stoppedNodes.add(nodeId)
  const tracked = inflightByNode.get(nodeId)
  if (!tracked || tracked.size === 0) return 0
  const waiting = [...tracked.values()]
  for (const finish of waiting) finish({ ok: false, error: 'stopped', exchangeId: undefined })
  return waiting.length
}

// The stop control plane: `stop_bot` asks the node to end a running turn (bot/stop), and the
// node answers bot/stop-result. A node that is offline fails the wait at once; a node that is
// simply old never answers, so the caller gets undefined after the timeout.
export function listenBotStopResult(registry, requestId, nodeId, timeoutMs) {
  let settled = false
  let resolve
  const pending = new Promise((res) => { resolve = res })
  const finish = (value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    registry.off?.('botStopResult', onResult)
    registry.off?.('nodeOffline', onOffline)
    resolve(value)
  }
  const onResult = (payload) => {
    if (payload?.requestId !== requestId) return
    finish(payload)
  }
  const onOffline = (payload) => {
    if (payload?.nodeId && payload.nodeId !== nodeId) return
    finish({ ok: false, stopped: false, error: 'bridge-down' })
  }
  const timer = setTimeout(() => finish(undefined), timeoutMs)
  timer.unref?.()
  registry.on?.('botStopResult', onResult)
  registry.on?.('nodeOffline', onOffline)
  return { pending, cancel: () => finish({ ok: false, stopped: false, error: 'bridge-down' }) }
}

// Node side of bot/stop: the node's own ds-bot cancels the turn of the named local Bot.
// `rt.stopChat` covers both a local Agent turn and a joined page turn (turns.js).
export function createBotStopReceiver(rt) {
  return async ({ remoteBotId } = {}) => {
    const id = typeof remoteBotId === 'string' ? remoteBotId.trim() : ''
    if (id === '') return { ok: false, stopped: false, error: 'bot-stop-missing-bot' }
    if (typeof rt.stopChat !== 'function') return { ok: false, stopped: false, error: 'bot-stop-unavailable' }
    try {
      return { ok: true, stopped: (await rt.stopChat(id)) === true }
    } catch (error) {
      return { ok: false, stopped: false, error: error?.message ?? 'bot-stop-failed' }
    }
  }
}

export function exposeBotStopReceiver(ctx, accept) {
  try { ctx?.provide?.('remote-agent:bot-stop', accept) } catch { /* registry plugin may be absent */ }
}

// The texts this module sends when a dispatch produced no answer. A reply row with any other
// text is the node's answer, and a later failure must never take its place.
const saysNoAnswer = text => text === BRIDGE_DOWN_TEXT || text === STOPPED_TEXT || String(text ?? '').startsWith('副机没有接上：')

// What the ledger already holds for an exchange. A retried delivery carries the same exchange
// id, and after a restart it has to find the row the first one wrote.
function recordedReply(rt, exchangeId) {
  const rows = rt.state?.exchanges
  if (!Array.isArray(rows)) return undefined
  const row = rows.find(other => other?.id === exchangeId && other?.role === 'reply')
  return row === undefined ? undefined : { text: row.text, answered: !saysNoAnswer(row.text) }
}

// One row per exchange: a retried delivery writes its outcome into the row it already has, so
// the ledger keeps one row where the exchange is and a late answer can fill in that row.
function recordReply(rt, { exchangeId, fromId, toId, text, answered }) {
  const rows = rt.state?.exchanges
  if (!Array.isArray(rows)) return
  // A dispatch with no sender is not an exchange between two Bots: nothing to record for it.
  if (typeof fromId !== 'string' || fromId === '') return
  const earlier = rows.findIndex(other => other?.id === exchangeId)
  const entry = {
    id: exchangeId,
    from: toId,
    to: fromId,
    text,
    role: 'reply',
    replyTo: exchangeId,
    time: Date.now(),
  }
  if (earlier === -1) rows.push(entry)
  else if (answered) rows[earlier] = entry
}

export async function replyToSender(rt, { fromId, toId, exchangeId, work, text, answered = true }) {
  const shadow = rt.botOf?.(toId)
  const earlier = recordedReply(rt, exchangeId)
  // This module now has an outcome for the work, so close it the way the local reply path does.
  // Left open, the 30-minute delegate timer would tell the sender that work already answered
  // had timed out, and a retried dispatch would do it again.
  const closed = earlier?.answered === true && answered === false ? earlier.text : text
  rt.closeWork?.(exchangeId, shadow?.name, closed)
  if (answered === false && earlier !== undefined) {
    // The sender has already heard about this exchange — an answer, or an earlier failure. A
    // replayed dispatch that failed again says nothing new and must not overwrite the row.
    return
  }
  if (shadow?.worker) shadow.worker.lastReply = { exchangeId, text, at: Date.now() }
  recordReply(rt, { exchangeId, fromId, toId, text, answered })
  const sender = fromId ? rt.botOf?.(fromId) : undefined
  if (!sender || sender.id === toId) return
  await rt.deliver?.({
    fromId: toId,
    toId: fromId,
    text,
    role: 'reply',
    replyTo: exchangeId,
    ...(work ? { work } : {}),
  })
}

export async function handleJoinedTurn(rt, msg = {}) {
  const { fromId, toId, text, exchangeId, work } = msg
  const to = rt.botOf?.(toId)
  if (!joinedShadow(to)) return { ok: false, error: 'joined shadow cannot dispatch' }
  const nodeId = trimmed(to.worker?.nodeId)
  const remoteBotId = trimmed(to.worker?.remoteBotId)
  if (nodeId === '' || remoteBotId === '') return { ok: false, error: 'joined shadow missing remoteBotId' }
  const id = shadowId(nodeId, remoteBotId)
  const row = rt.state?.bots?.[id]
  if (!row || row.id !== to.id) return { ok: false, error: 'joined shadow not on roster' }
  const xid = trimmed(exchangeId) || randomUUID()
  const opened = await openMirrorTurn(rt, to, text, xid)
  // A retried delivery is already on the page: dispatch again (the node's exchange is keyed by
  // xid), but do not open a second turn there.
  const mirror = opened?.duplicate === true ? undefined : opened
  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  if (!registry || typeof registry.send !== 'function') {
    closeMirrorTurn(rt, mirror, to.id, { error: { code: 'bridge-down', message: BRIDGE_DOWN_TEXT } })
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: BRIDGE_DOWN_TEXT, answered: false })
    return { ok: false, error: 'bridge-down' }
  }
  const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : (rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS)
  const wait = listenBotTurnResult(registry, xid, nodeId, timeoutMs)
  const sent = registry.send(nodeId, 'bot/turn', { nodeId, remoteBotId, exchangeId: xid, text: text ?? '' })
  if (sent !== true) {
    wait.cancel()
    closeMirrorTurn(rt, mirror, to.id, { error: { code: 'bridge-down', message: BRIDGE_DOWN_TEXT } })
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: BRIDGE_DOWN_TEXT, answered: false })
    return { ok: false, error: 'bridge-down' }
  }
  const settle = async (result) => {
    if (result?.error === 'stopped') {
      // Settled by a stop of this node, not by the node going away: close the mirror as stopped
      // and tell the sender it was stopped. A late result or nodeOffline for this exchange finds
      // the waiter already gone, so neither is written here.
      closeMirrorTurn(rt, mirror, to.id, { stopped: true })
      await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: STOPPED_TEXT, answered: false })
      return { ok: false, error: 'stopped' }
    }
    if (!result || result.error === 'bridge-down') {
      closeMirrorTurn(rt, mirror, to.id, { error: { code: result?.error ?? 'bot-turn-lost', message: BRIDGE_DOWN_TEXT } })
      await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: BRIDGE_DOWN_TEXT, answered: false })
      return { ok: false, error: result?.error ?? 'bot-turn-lost' }
    }
    if (result.ok === false) {
      const error = result.error ?? 'bot-turn-failed'
      closeMirrorTurn(rt, mirror, to.id, { error: { code: error, message: `副机没有接上：${error}` } })
      await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: `副机没有接上：${error}`, answered: false })
      return { ok: false, error }
    }
    closeMirrorTurn(rt, mirror, to.id, { text: result.text, seq: result.seq })
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: result.text ?? '' })
    return xid
  }
  if (msg.defer === true) {
    // A message from another Bot must not hold its sender's tool call until the node's model
    // turn finishes: the receipt says "delivered, the reply comes later", and the answer
    // reaches the sender as a new message. Send failures above are still reported at once.
    wait.pending.then(settle).catch(error => {
      rt.warn?.('ds-bot: a joined turn for %s could not be completed: %s', to.id, error?.message ?? error)
    })
    return xid
  }
  return settle(await wait.pending)
}

function findLocal(rt, remoteBotId) {
  const bots = rt.state?.bots ?? {}
  const direct = bots[remoteBotId]
  if (direct && direct.id === remoteBotId) return direct
  return Object.values(bots).find((bot) => bot && bot.id === remoteBotId)
}

export function createBotTurnReceiver(rt, { timeoutMs = JOINED_TURN_TIMEOUT_MS } = {}) {
  const pending = new Map()
  rt.settleJoinedTurn = (exchangeId, text, error) => {
    const waiter = pending.get(exchangeId)
    if (!waiter) return false
    pending.delete(exchangeId)
    clearTimeout(waiter.timer)
    if (error) waiter.reject(error)
    else waiter.resolve(typeof text === 'string' ? text : '')
    return true
  }
  return async function acceptJoinedTurn(turn) {
    const remoteBotId = trimmed(turn?.remoteBotId)
    const exchangeId = trimmed(turn?.exchangeId)
    if (remoteBotId === '' || exchangeId === '') return { ok: false, error: 'bot-turn-missing' }
    const bot = findLocal(rt, remoteBotId)
    if (!bot || bot.type === 'remote-worker' || bot.origin === 'joined') return { ok: false, error: 'bot-not-on-roster' }
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(exchangeId)
        reject(Object.assign(new Error('joined-turn-timeout'), { code: 'joined-turn-timeout' }))
      }, timeoutMs)
      timer.unref?.()
      pending.set(exchangeId, { resolve, reject, timer })
    })
    try {
      // sendUser creates a real user bubble in chatPage (not an event entry).
      // The bot's reply lands as a bot bubble. turns.js calls settleJoinedTurn
      // when the turn finishes, resolving `done`.
      if (typeof rt.sendUser !== 'function') throw new Error('sendUser unavailable')
      await rt.sendUser({
        sessionId: rt.chatOf?.(bot.id),
        content: [{ type: 'text', text: turn.text ?? '' }],
        requestId: exchangeId,
      })
    } catch {
      const waiter = pending.get(exchangeId)
      if (waiter) {
        pending.delete(exchangeId)
        clearTimeout(waiter.timer)
      }
      return { ok: false, error: 'bot-turn-deliver-failed' }
    }
    try {
      const text = await done
      return { ok: true, exchangeId, text }
    } catch (err) {
      return { ok: false, exchangeId, error: err?.code ?? 'bot-turn-failed', text: '' }
    }
  }
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => typeof block?.text === 'string' ? block.text : '').join('')
}

/** @deprecated S2-2: joined shadow now routes through channel.js sendUser → ensureMirrorSession → executor.deliverTurn. This wrapper is retained for backward compatibility but should not be activated for joined bots. */
function wrapSendUser(rt) {
  const orig = rt.sendUser
  if (typeof orig !== 'function' || orig.__joinedTurn === true) return
  const wrapped = async function sendUserJoined(args) {
    const bot = rt.bySessionId?.(args?.sessionId) ?? rt.botOf?.(args?.sessionId)
    if (!joinedShadow(bot)) return orig(args)
    const result = await rt.handleJoinedTurn({
      fromId: undefined,
      toId: bot.id,
      text: textOfContent(args?.content),
      role: 'request',
      exchangeId: typeof args?.requestId === 'string' ? args.requestId : undefined,
    })
    if (result && result.ok === false) {
      const message = result.error === 'bridge-down' || result.error === 'bot-turn-lost'
        ? BRIDGE_DOWN_TEXT
        : (result.error ?? 'joined shadow cannot dispatch')
      throw Object.assign(new Error(message), { code: 'bot/joined' })
    }
    return result
  }
  wrapped.__joinedTurn = true
  rt.sendUser = wrapped
}

export function exposeBotTurnReceiver(ctx, accept) {
  try { ctx?.provide?.('remote-agent:bot-turn', accept) } catch { /* registry plugin may be absent */ }
}

export function install(rt) {
  rt.handleJoinedTurn = (msg) => handleJoinedTurn(rt, msg)
  const accept = createBotTurnReceiver(rt)
  exposeBotTurnReceiver(rt.ctx, accept)
  exposeBotStopReceiver(rt.ctx, createBotStopReceiver(rt))
  // wrapSendUser(rt) — removed in S2-2: channel.install already routes joined bots
  // through ensureMirrorSession + executor.deliverTurn. Calling wrapSendUser here
  // would overwrite rt.sendUser and bypass the mirror session path entirely.
}
