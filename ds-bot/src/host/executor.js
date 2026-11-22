// executor.js — dispatch a text message to a bot (remote joined or local).
//
// send({ botId, text, rt, tracker?, timeoutMs? })
//   → { ok: true, turnId, text, nodeId?, remoteBotId? }
//   throws ExecutorError with code: E_NOT_FOUND | E_OFFLINE | E_TIMEOUT | E_REJECTED
//
// deliverTurn({ botId, text, rt, session, seenKeys, closedKeys, seenSteps, tracker?, timeoutMs? })
//   — full pipeline: send + mirrorTurn. nodeSeq comes from the bot/turn-result payload.
//   Contract: bot/turn-result does NOT currently carry a nodeSeq (validateBotTurnResult has no seq).
//   S2 must add `seq` to validateBotTurnResult and bot/turn-result frame; until then nodeSeq is null
//   (mirrorTurn skips idempotency when nodeSeq is null). This is a known S2 obligation.

import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { joinedShadow } from './roster-join.js'
import { listenBotTurnResult, JOINED_TURN_TIMEOUT_MS, JOINED_LATE_WINDOW_MS, LINK_LOST_TEXT, PENDING_TURN_TEXT } from './joined-turn.js'
import { mirrorTurn, allocateTurn, mirrorTurnStart, mirrorTurnFinish, mirrorTurnFail, mirrorTurnAbort, mirrorTurnPending, mirrorLateReply, TASK_RESULT_MARK, STEER_REPLY_MARK } from './mirror.js'
import { deferMirrorWrite, drainJoinedMirror, mirrorTurnOpen } from './joined-mirror-writer.js'
import { noteTraceGap, openTraceSink } from './hub-trace.js'

/**
 * Error codes thrown by send() / deliverTurn():
 *   E_NOT_FOUND — bot not registered or missing worker config
 *   E_OFFLINE   — remote node is not reachable or registry unavailable
 *   E_TIMEOUT   — no result within timeout (default JOINED_TURN_TIMEOUT_MS = 600s; config.joinedTurnTimeoutMs)
 *   E_ABORTED   — the page's Stop ended the wait (startPageTurn only; never thrown to a caller of send())
 *   E_REJECTED  — node explicitly rejected the turn (ok:false with error code)
 */
export class ExecutorError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.code = code
    this.name = 'ExecutorError'
  }
}

/**
 * Send text to a bot. When a tracker is supplied, the turn is started before dispatch
 * and finished (done/failed/timeout) on every exit path.
 *
 * @param {object} opts
 * @param {string} opts.botId
 * @param {string} opts.text
 * @param {object} opts.rt
 * @param {object} [opts.tracker]     - createTurnTracker() instance; optional
 * @param {number} [opts.timeoutMs]   - Override default timeout
 * @returns {{ ok: true, turnId: string, text: string, nodeId?: string, remoteBotId?: string }}
 * @throws {ExecutorError}
 */
export async function send({ botId, text, rt, tracker, timeoutMs: timeoutOverride }) {
  // E_INVALID: input validation (S2-1)
  if (!botId || typeof botId !== 'string')
    throw new ExecutorError('E_INVALID', 'botId is required and must be a non-empty string')
  if (text == null || typeof text !== 'string' || text === '')
    throw new ExecutorError('E_INVALID', 'text is required and must be a non-empty string')

  const bot = rt.botOf?.(botId)
  if (!bot) throw new ExecutorError('E_NOT_FOUND', `bot not found: ${botId}`)

  if (joinedShadow(bot)) {
    return await dispatchRemote({ bot, text, rt, tracker, timeoutOverride }).settle()
  }
  return await sendLocal({ bot, text, rt, tracker })
}

// Dispatch is synchronous (no await): the listener is registered, the frame is sent, and
// every refusal that can be known right away (offline, invalid worker, send failed) throws
// before anything is returned. `settle()` then waits for the node's answer and returns the
// send() result or throws an ExecutorError; `cancel()` drops the listener.
function dispatchRemote(args) {
  const prepared = prepareRemote(args)
  prepared.send()
  return prepared
}

// prepareRemote does everything dispatch does except put the frame on the wire: validate,
// register the result listener. Its refusals throw before anything is sent; `send()` is the
// one irreversible step (it throws E_OFFLINE when the node does not take the frame), and
// `cancel()` drops the listener of a prepared turn that is never sent.
function prepareRemote({ bot, text, rt, tracker, timeoutOverride, lateWindowMs = 0, onTimeout, mode }) {
  if (!bot.worker) {
    throw new ExecutorError('E_NOT_FOUND', 'joined shadow missing worker config')
  }
  const nodeId = bot.worker.nodeId
  const remoteBotId = bot.worker.remoteBotId
  if (typeof nodeId !== 'string' || nodeId === '' || typeof remoteBotId !== 'string' || remoteBotId === '') {
    throw new ExecutorError('E_INVALID', 'worker nodeId and remoteBotId must be non-empty strings')
  }

  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch {}
  if (!registry || typeof registry.send !== 'function') {
    throw new ExecutorError('E_OFFLINE', 'registry unavailable')
  }

  const turnId = randomUUID()
  const timeoutMs = Number.isFinite(timeoutOverride) ? timeoutOverride : (rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS)
  const { pending, completion, cancel, received } = listenBotTurnResult(registry, turnId, nodeId, timeoutMs, remoteBotId, { lateWindowMs, onTimeout })

  // A page's deadline is progress only; the generic sweep must not invent a failure later.
  tracker?.start(turnId, bot.id, lateWindowMs > 0 ? { timeoutMs: Infinity } : undefined)

  let sendCalled = false
  // The page's Stop: the wait ends without the failure bookkeeping a cancel() would do.
  let stopped = false
  const send = () => {
    if (sendCalled) return
    sendCalled = true
    let sent = false
    try {
      sent = registry.send(nodeId, 'bot/turn', {
        nodeId,
        remoteBotId,
        exchangeId: turnId,
        text: text ?? '',
        // How a busy node Bot takes it (AC 0.4.20+; an older node ignores it and queues).
        ...(mode === 'steer' || mode === 'queue' ? { mode } : {}),
      })
    } catch (sendErr) {
      cancel()
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', `registry.send threw: ${sendErr?.message ?? sendErr}`)
    }

    if (sent !== true) {
      cancel()
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', 'node offline or send failed')
    }
  }

  const settle = async () => {
    let result
    try {
      result = await (lateWindowMs > 0 ? completion : pending)
    } catch {
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', 'listener error')
    }
    if (stopped || (lateWindowMs > 0 && result?.error === 'stopped')) {
      tracker?.finish(turnId, { status: 'failed', error: 'E_ABORTED' })
      throw new ExecutorError('E_ABORTED', 'stopped waiting for the node')
    }

    if (result === undefined) {
      tracker?.finish(turnId, { status: 'timeout', error: 'E_TIMEOUT' })
      throw new ExecutorError('E_TIMEOUT', `no result within ${timeoutMs}ms`)
    }
    if (!result || result.error === 'bridge-down') {
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', result?.error ?? 'bridge-down')
    }
    if (result.error === 'bot-turn-timeout') {
      tracker?.finish(turnId, { status: 'timeout', error: 'E_TIMEOUT' })
      throw new ExecutorError('E_TIMEOUT', 'no answer within the waiting window')
    }
    if (result.ok === false) {
      tracker?.finish(turnId, { status: 'failed', error: 'E_REJECTED' })
      throw new ExecutorError('E_REJECTED', result.error ?? 'bot-turn-rejected')
    }
    // Validate seq field (S2-1 contract: seq must be a non-negative integer)
    if (typeof result.seq !== 'number' || !Number.isInteger(result.seq) || result.seq < 0) {
      tracker?.finish(turnId, { status: 'failed', error: 'E_REJECTED' })
      throw new ExecutorError('E_REJECTED', result.error ?? 'bot-turn-result-seq-missing')
    }

    tracker?.finish(turnId, { status: 'done' })
    return { ok: true, turnId, text: result.text ?? '', nodeId, remoteBotId, seq: result.seq }

  }
  // A prepared turn that is dropped before send(): drop the listener and close the tracker.
  const abandon = () => { cancel(); tracker?.finish(turnId, { status: 'failed', error: 'E_ABANDONED' }) }
  // The user stopped waiting: drop the listener, make a pending settle() throw E_ABORTED (and
  // leave the tracker alone), close the tracker entry as stopped. The frame is already out —
  // the node is not told, and its answer can still come (awaitLate).
  const stop = () => {
    stopped = true
    cancel()
    tracker?.finish(turnId, { status: 'failed', error: 'E_ABORTED' })
  }
  // After settle() threw E_TIMEOUT the listener is gone, but the node may still finish and send
  // its bot/turn-result. This keeps listening for THIS exchange only, once, for `windowMs`;
  // `onResult(payload)` gets that result. If `onResult` returns `false` the payload was not
  // usable (e.g. an abort receipt with ok:false) and the listener stays open for the real
  // result that may arrive later. Returns the disposer (also called by the window's end).
  const awaitLate = (onResult, windowMs) => {
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      registry.off?.('botTurnResult', onEvent)
    }
    const onEvent = (payload) => {
      if (payload?.exchangeId !== turnId) return
      if (payload.nodeId && payload.nodeId !== nodeId) return
      if (onResult(payload) === false) return   // not usable — keep listening
      end()
    }
    const timer = setTimeout(end, windowMs)
    timer.unref?.()
    registry.on?.('botTurnResult', onEvent)
    return end
  }
  return { turnId, nodeId, remoteBotId, send, settle, cancel, abandon, stop, received, awaitLate }
}

async function sendLocal({ bot, text, rt, tracker }) {
  if (!rt.sendUser) throw new ExecutorError('E_NOT_FOUND', 'sendUser not available')
  const sessionId = rt.chatOf?.(bot.id) ?? bot.id
  const turnId = randomUUID()
  tracker?.start(turnId, bot.id)
  const run = async () => {
    try {
      await rt.sendUser({ sessionId, content: [{ type: 'text', text: text ?? '' }], requestId: turnId })
      tracker?.finish(turnId, { status: 'done' })
    } catch (err) {
      tracker?.finish(turnId, { status: 'failed', error: String(err?.code ?? err?.message ?? err) })
      throw err
    }
  }
  // One turn per Bot: a dispatch waits behind whatever that Bot is running (thread-model §4.5).
  if (typeof rt.sendThreadTurn === 'function') {
    const outcome = await rt.sendThreadTurn({
      botId: bot.id,
      sessionId,
      requestId: turnId,
      kind: 'send',
      preview: text ?? '',
      // A joined mirror and a peer shadow both hand off outside this host: the wait ends
      // when the hand-off is accepted, not when the far turn reports back.
      releaseOn: bot.origin === 'joined' || bot.origin === 'peer' ? 'run' : undefined,
      run,
    })
    if (outcome?.queued === true) return { ok: true, turnId, text: text ?? '', queued: true, position: outcome.position }
  } else {
    await run()
  }
  return { ok: true, turnId, text: text ?? '' }
}

/**
 * Full pipeline: send to remote bot + mirror the exchange into a local session.
 *
 * S2 contract for nodeSeq: bot/turn-result must carry `seq` (not yet in validateBotTurnResult).
 * Until S2 adds seq to the frame, nodeSeq is null (mirrorTurn skips idempotency).
 *
 * @param {object} opts
 * @param {string} opts.botId
 * @param {string} opts.text
 * @param {object} opts.rt
 * @param {object} opts.session       - store-owned DSH Session for mirror writes
 * @param {Set}    [opts.seenKeys]
 * @param {Set}    [opts.closedKeys]
 * @param {Set}    [opts.seenSteps]
 * @param {object} [opts.tracker]
 * @param {number} [opts.timeoutMs]
 * @returns {{ ok: true, turnId: string, mirrorResult: object }}
 */
export async function deliverTurn({ botId, text, rt, session, turn, step = 1, seenKeys, closedKeys, seenSteps, tracker, timeoutMs }) {
  // S2 dual-path note: executor.send and handleJoinedTurn are two separate remote dispatch paths.
  // In S2 these MUST converge into one path to prevent the same message being sent twice.
  // turn param is now optional — mirrorTurn allocates turn number from session.log directly.
  const result = await send({ botId, text, rt, tracker, timeoutMs })
  const mirrorResult = await mirrorTurn(session, {
    step,
    userText: text,
    botText: result.text,
    botId,
    nodeSeq: result.seq,   // S2-1: seq from bot/turn-result frame
    seenKeys,
    closedKeys,
    seenSteps,
  })
  return { ok: true, turnId: result.turnId, mirrorResult }
}

const FAILURE_WORDS = {
  E_OFFLINE: '节点离线或不可达',
  E_TIMEOUT: '等了很久，节点也没有回复（它若之后才回复，不会再自动补到这里）',
  E_REJECTED: '节点拒绝了这条消息',
  E_NOT_FOUND: '找不到这个远程 Bot',
  E_INVALID: '消息或 Bot 配置无效',
  E_BUSY: '上一条消息还在处理',
  E_MIRROR_WRITE: '消息没能写入页面，已取消发送',
}

/** The words the page shows after "⚠ 无法送达节点：" for a failed delivery. */
export function failureText(err) {
  const code = typeof err?.code === 'string' ? err.code : ''
  const detail = String(err?.message ?? err ?? '')
  const word = FAILURE_WORDS[code]
  if (word === undefined) return detail || 'unknown'
  return detail !== '' && detail !== code ? `${word}（${code}: ${detail}）` : `${word}（${code}）`
}

// ── A node answer that comes after the user stopped waiting on the page ──
//
// The turn was closed as aborted and the in-flight claim released, but the node is
// still working and its bot/turn-result arrives later. It is written as a new turn
// (mirrorLateReply). While another page turn of the same Bot is open the write waits: the new
// turn's number comes from allocateTurn, which would close that open turn as aborted.
function armLateReply({ rt, bot, session, state, prepared }) {
  if (typeof prepared.awaitLate !== 'function') return
  if (rt.joinedLateClosed === true) return   // the plugin was unloaded: nothing new is armed
  const windowMs = Number.isFinite(rt.joinedLateWindowMs) ? rt.joinedLateWindowMs : JOINED_LATE_WINDOW_MS
  const dispose = prepared.awaitLate((payload) => {
    if (payload?.ok === false || !Number.isInteger(payload?.seq) || payload.seq < 0 || typeof payload?.text !== 'string') {
      rt.warn?.('ds-bot: a late node result for Bot %s was not written (no usable reply or seq)', bot.id)
      return false   // keep listening — the real result may arrive later
    }
    rt.joinedLate?.delete(dispose)
    const write = () => {
      try {
        mirrorLateReply(session, { botText: payload.text, botId: bot.id, nodeSeq: payload.seq, ...state })
      } catch (error) {
        rt.warn?.('ds-bot: a late node reply for Bot %s was not written: %s', bot.id, error?.message ?? error)
      }
    }
    // A late answer writes a whole new turn (mirrorLateReply -> allocateTurn), so it must wait
    // for EITHER writer to finish: the page turn (joinedInFlight) or a Bot-to-Bot turn
    // (mirrorTurnOpen). Writing inside an open Bot-to-Bot turn would close it as interrupted and
    // leave the exchange's own finish to fail a strict restore.
    if (rt.joinedInFlight?.has(bot.id) || mirrorTurnOpen(rt, bot.id)) {
      if (!rt.joinedLateQueue) rt.joinedLateQueue = new Map()
      rt.joinedLateQueue.set(bot.id, [...(rt.joinedLateQueue.get(bot.id) ?? []), write])
    } else write()
  }, windowMs)
  if (!rt.joinedLate) rt.joinedLate = new Set()
  rt.joinedLate.add(dispose)
}

export function flushLateReplies(rt, botId) {
  const queued = rt.joinedLateQueue?.get(botId)
  if (queued && queued.length > 0) {
    if (rt.joinedInFlight?.has(botId) || mirrorTurnOpen(rt, botId)) return
    rt.joinedLateQueue.delete(botId)
    for (const write of queued) write()
  }
  // Drain queued user messages, ONE at a time: when a turn closes and no page turn is in flight, the next
  // waiting message starts as a page turn; the ones behind it stay queued and start when that turn is released
  // (starting several at once would make all but the first fail as busy and be lost).
  const userQueue = rt.joinedUserQueue?.get(botId)
  if (userQueue && userQueue.length > 0 && !rt.joinedInFlight?.has(botId) && !mirrorTurnOpen(rt, botId)) {
    const item = userQueue.shift()
    if (userQueue.length === 0) rt.joinedUserQueue.delete(botId)
    try {
      startPageTurn({ rt, bot: rt.botOf(botId), text: item.text, requestId: item.requestId, session: item.session, state: item.state ?? {}, tracker: rt.turnTracker, timeoutMs: rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS })
    } catch (err) {
      if (err?.code === 'E_BUSY') {
        // Something took the slot in between: keep its place at the front, the next release tries again.
        rt.joinedUserQueue.set(botId, [item, ...(rt.joinedUserQueue.get(botId) ?? [])])
      } else {
        rt.warn?.('ds-bot: queued user prompt for %s could not start: %s', botId, err?.message ?? err)
        void writeQueuedFailure(rt, botId, item, err)
      }
    }
  }
}

// A queued message that could not be started is said so on the page, not dropped with a log line.
async function writeQueuedFailure(rt, botId, item, err) {
  try {
    const bot = rt.botOf(botId)
    if (bot === undefined || item.session === undefined) return
    writeNodeReport({ rt, bot, session: item.session, state: item.state ?? {}, mark: '⚠ 没能发出', text: `排队的消息「${String(item.text).slice(0, 60)}」没能发给节点：${failureText(err)}` })
  } catch { /* nothing more to say */ }
}

// What the page already shows for a node Bot: a result that comes again — a background task report
// whose text is the answer a turn just delivered — is not shown twice.
const REMEMBER_MS = 600_000
export function rememberReply(rt, botId, text) {
  const body = String(text ?? '').trim()
  if (body === '') return
  const book = (rt._shownReplies ??= new Map())
  const list = (book.get(botId) ?? []).filter(item => Date.now() - item.at < REMEMBER_MS)
  list.push({ text: body, at: Date.now() })
  book.set(botId, list.slice(-12))
}
export function repliedAlready(rt, botId, text) {
  const body = String(text ?? '').trim()
  return body !== '' && (rt._shownReplies?.get(botId) ?? []).some(item => item.text === body && Date.now() - item.at < REMEMBER_MS)
}

/**
 * Start one turn that came from the Bot's page (S2-4 contract §2–§3).
 *
 *   Phase A  one turn per Bot: claim the in-flight table (E_BUSY if taken), then prepare the
 *            dispatch (validate, register the result listener) — synchronous, so a refusal
 *            throws here and the page has no half turn.
 *   Phase B  allocateTurn + mirrorTurnStart with no await between: the user's message is on
 *            the page (source.rpcId = requestId, so the client retires its echo). If Start
 *            cannot be written the turn is abandoned BEFORE anything is sent: a message the
 *            node got is always a message the page shows (E_MIRROR_WRITE).
 *   Phase C  the frame goes to the node. A node that does not take it (offline) fails the
 *            turn on the page — "⚠ 无法送达节点：…" and a turn/end carrying the code — and
 *            `done` rejects. Otherwise a delivery receipt is written immediately, and `done`
 *            waits in the background for Finish / rejection / disconnect / Stop. The soft
 *            deadline only appends progress; it never closes the turn as failed.
 *
 * Returns { turn, turnId, done }. `done` resolves { ok, turnId, mirrorResult } and rejects
 * (the same ExecutorError) after a Fail was written; the in-flight claim is released when it
 * settles.
 */
export function startPageTurn({ rt, bot, text, requestId, session, step = 1, state = {}, tracker, timeoutMs }) {
  if (!rt.joinedInFlight) rt.joinedInFlight = new Map()
  // A Bot-to-Bot exchange writing this Session must finish first; its writer is short-lived, the
  // page path waits for it (joined-prompt.js waitForJoinedMirror) before calling here.
  if (mirrorTurnOpen(rt, bot.id)) throw new ExecutorError('E_BUSY', 'a turn for this Bot is still in flight')
  if (rt.joinedInFlight.has(bot.id)) throw new ExecutorError('E_BUSY', 'a turn for this Bot is still in flight')
  const claim = { requestId, abort: undefined, startedAt: Date.now() }
  rt.joinedInFlight.set(bot.id, claim)
  // The page shows the Bot as running (and offers Stop) from the moment the user's message is
  // on the page until the slot is released (joined-running.js).
  let announced = false
  const release = () => {
    // Only the claim this turn took: a second release of an older turn (Stop releases, then the
    // turn's own finally does) must not free — or announce for — a newer turn of the same Bot,
    // even one carrying the same requestId.
    if (rt.joinedInFlight.get(bot.id) !== claim) return
    rt.joinedInFlight.delete(bot.id)
    if (announced) { announced = false; rt.joinedRunning?.(bot, false) }
    // Buffered Bot-to-Bot writes for this Bot become writable the moment the page turn is
    // released, in this same tick, before any late node reply is written.
    drainJoinedMirror(rt, bot.id)
    flushLateReplies(rt, bot.id)
  }

  let prepared
  try {
    const lateWindowMs = Number.isFinite(rt.joinedLateWindowMs) ? Math.max(1, rt.joinedLateWindowMs) : JOINED_LATE_WINDOW_MS
    prepared = prepareRemote({
      bot, text, rt, tracker, timeoutOverride: timeoutMs, lateWindowMs,
      onTimeout: () => markPending(PENDING_TURN_TEXT),
    })
  } catch (err) {
    release()
    throw err
  }

  const { seenKeys, closedKeys, seenSteps, closedTurns } = state
  let turn
  try {
    turn = allocateTurn(session)
    mirrorTurnStart(session, { turn, step, userText: text, rpcId: requestId })
  } catch (err) {
    prepared.abandon()
    release()
    throw new ExecutorError('E_MIRROR_WRITE', `page turn not written: ${err?.message ?? err}`)
  }
  announced = true
  rt.joinedRunning?.(bot, true)
  // Open on the page: a steer sent meanwhile is written into this turn, in the order it happened.
  Object.assign(claim, { turn, step, session })
  // The node's thinking and tool steps (bot/trace) are written into this turn while it runs; closeTrace() ends them
  // and says which step the closing message goes in (hub-trace.js). A node that cannot send them has no sink.
  const sink = openTraceSink(rt, { bot, exchangeId: prepared.turnId, nodeId: prepared.nodeId, binding: { session, turn, step, closedTurns } })
  const closeTrace = () => sink?.close() ?? { step }
  // The step the page turn is in now: a steer's answer written into this turn goes there (the steps moved it on).
  claim.currentStep = () => sink?.step() ?? step

  const fail = (err) => mirrorTurnFail(session, { turn, step, ...closeTrace(), code: err?.code, message: failureText(err), closedTurns })
  const markPending = text => {
    try { mirrorTurnPending(session, { turn, step: sink?.step() ?? step, text }) } catch (error) {
      rt.warn?.('ds-bot: a pending page turn for %s was not marked: %s', bot.id, error?.message ?? error)
    }
  }

  // The page's Stop (stopPageTurn): the turn ends as aborted with a line saying so, the
  // in-flight claim is released so the next message can go out at once, and the node's answer
  // — if it still comes — is written like any late reply. False when the turn is already over.
  let over = false
  const abort = () => {
    // The node's answer has already reached the wait (its settle() just has not run yet): the
    // answer is not thrown away — the turn is written as a normal one.
    if (over || prepared.received()) return false
    over = true
    prepared.stop()
    mirrorTurnAbort(session, { turn, step, ...closeTrace(), closedTurns })
    armLateReply({ rt, bot, session, state, prepared })
    release()
    return true
  }
  claim.abort = abort
  if (!rt.joinedLate) rt.joinedLate = new Set()
  const dispose = () => abort()
  rt.joinedLate.add(dispose)

  const done = (async () => {
    try {
      try {
        prepared.send()
      } catch (err) {
        over = true
        fail(err)
        throw err
      }
      // No 'delivered, running…' line on the page: the running state says it, as on a local Bot's page.
      let result
      try {
        result = await prepared.settle()
      } catch (err) {
        if (err?.code === 'E_ABORTED') {
          if (!over) { over = true; mirrorTurnAbort(session, { turn, step, ...closeTrace(), closedTurns }) }
          for (const groupSessionId of rt.groupSessionsOf?.(bot.id) ?? []) rt.failRoomTurn?.(groupSessionId, { code: 'ABORTED', message: 'stopped' })
          return { ok: false, aborted: true, turnId: prepared.turnId }
        }
        over = true
        // The link dropped after the node had the turn (its answer comes when it is back): say so, and
        // keep listening for that answer — it is written as a late reply when it arrives.
        const linkLost = err?.code === 'E_OFFLINE' && err?.message === 'bridge-down'
        if (linkLost) armLateReply({ rt, bot, session, state, prepared })
        mirrorTurnFail(session, { turn, step, ...closeTrace(), code: err?.code, message: linkLost ? LINK_LOST_TEXT : failureText(err), closedTurns })
        throw err
      }
      over = true
      rememberReply(rt, bot.id, result.text)
      const mirrorResult = mirrorTurnFinish(session, { turn, step, ...closeTrace(), botText: result.text, botId: bot.id, nodeSeq: result.seq, seenKeys, closedKeys, seenSteps, closedTurns })
      // A node that sent no thinking is said so on the page, once (hub-trace.js).
      noteTraceGap(rt, bot, sink, { session, state })
      // Notify group round waiters that the joined bot's turn has produced output.
      // turns.js does this via session/event which never fires for mirror sessions.
      for (const groupSessionId of rt.groupSessionsOf?.(bot.id) ?? []) rt.touchRoomTurn?.(groupSessionId)
      return { ok: true, turnId: prepared.turnId, mirrorResult }
    } finally {
      rt.joinedLate.delete(dispose)
      sink?.dispose()
      release()
    }
  })()
  // Both sendUser and the desktop prompt acknowledge dispatch before a result arrives.
  // Keep completion observed even when their callers no longer await it.
  if (!rt.joinedPromptTasks) rt.joinedPromptTasks = new Set()
  const task = done
    .catch(error => { rt.warn?.('ds-bot: joined Bot %s turn failed: %s', bot.id, error?.message ?? error) })
    .finally(() => { rt.joinedPromptTasks.delete(task) })
  rt.joinedPromptTasks.add(task)
  return { turn, turnId: prepared.turnId, done }
}

/**
 * The page's Stop on a joined Bot: end the open page turn (if any) so the Bot's next message
 * is not refused as in flight. Returns whether a turn was stopped.
 */
export function stopPageTurn(rt, botId) {
  let stopped = rt.joinedInFlight?.get(botId)?.abort?.() === true
  for (const side of [...(rt.joinedSide?.get(botId) ?? [])]) if (side.abort() === true) stopped = true
  return stopped
}

// How many page messages may run on one node Bot at the same time. One more is queued on the hub
// (rt.joinedUserQueue) and starts when a slot frees.
export const JOINED_SIDE_LIMIT = 4

/** Is anything of this joined Bot running on its node for the page (the main turn or a side turn)? */
export function joinedBusy(rt, botId) {
  return rt.joinedInFlight?.has(botId) === true || (rt.joinedSide?.get(botId)?.size ?? 0) > 0
}

/**
 * A page message to a node Bot that is already busy: it goes to the node at once, without waiting
 * for the turn in flight. The node runs it next to the other work (DS Bot 0.3.10 moves the busy
 * foreground into a background task and starts this one); an older node queues it on its side.
 *
 * The mirror Session holds one open turn, so a side turn is written whole when its answer arrives
 * (the user's message, then the reply), and it waits while a page turn or a Bot-to-Bot turn is open
 * — the same wait a late reply has (joinedLateQueue). Returns { turnId, done }; `done` resolves
 * { ok, turnId } and rejects with an ExecutorError when the node did not take the message.
 */
export function startSideTurn({ rt, bot, text, requestId, session, state = {}, tracker, timeoutMs, mode = 'steer' }) {
  if (!rt.joinedSide) rt.joinedSide = new Map()
  const sides = rt.joinedSide.get(bot.id) ?? new Set()
  if (sides.size >= JOINED_SIDE_LIMIT) throw new ExecutorError('E_BUSY', 'too many concurrent turns for this Bot')
  const lateWindowMs = Number.isFinite(rt.joinedLateWindowMs) ? Math.max(1, rt.joinedLateWindowMs) : JOINED_LATE_WINDOW_MS
  const prepared = prepareRemote({ bot, text, rt, tracker, timeoutOverride: timeoutMs, lateWindowMs, mode })
  const { seenKeys, closedKeys, seenSteps, closedTurns } = state
  const record = { requestId, abort: undefined }
  let over = false
  let announced = false
  // The page turn open right now (if any): the steer is written into it at once, where it happened.
  const openTurn = rt.joinedInFlight?.get(bot.id)
  const hostTurn = openTurn?.session === session && Number.isInteger(openTurn?.turn) ? openTurn : undefined
  let userWritten = false
  // A steer written as a turn of its own carries the node's thinking and tool steps inside that turn (hub-trace.js).
  // One that joins the page turn already open has none: that turn's own trace holds the node's events, the steer's too.
  const sink = hostTurn === undefined ? openTraceSink(rt, { bot, exchangeId: prepared.turnId, nodeId: prepared.nodeId }) : undefined

  const writeWhenFree = (write) => {
    if (rt.joinedLateClosed === true) return
    const guarded = () => {
      try { write() } catch (error) { rt.warn?.('ds-bot: a concurrent turn of Bot %s was not written: %s', bot.id, error?.message ?? error) }
    }
    if (rt.joinedInFlight?.has(bot.id) || mirrorTurnOpen(rt, bot.id)) {
      if (!rt.joinedLateQueue) rt.joinedLateQueue = new Map()
      rt.joinedLateQueue.set(bot.id, [...(rt.joinedLateQueue.get(bot.id) ?? []), guarded])
    } else guarded()
  }
  // `finish(turn, trace)`: trace is { step, reasoning } — where the closing message goes after the node's steps.
  const writeTurn = (finish) => writeWhenFree(() => {
    const turn = allocateTurn(session)
    mirrorTurnStart(session, { turn, step: 1, userText: text, rpcId: requestId })
    finish(turn, sink?.bindAndClose({ session, turn, step: 1, closedTurns }) ?? { step: 1 })
  })
  // The answer lands in the turn that is still open on the page (right after the steer it answers);
  // if that turn is over, it is a reply of its own (its question is already on the page).
  const answerInline = (answer, mark) => {
    if (!userWritten) return false
    sink?.dispose()
    const stillOpen = rt.joinedInFlight?.get(bot.id) === hostTurn
    if (stillOpen) {
      try { mirrorTurnPending(session, { turn: hostTurn.turn, step: hostTurn.currentStep?.() ?? hostTurn.step, text: answer }); return true } catch { /* falls back below */ }
    }
    writeWhenFree(() => mirrorLateReply(session, { botText: answer, botId: bot.id, mark, closedTurns }))
    return true
  }
  const release = () => {
    sides.delete(record)
    if (sides.size === 0) rt.joinedSide.delete(bot.id)
    if (announced) {
      announced = false
      if (!joinedBusy(rt, bot.id)) rt.joinedRunning?.(bot, false)
    }
    flushLateReplies(rt, bot.id)
  }
  sides.add(record)
  rt.joinedSide.set(bot.id, sides)
  announced = true
  rt.joinedRunning?.(bot, true)
  if (hostTurn !== undefined) {
    try {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } }), { surfaceOp: 'append' })
      userWritten = true
    } catch (error) { rt.warn?.('ds-bot: a steer to %s was not shown on the page: %s', bot.id, error?.message ?? error) }
  }

  record.abort = () => {
    if (over || prepared.received()) return false
    over = true
    prepared.stop()
    if (!userWritten) writeTurn((turn, trace) => mirrorTurnAbort(session, { turn, step: trace.step, reasoning: trace.reasoning, closedTurns }))
    // The node was told to stop, but if it still answers (the work was past the point of no return) the answer
    // is written as a late reply, as for the page turn.
    armSideLateReply()
    release()
    return true
  }
  // The answer to a steer that arrives after the page stopped waiting for it (Stop, or a lost link).
  const armSideLateReply = () => {
    if (typeof prepared.awaitLate !== 'function' || rt.joinedLateClosed === true) return
    const windowMs = Number.isFinite(rt.joinedLateWindowMs) ? rt.joinedLateWindowMs : JOINED_LATE_WINDOW_MS
    const end = prepared.awaitLate((payload) => {
      if (payload?.ok === false || typeof payload?.text !== 'string') return false
      rt.joinedLate?.delete(end)
      // The same turn may have answered the page's own message with these words already: shown once.
      if (repliedAlready(rt, bot.id, payload.text)) return true
      rememberReply(rt, bot.id, payload.text)
      writeWhenFree(() => mirrorLateReply(session, { botText: payload.text, botId: bot.id, mark: STEER_REPLY_MARK, closedTurns }))
      return true
    }, windowMs)
    if (!rt.joinedLate) rt.joinedLate = new Set()
    rt.joinedLate.add(end)
  }
  if (!rt.joinedLate) rt.joinedLate = new Set()
  const dispose = () => record.abort()
  rt.joinedLate.add(dispose)

  const done = (async () => {
    try {
      try {
        prepared.send()
      } catch (error) {
        over = true
        // The steer never left: the page was told it was accepted and its message is on the page, so say what
        // happened on the page instead of leaving a question that nobody will ever answer.
        if (!answerInline(`⚠ 无法送达节点：${failureText(error)}`, STEER_REPLY_MARK)) writeTurn((turn, trace) => mirrorTurnFail(session, { turn, step: trace.step, reasoning: trace.reasoning, code: error?.code, message: failureText(error), closedTurns }))
        throw error
      }
      let result
      try {
        result = await prepared.settle()
      } catch (error) {
        if (error?.code === 'E_ABORTED') return { ok: false, aborted: true, turnId: prepared.turnId }
        over = true
        // A link lost after the node had the steer is not a failure: its answer is still waited for.
        if (error?.code === 'E_OFFLINE' && error?.message === 'bridge-down') armSideLateReply()
        if (!answerInline(`⚠ 无法送达节点：${failureText(error)}`, STEER_REPLY_MARK)) writeTurn((turn, trace) => mirrorTurnFail(session, { turn, step: trace.step, reasoning: trace.reasoning, code: error?.code, message: failureText(error), closedTurns }))
        throw error
      }
      over = true
      rememberReply(rt, bot.id, result.text)
      if (!answerInline(result.text, STEER_REPLY_MARK)) {
        writeTurn((turn, trace) => {
          mirrorTurnFinish(session, { turn, step: trace.step, reasoning: trace.reasoning, botText: result.text, botId: bot.id, nodeSeq: result.seq, seenKeys, closedKeys, seenSteps, closedTurns })
          noteTraceGap(rt, bot, sink, { session, state })
        })
      }
      return { ok: true, turnId: prepared.turnId }
    } finally {
      rt.joinedLate.delete(dispose)
      release()
    }
  })()
  if (!rt.joinedPromptTasks) rt.joinedPromptTasks = new Set()
  const task = done
    .catch(error => { rt.warn?.('ds-bot: concurrent joined Bot %s turn failed: %s', bot.id, error?.message ?? error) })
    .finally(() => { rt.joinedPromptTasks.delete(task) })
  rt.joinedPromptTasks.add(task)
  return { turnId: prepared.turnId, done }
}

/**
 * A node Bot's background task finished after the turn that asked for it was answered, and the
 * Bot's answer about it reached the hub as a bot/message. It is written to the page as a turn of
 * its own (marked), after any turn that is open — the same wait a late reply has.
 */
export function writeNodeReport({ rt, bot, session, state = {}, text, mark = TASK_RESULT_MARK }) {
  if (rt.joinedLateClosed === true) return false
  const write = () => {
    try {
      mirrorLateReply(session, { botText: text, botId: bot.id, mark, closedTurns: state.closedTurns })
    } catch (error) {
      rt.warn?.('ds-bot: a background task result of Bot %s was not written: %s', bot.id, error?.message ?? error)
    }
  }
  return deferMirrorWrite(rt, bot.id, write)
}
