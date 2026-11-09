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
import { listenBotTurnResult, JOINED_TURN_TIMEOUT_MS } from './joined-turn.js'
import { mirrorTurn, allocateTurn, mirrorTurnStart, mirrorTurnFinish, mirrorTurnFail } from './mirror.js'

/**
 * Error codes thrown by send() / deliverTurn():
 *   E_NOT_FOUND — bot not registered or missing worker config
 *   E_OFFLINE   — remote node is not reachable or registry unavailable
 *   E_TIMEOUT   — no result within timeout (default 120s)
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
  const { pending, cancel } = listenBotTurnResult(registry, turnId, nodeId, timeoutMs)

  tracker?.start(turnId, bot.id)

  let sendCalled = false
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
  return { turnId, nodeId, remoteBotId, send, settle, cancel, abandon }
}

async function sendLocal({ bot, text, rt, tracker }) {
  if (!rt.sendUser) throw new ExecutorError('E_NOT_FOUND', 'sendUser not available')
  const sessionId = rt.chatOf?.(bot.id) ?? bot.id
  const turnId = randomUUID()
  tracker?.start(turnId, bot.id)
  try {
    await rt.sendUser({ sessionId, content: [{ type: 'text', text: text ?? '' }], requestId: turnId })
    tracker?.finish(turnId, { status: 'done' })
    return { ok: true, turnId, text: text ?? '' }
  } catch (err) {
    tracker?.finish(turnId, { status: 'failed', error: String(err?.code ?? err?.message ?? err) })
    throw err
  }
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
  E_TIMEOUT: '等待节点回复超时',
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
  if (rt.joinedInFlight.has(bot.id)) throw new ExecutorError('E_BUSY', 'a turn for this Bot is still in flight')
  rt.joinedInFlight.set(bot.id, { requestId })
  const release = () => { if (rt.joinedInFlight.get(bot.id)?.requestId === requestId) rt.joinedInFlight.delete(bot.id) }

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

  const fail = (err) => mirrorTurnFail(session, { turn, step, code: err?.code, message: failureText(err), closedTurns })

  const done = (async () => {
    try {
      try {
        prepared.send()
      } catch (err) {
        fail(err)
        throw err
      }
      let result
      try {
        result = await prepared.settle()
      } catch (err) {
        fail(err)
        throw err
      }
      const mirrorResult = mirrorTurnFinish(session, { turn, step, botText: result.text, botId: bot.id, nodeSeq: result.seq, seenKeys, closedKeys, seenSteps, closedTurns })
      return { ok: true, turnId: prepared.turnId, mirrorResult }
    } finally {
      release()
    }
  })()
  return { turn, turnId: prepared.turnId, done }
}
