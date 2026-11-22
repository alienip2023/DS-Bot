// Step 2: a sidebar or bot-to-bot message to a joined shadow runs in that
// remote Bot's existing session. It does not pick a node, does not start an
// agent task, and does not run a model on this Mac.
import { createHash, randomUUID } from 'node:crypto'
import { joinedShadow, shadowId } from './roster-join.js'
import {
  ensureMirrorSession, hasPromptRequest, mirrorStateOf,
} from './mirror.js'
import { classify } from './msg-classes.js'
import { beginJoinedMirror, closeJoinedMirror, markJoinedMirrorPending, mirrorTurnOpen } from './joined-mirror-writer.js'

export const BRIDGE_DOWN_TEXT = '副机仍在执行，桥已断'
// What the sender is told when its exchange was settled by a stop, not by the node going away.
export const STOPPED_TEXT = '已停止'
export const PENDING_TURN_TEXT = 'Node is still running; its result will be delivered later.'
// The foreground result deadline. Both page and Bot-to-Bot turns stay open after it;
// executor.js's separate late-reply writer handles results after the user presses Stop.
export const JOINED_TURN_TIMEOUT_MS = 600_000
// How long after a timeout a late bot/turn-result is still written into the mirror Session.
export const JOINED_LATE_WINDOW_MS = 3_600_000
const MAX_TIMER_MS = 2_147_483_647
// Exchanges still waiting on a node, scoped to their registry and remote Bot. A stop settles these by the exchange
// itself; the bot/stop-result frame carries no exchangeId, so the association cannot be guessed
// from the requestId. An exchange leaves the moment it settles, so a result or a nodeOffline
// that arrives afterwards finds nothing to deliver to.
const inflightByRegistry = new WeakMap()

/** `config.joinedTurnTimeoutMs`: whole milliseconds between 1s and the timer limit, else the default. */
export function joinedTimeoutFrom(value) {
  return Number.isInteger(value) && value >= 1000 && value <= MAX_TIMER_MS ? value : JOINED_TURN_TIMEOUT_MS
}
const MIRROR_RPC_PREFIX = 'joined:'

// A Bot-to-Bot message is a real exchange on the joined Bot's page too. Open a mirror turn
// before the frame goes out so the page shows the request at once; close it with the answer,
// or with the visible failure line. `duplicate` means this exchange is already on the page
// (a retried delivery): the turn is not opened again. Any mirror failure is a warning only —
// it must never block the dispatch itself.
async function openMirrorTurn(rt, bot, text, xid, senderName, roomId) {
  try {
    const room = roomId ? rt.roomOf?.(roomId) : undefined
    const session = room ? (await rt.resolveAgent(rt.sessionOfRoom(room))).session : await ensureMirrorSession(rt, bot)
    const rpcId = MIRROR_RPC_PREFIX + xid
    if (hasPromptRequest(session, rpcId)) return { duplicate: true }
    const state = mirrorStateOf(rt, room ? session.id : bot.id, session)
    const mirror = beginJoinedMirror(rt, bot, session, { text: text ?? '', rpcId, state, ...(room ? { writerId: session.id } : {}) })
    // Notify group round waiters that the node Bot has started working.
    // This triggers the round's ROOM_WORK_GRACE_MS window so it doesn't time out
    // while waiting for the node's reply. Local Bots do this via tool/call session events.
    if (room) rt.workRoomTurn?.(session.id, 'joined-turn')
    return mirror
  } catch (error) {
    rt.warn?.('ds-bot: a Bot-to-Bot message for %s was not mirrored: %s', bot.id, error?.message ?? error)
    return undefined
  }
}

function closeMirrorTurn(rt, mirror, botId, { text, seq, error, stopped } = {}) {
  if (mirror === undefined) return
  closeJoinedMirror(rt, mirror, { text, seq, error, stopped })
  // The group round waiter for this joined Bot never sees session events (its
  // mirror Session has no local Agent), so notify it here: a finished turn
  // touches the waiter, a failed one fails it.
  const groupSessions = typeof rt.groupSessionsOf === 'function' ? (rt.groupSessionsOf(botId) ?? []) : []
  for (const groupSessionId of groupSessions) {
    if (error !== undefined || stopped === true) rt.failRoomTurn?.(groupSessionId, { code: error ?? 'STOPPED', message: stopped ? 'stopped' : String(text ?? '').slice(0, 300) })
    else rt.touchRoomTurn?.(groupSessionId)
  }
}


export function joinedDispatchRole(role) {
  return classify(role) === 'visible'
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function listenBotTurnResult(registry, exchangeId, nodeId, timeoutMs, remoteBotId, { lateWindowMs = 0, onTimeout } = {}) {
  let settled = false
  let received = false   // the node's answer for THIS exchange has arrived (not a cancel/timeout/offline)
  let resolve
  const pending = new Promise((res) => { resolve = res })
  let resolveCompletion
  const completion = new Promise((res) => { resolveCompletion = res })
  let inflightByNode = inflightByRegistry.get(registry)
  if (!inflightByNode) { inflightByNode = new Map(); inflightByRegistry.set(registry, inflightByNode) }
  const tracked = inflightByNode.get(nodeId) ?? new Map()
  inflightByNode.set(nodeId, tracked)
  const receipts = receiptsOf(registry)
  const finish = (value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    registry.off?.('botTurnResult', onResult)
    registry.off?.('nodeOffline', onOffline)
    if (tracked.get(exchangeId)?.finish === finish) tracked.delete(exchangeId)
    if (tracked.size === 0) inflightByNode.delete(nodeId)
    // Only the stop receipt may treat a dropped bridge as the stop taking effect.
    if (receipts.get(exchangeId) === nodeId) receipts.delete(exchangeId)
    resolve(value)
    resolveCompletion(value)
  }
  tracked.set(exchangeId, { finish, remoteBotId })
  const onResult = (payload) => {
    if (payload?.exchangeId !== exchangeId) return
    if (payload.nodeId && payload.nodeId !== nodeId) return
    if (!settled) received = true
    finish(payload)
  }
  const onOffline = (payload) => {
    if (payload?.nodeId && payload.nodeId !== nodeId) return
    // Other Bots on this node still report a real bridge loss during the stop window.
    if (receipts.get(exchangeId) === nodeId) { finish({ ok: false, error: 'stopped', exchangeId }); return }
    finish({ ok: false, error: 'bridge-down', exchangeId })
  }
  // Keep the same listeners across the soft deadline: a result or disconnect in that tick
  // must not fall into a gap between removing the original waiter and arming a late one.
  let timer = setTimeout(() => {
    if (lateWindowMs <= 0) { finish(undefined); return }
    // The answer window is bounded, but a still-open turn must remain stoppable and must
    // report a real bridge loss even after that window expires.
    timer = setTimeout(() => registry.off?.('botTurnResult', onResult), lateWindowMs)
    timer.unref?.()
    resolve(undefined)
    onTimeout?.()
  }, timeoutMs)
  timer.unref?.()
  registry.on?.('botTurnResult', onResult)
  registry.on?.('nodeOffline', onOffline)
  return { pending, completion, cancel: () => finish({ ok: false, error: 'bridge-down', exchangeId }), received: () => received }
}

// The explanatory receipt opens after the stop settled the original exchange.
const stoppedReceipts = new WeakMap()

function receiptsOf(registry) {
  let receipts = stoppedReceipts.get(registry)
  if (!receipts) { receipts = new Map(); stoppedReceipts.set(registry, receipts) }
  return receipts
}

export function noteStoppedExchange(exchangeId, nodeId, registry) {
  if (typeof exchangeId !== 'string' || exchangeId === '') return
  if (typeof nodeId !== 'string' || nodeId === '') return
  receiptsOf(registry).set(exchangeId, nodeId)
}

// Without a Bot id the legacy caller explicitly stops the whole node's exchanges.
export function settleStoppedTurns(registry, nodeId, remoteBotId) {
  const tracked = inflightByRegistry.get(registry)?.get(nodeId)
  if (!tracked || tracked.size === 0) return 0
  const waiting = [...tracked.values()].filter(entry => remoteBotId === undefined || entry.remoteBotId === remoteBotId)
  for (const { finish } of waiting) finish({ ok: false, error: 'stopped', exchangeId: undefined })
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
    if (payload.nodeId && payload.nodeId !== nodeId) return
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

export async function replyToSender(rt, { fromId, toId, exchangeId, work, text, roomId, answered = true }) {
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
  if (roomId) {
    const room = rt.roomOf?.(roomId)
    if (room) {
      await rt.deliver?.({ fromId: toId, toId: fromId ?? toId, text, role: 'reply', replyTo: exchangeId, roomId, ...(work ? { work } : {}), joinedTurn: true })
      return
    }
    rt.warn?.('ds-bot: room %s for joined reply %s was not found; falling back to private chat', roomId, exchangeId)
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
    joinedTurn: true,
  })
}

export async function handleJoinedTurn(rt, msg = {}) {
  const { fromId, toId, text, exchangeId, work } = msg
  const roomId = trimmed(msg.roomId)
  const roomName = trimmed(msg.roomName)
  const roomFields = { ...(roomId ? { roomId } : {}), ...(roomName ? { roomName } : {}) }
  const to = rt.botOf?.(toId)
  if (!joinedShadow(to)) return { ok: false, error: 'joined shadow cannot dispatch' }
  const nodeId = trimmed(to.worker?.nodeId)
  const remoteBotId = trimmed(to.worker?.remoteBotId)
  if (nodeId === '' || remoteBotId === '') return { ok: false, error: 'joined shadow missing remoteBotId' }
  const id = shadowId(nodeId, remoteBotId)
  const row = rt.state?.bots?.[id]
  if (!row || row.id !== to.id) return { ok: false, error: 'joined shadow not on roster' }
  const xid = trimmed(exchangeId) || randomUUID()
  const existing = rt.joinedDeliveries?.get(xid)
  if (existing) return msg.defer === true ? xid : existing.waited
  const sender = rt.botOf?.(fromId)
  const senderName = trimmed(msg.senderName) || (trimmed(sender?.name) === '' ? fromId : sender.name)
  const senderBotId = trimmed(msg.senderBotId) || fromId
  const opened = await openMirrorTurn(rt, to, text, xid, senderName, roomId)
  // A retried delivery is already on the page: dispatch again (the node's exchange is keyed by
  // xid), but do not open a second turn there.
  const mirror = opened?.duplicate === true ? undefined : opened
  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  if (!registry || typeof registry.send !== 'function') {
    closeMirrorTurn(rt, mirror, to.id, { error: { code: 'bridge-down', message: BRIDGE_DOWN_TEXT } })
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, roomId, text: BRIDGE_DOWN_TEXT, answered: false })
    return { ok: false, error: 'bridge-down' }
  }
  const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : (rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS)
  // The caller names this exchange before the frame goes out (the stop receipt does). Remembering
  // it here, before the listener is attached, is what lets a node drop that lands in the same
  // tick close it as stopped instead of as a bridge that went down.
  if (msg.stopped === true) noteStoppedExchange(xid, nodeId, registry)
  const lateWindowMs = Number.isFinite(rt.joinedLateWindowMs) ? Math.max(1, rt.joinedLateWindowMs) : JOINED_LATE_WINDOW_MS
  const wait = listenBotTurnResult(registry, xid, nodeId, timeoutMs, remoteBotId, {
    lateWindowMs,
    onTimeout: () => markJoinedMirrorPending(rt, mirror, PENDING_TURN_TEXT),
  })
  let sent = false
  try {
    sent = registry.send(nodeId, 'bot/turn', {
      nodeId, remoteBotId, exchangeId: xid, text: text ?? '', senderBotId, senderName, ...roomFields,
    })
  } catch { /* the connection may close between lookup and send */ }
  if (sent !== true) {
    wait.cancel()
    closeMirrorTurn(rt, mirror, to.id, { error: { code: 'bridge-down', message: BRIDGE_DOWN_TEXT } })
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, roomId, text: BRIDGE_DOWN_TEXT, answered: false })
    return { ok: false, error: 'bridge-down' }
  }
  const settle = async (result) => {
    if (result?.error === 'stopped') {
      // Settled by a stop of this node, not by the node going away: close the mirror as stopped
      // and tell the sender it was stopped. A late result or nodeOffline for this exchange finds
      // the waiter already gone, so neither is written here.
      closeMirrorTurn(rt, mirror, to.id, { stopped: true })
      await replyToSender(rt, { fromId, toId, exchangeId: xid, work, roomId, text: STOPPED_TEXT, answered: false })
      return { ok: false, error: 'stopped' }
    }
    if (result.error === 'bridge-down') {
      closeMirrorTurn(rt, mirror, to.id, { error: { code: 'bridge-down', message: BRIDGE_DOWN_TEXT } })
      await replyToSender(rt, { fromId, toId, exchangeId: xid, work, roomId, text: BRIDGE_DOWN_TEXT, answered: false })
      return { ok: false, error: 'bridge-down' }
    }
    if (result.ok === false) {
      const error = result.error ?? 'bot-turn-failed'
      closeMirrorTurn(rt, mirror, to.id, { error: { code: error, message: `副机没有接上：${error}` } })
      await replyToSender(rt, { fromId, toId, exchangeId: xid, work, roomId, text: `副机没有接上：${error}`, answered: false })
      return { ok: false, error }
    }
    closeMirrorTurn(rt, mirror, to.id, { text: result.text, seq: result.seq })
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, roomId, text: result.text ?? '' })
    return xid
  }
  if (!rt.joinedDeliveries) rt.joinedDeliveries = new Map()
  const completed = wait.completion.then(settle).finally(() => { rt.joinedDeliveries.delete(xid) })
  const waited = wait.pending.then(result => result === undefined
    ? { ok: false, error: 'bot-turn-pending', exchangeId: xid }
    : completed)
  rt.joinedDeliveries.set(xid, { waited })
  completed.catch(error => {
    rt.warn?.('ds-bot: a joined turn for %s could not be completed: %s', to.id, error?.message ?? error)
  })
  if (msg.defer === true) {
    // A message from another Bot must not hold its sender's tool call until the node's model
    // turn finishes: the receipt says "delivered, the reply comes later", and the answer
    // reaches the sender as a new message. Send failures above are still reported at once.
    // No caller awaits waited in deferred mode, but it still follows completed on a result.
    waited.catch(() => {})
    return xid
  }
  return waited
}

function findLocal(rt, remoteBotId) {
  const bots = rt.state?.bots ?? {}
  const direct = bots[remoteBotId]
  if (direct && direct.id === remoteBotId) return direct
  return Object.values(bots).find((bot) => bot && bot.id === remoteBotId)
}

export function remoteGroupSession(roomId, botId) {
  const hash = createHash('sha1').update(roomId + ':' + botId).digest('hex').slice(0, 32)
  return `session-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`
}

// The hub's first deadline only marks progress. Keep the node's result slot alive through
// its late window as well, otherwise the node itself would discard the eventual answer.
export function createBotTurnReceiver(rt, { timeoutMs = JOINED_TURN_TIMEOUT_MS + JOINED_LATE_WINDOW_MS } = {}) {
  const pending = new Map()
  const pendingBySession = new Map()
  const creating = new Map()
  async function groupSessionFor(bot, roomId, roomName) {
    const sessionId = remoteGroupSession(roomId, bot.id)
    const existing = creating.get(sessionId)
    if (existing) { await existing; return sessionId }
    if (bot.remoteGroupSessions?.includes(sessionId)) return sessionId
    const job = (async () => {
      bot.remoteGroupSessions ??= []
      bot.remoteGroupSessions.push(sessionId)
      try {
        await rt.save?.()
        if (typeof rt.createSession === 'function') {
          const created = await rt.createSession(`${bot.name} · ${roomName || roomId}`, { sessionId })
          if (created !== sessionId) throw new Error('remote group session identity changed')
          // Write the protected system/message head required by DSH session format v4.
          // Without it every system-prompt update (systemPromptUpdate: "in-history") corrupts
          // the log — the same session-head fix applied in mirror.js createMirrorSession.
          try {
            const { createSystemMessage } = await import('@deepseek-ai/dsh-llm')
            const agent = await rt.resolveAgent?.(sessionId)
            const sess = agent?.session
            if (sess) {
              try { sess.append('system/message', createSystemMessage(`[mirror: ${bot.name}]`), { protected: true }) }
              catch { try { sess.append('system/message', createSystemMessage(`[mirror: ${bot.name}]`)) } catch { /* ignore */ } }
            }
          } catch { /* ignore — session will proceed without the head */ }
        }
      } catch (error) {
        bot.remoteGroupSessions = bot.remoteGroupSessions.filter(id => id !== sessionId)
        await rt.save?.()
        throw error
      }
    })()
    creating.set(sessionId, job)
    try { await job } finally { creating.delete(sessionId) }
    return sessionId
  }
  rt.settleJoinedTurn = (exchangeId, text, error) => {
    const waiter = pending.get(exchangeId)
    if (!waiter) return false
    pending.delete(exchangeId)
    if (waiter.sessionId) {
      const bySession = pendingBySession.get(waiter.sessionId)
      bySession?.delete(exchangeId)
    }
    clearTimeout(waiter.timer)
    if (error) waiter.reject(error)
    else waiter.resolve(typeof text === 'string' ? text : '')
    return true
  }
  // Abort all joined-turn waiters that belong to a given bot session.
  // Called from agent/turn-stopping so callers don't hang indefinitely.
  rt.abortJoinedTurnsForSession = (sessionId) => {
    const ids = pendingBySession.get(sessionId)
    if (!ids || ids.size === 0) return
    const abortErr = Object.assign(new Error('agent-turn-stopped'), { code: 'agent-turn-stopped' })
    for (const exchangeId of [...ids]) {
      const waiter = pending.get(exchangeId)
      if (!waiter) continue
      pending.delete(exchangeId)
      clearTimeout(waiter.timer)
      waiter.reject(abortErr)
    }
    pendingBySession.delete(sessionId)
  }
  return async function acceptJoinedTurn(turn) {
    const remoteBotId = trimmed(turn?.remoteBotId)
    const exchangeId = trimmed(turn?.exchangeId)
    const roomId = trimmed(turn?.roomId)
    const roomFields = roomId ? { roomId } : {}
    const steering = turn?.mode === 'steer'
    if (remoteBotId === '' || exchangeId === '') return { ok: false, error: 'bot-turn-missing', ...roomFields }
    const bot = findLocal(rt, remoteBotId)
    if (!bot || bot.type === 'remote-worker' || bot.origin === 'joined') return { ok: false, error: 'bot-not-on-roster', ...roomFields }
    // The hub asked this Bot: what its background tasks report later is owed to that hub's page.
    ;(rt.hubAskedBots ??= new Set()).add(bot.id)
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(exchangeId)
        const bySession = pendingBySession.get(bot.id)
        bySession?.delete(exchangeId)
        reject(Object.assign(new Error('joined-turn-timeout'), { code: 'joined-turn-timeout' }))
      }, timeoutMs)
      timer.unref?.()
      pending.set(exchangeId, { resolve, reject, timer, sessionId: bot.id })
      let bySession = pendingBySession.get(bot.id)
      if (!bySession) { bySession = new Set(); pendingBySession.set(bot.id, bySession) }
      bySession.add(exchangeId)
    })
    try {
      // sendUser creates a real user bubble in chatPage (not an event entry).
      // The bot's reply lands as a bot bubble. turns.js calls settleJoinedTurn
      // when the turn finishes, resolving `done`.
      if (typeof rt.sendUser !== 'function') throw new Error('sendUser unavailable')
      const sessionIdForTurn = roomId ? await groupSessionFor(bot, roomId, trimmed(turn.roomName)) : rt.chatOf?.(bot.id)
      const send = () => {
        const name = typeof turn.senderName === 'string' ? turn.senderName.trim() : ''
        const header = name === '' ? '' : '[Message from ' + name + ']'
        const text = roomId
          ? '[群 ' + (trimmed(turn.roomName) || roomId) + ']' + (header === '' ? ' ' : '\n' + header + '\n') + (turn.text ?? '')
          : header === '' ? (turn.text ?? '') : header + '\n' + (turn.text ?? '')
        return rt.sendUser({
          sessionId: sessionIdForTurn,
          content: [{ type: 'text', text }],
          requestId: exchangeId,
          ...(steering ? { mode: 'steer' } : {}),
        })
      }
      // A steer joins the turn already running on this Session; only what waits goes through the gate.
      const joinsRunning = steering && rt.threadQueueLive?.(bot.id)?.running?.sessionId === sessionIdForTurn
      if (typeof rt.sendThreadTurn === 'function' && !joinsRunning) {
        await rt.sendThreadTurn({
          botId: bot.id, kind: 'send', preview: turn.text, releaseOn: 'run', run: send,
          onCancel: () => rt.settleJoinedTurn(exchangeId, '', Object.assign(new Error('bot-turn-cancelled'), { code: 'bot-turn-cancelled' })),
        })
      } else await send()
    } catch {
      const waiter = pending.get(exchangeId)
      if (waiter) {
        pending.delete(exchangeId)
        clearTimeout(waiter.timer)
        // P1-1 fix: also remove from pendingBySession to prevent leak
        const bySession = pendingBySession.get(waiter.sessionId)
        if (bySession) {
          bySession.delete(exchangeId)
          if (bySession.size === 0) pendingBySession.delete(waiter.sessionId)
        }
      }
      return { ok: false, error: 'bot-turn-deliver-failed', ...roomFields }
    }
    try {
      const text = await done
      return { ok: true, exchangeId, text, ...roomFields }
    } catch (err) {
      return { ok: false, exchangeId, error: err?.code ?? 'bot-turn-failed', text: '', ...roomFields }
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

/**
 * A node Bot's background task finished and the Bot answered what it brought back: the answer goes
 * to the hub as one bot/message (kind reply, the Bot as both ends, depth at the cap — the hub reads
 * that as a report; an older hub drops it). Only a Bot the hub has asked, and only while the link
 * is up; the page of that Bot on the hub shows it as a marked turn. Returns whether it was sent.
 */
export function reportTaskToHub(rt, bot, text) {
  const network = rt.botNetwork
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '' || !bot || !rt.hubAskedBots?.has(bot.id)) return false
  if (typeof network?.send !== 'function' || typeof network.nodeId !== 'string') return false
  const identity = { id: bot.id, name: bot.name || bot.id, nodeId: network.nodeId }
  try {
    return network.send({ from: identity, to: { ...identity, nodeId: 'hub' }, exchangeId: randomUUID(), kind: 'reply', text: body.slice(0, 60000), depth: 3 }) === true
  } catch { return false }
}

export function install(rt) {
  rt.reportTaskToHub = (bot, text) => reportTaskToHub(rt, bot, text)
  rt.handleJoinedTurn = (msg) => handleJoinedTurn(rt, msg)
  const accept = createBotTurnReceiver(rt)
  exposeBotTurnReceiver(rt.ctx, accept)
  exposeBotStopReceiver(rt.ctx, createBotStopReceiver(rt))
  // wrapSendUser(rt) — removed in S2-2: channel.install already routes joined bots
  // through ensureMirrorSession + executor.deliverTurn. Calling wrapSendUser here
  // would overwrite rt.sendUser and bypass the mirror session path entirely.
}
