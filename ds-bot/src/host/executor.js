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
import { joinedShadow } from './roster-join.js'
import { listenBotTurnResult, JOINED_TURN_TIMEOUT_MS, JOINED_LATE_WINDOW_MS } from './joined-turn.js'
import { mirrorTurn, allocateTurn, mirrorTurnStart, mirrorTurnFinish, mirrorTurnFail, mirrorTurnAbort, mirrorLateReply } from './mirror.js'
import { drainJoinedMirror, mirrorTurnOpen } from './joined-mirror-writer.js'

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
function prepareRemote({ bot, text, rt, tracker, timeoutOverride }) {
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
  const { pending, cancel, received } = listenBotTurnResult(registry, turnId, nodeId, timeoutMs)

  tracker?.start(turnId, bot.id)

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
      result = await pending
    } catch {
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', 'listener error')
    }
    if (stopped) throw new ExecutorError('E_ABORTED', 'stopped waiting for the node')

    if (result === undefined) {
      tracker?.finish(turnId, { status: 'timeout', error: 'E_TIMEOUT' })
      throw new ExecutorError('E_TIMEOUT', `no result within ${timeoutMs}ms`)
    }
    if (!result || result.error === 'bridge-down') {
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', result?.error ?? 'bridge-down')
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
  E_TIMEOUT: '等待节点回复超时（节点完成后，回复会补到这里）',
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

// ── A node answer that comes after the page turn already ended with E_TIMEOUT ──
//
// The turn was closed with "⚠ …E_TIMEOUT" and the in-flight claim released, but the node is
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
  if (!queued || queued.length === 0) return
  // Woken by the Bot-to-Bot writer closing a turn: another queued exchange may have opened the
  // next turn in the same drain, so re-check both writers instead of writing blindly.
  if (rt.joinedInFlight?.has(botId) || mirrorTurnOpen(rt, botId)) return
  rt.joinedLateQueue.delete(botId)
  for (const write of queued) write()
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
 *            `done` rejects. Otherwise `done` waits for the node, then writes Finish — or
 *            Fail on timeout / rejection.
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
    prepared = prepareRemote({ bot, text, rt, tracker, timeoutOverride: timeoutMs })
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

  const fail = (err) => mirrorTurnFail(session, { turn, step, code: err?.code, message: failureText(err), closedTurns })

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
    mirrorTurnAbort(session, { turn, step, closedTurns })
    armLateReply({ rt, bot, session, state, prepared })
    release()
    return true
  }
  claim.abort = abort

  const done = (async () => {
    try {
      try {
        prepared.send()
      } catch (err) {
        over = true
        fail(err)
        throw err
      }
      let result
      try {
        result = await prepared.settle()
      } catch (err) {
        if (err?.code === 'E_ABORTED') return { ok: false, aborted: true, turnId: prepared.turnId }
        over = true
        fail(err)
        if (err?.code === 'E_TIMEOUT') armLateReply({ rt, bot, session, state, prepared })
        throw err
      }
      over = true
      const mirrorResult = mirrorTurnFinish(session, { turn, step, botText: result.text, botId: bot.id, nodeSeq: result.seq, seenKeys, closedKeys, seenSteps, closedTurns })
      return { ok: true, turnId: prepared.turnId, mirrorResult }
    } finally {
      release()
    }
  })()
  return { turn, turnId: prepared.turnId, done }
}

/**
 * The page's Stop on a joined Bot: end the open page turn (if any) so the Bot's next message
 * is not refused as in flight. Returns whether a turn was stopped.
 */
export function stopPageTurn(rt, botId) {
  return rt.joinedInFlight?.get(botId)?.abort?.() === true
}
