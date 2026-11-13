// Step 2: a sidebar or bot-to-bot message to a joined shadow runs in that
// remote Bot's existing session. It does not pick a node, does not start an
// agent task, and does not run a model on this Mac.
import { randomUUID } from 'node:crypto'
import { joinedShadow, shadowId } from './roster-join.js'
import {
  allocateTurn, ensureMirrorSession, hasPromptRequest, mirrorStateOf,
  mirrorTurnFail, mirrorTurnFinish, mirrorTurnStart,
} from './mirror.js'

export const BRIDGE_DOWN_TEXT = '副机仍在执行，桥已断'
// How long a turn waits for the node's answer. A node Bot that calls tools takes minutes (the
// first tool call alone can run for over a minute), so the wait covers that; the node's reply
// that still comes after this is not lost (executor.js startPageTurn writes it as a late reply).
export const JOINED_TURN_TIMEOUT_MS = 600_000
// How long after a timeout a late bot/turn-result is still written into the mirror Session.
export const JOINED_LATE_WINDOW_MS = 3_600_000
const MAX_TIMER_MS = 2_147_483_647

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
    const turn = allocateTurn(session)
    mirrorTurnStart(session, { turn, step: 1, userText: text ?? '', rpcId })
    return { session, turn, state: mirrorStateOf(rt, bot.id) }
  } catch (error) {
    rt.warn?.('ds-bot: a Bot-to-Bot message for %s was not mirrored: %s', bot.id, error?.message ?? error)
    return undefined
  }
}

function closeMirrorTurn(rt, mirror, botId, { text, seq, error } = {}) {
  if (mirror?.session === undefined) return
  try {
    if (error !== undefined) {
      mirrorTurnFail(mirror.session, {
        turn: mirror.turn, step: 1, code: error.code, message: error.message,
        closedTurns: mirror.state.closedTurns,
      })
    } else {
      mirrorTurnFinish(mirror.session, {
        turn: mirror.turn, step: 1, botText: text ?? '', botId, nodeSeq: seq, ...mirror.state,
      })
    }
  } catch (caught) {
    rt.warn?.('ds-bot: a Bot-to-Bot reply for %s was not mirrored: %s', botId, caught?.message ?? caught)
  }
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
  const finish = (value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    registry.off?.('botTurnResult', onResult)
    registry.off?.('nodeOffline', onOffline)
    resolve(value)
  }
  const onResult = (payload) => {
    if (payload?.exchangeId !== exchangeId) return
    if (!settled) received = true
    finish(payload)
  }
  const onOffline = (payload) => {
    if (payload?.nodeId && payload.nodeId !== nodeId) return
    finish({ ok: false, error: 'bridge-down', exchangeId })
  }
  const timer = setTimeout(() => finish(undefined), timeoutMs)
  timer.unref?.()
  registry.on?.('botTurnResult', onResult)
  registry.on?.('nodeOffline', onOffline)
  return { pending, cancel: () => finish({ ok: false, error: 'bridge-down', exchangeId }), received: () => received }
}

async function replyToSender(rt, { fromId, toId, exchangeId, work, text }) {
  const shadow = rt.botOf?.(toId)
  if (shadow?.worker) shadow.worker.lastReply = { exchangeId, text, at: Date.now() }
  if (rt.state && Array.isArray(rt.state.exchanges)) {
    rt.state.exchanges.push({
      id: exchangeId,
      from: toId,
      to: fromId ?? toId,
      text,
      role: 'reply',
      replyTo: exchangeId,
      time: Date.now(),
    })
  }
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
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: BRIDGE_DOWN_TEXT })
    return { ok: false, error: 'bridge-down' }
  }
  const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : (rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS)
  const wait = listenBotTurnResult(registry, xid, nodeId, timeoutMs)
  const sent = registry.send(nodeId, 'bot/turn', { nodeId, remoteBotId, exchangeId: xid, text: text ?? '' })
  if (sent !== true) {
    wait.cancel()
    closeMirrorTurn(rt, mirror, to.id, { error: { code: 'bridge-down', message: BRIDGE_DOWN_TEXT } })
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: BRIDGE_DOWN_TEXT })
    return { ok: false, error: 'bridge-down' }
  }
  const result = await wait.pending
  if (!result || result.error === 'bridge-down') {
    closeMirrorTurn(rt, mirror, to.id, { error: { code: result?.error ?? 'bot-turn-lost', message: BRIDGE_DOWN_TEXT } })
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: BRIDGE_DOWN_TEXT })
    return { ok: false, error: result?.error ?? 'bot-turn-lost' }
  }
  if (result.ok === false) {
    const error = result.error ?? 'bot-turn-failed'
    closeMirrorTurn(rt, mirror, to.id, { error: { code: error, message: `副机没有接上：${error}` } })
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: `副机没有接上：${error}` })
    return { ok: false, error }
  }
  closeMirrorTurn(rt, mirror, to.id, { text: result.text, seq: result.seq })
  await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: result.text ?? '' })
  return xid
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
  // wrapSendUser(rt) — removed in S2-2: channel.install already routes joined bots
  // through ensureMirrorSession + executor.deliverTurn. Calling wrapSendUser here
  // would overwrite rt.sendUser and bypass the mirror session path entirely.
}
