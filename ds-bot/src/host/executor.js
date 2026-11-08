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
import { mirrorTurn } from './mirror.js'

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
    return await sendRemote({ bot, text, rt, tracker, timeoutOverride })
  }
  return await sendLocal({ bot, text, rt, tracker })
}

async function sendRemote({ bot, text, rt, tracker, timeoutOverride }) {
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
