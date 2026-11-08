// executor.js — dispatch a text message to a bot (remote joined or local).
// send({ botId, text, rt }) → { ok: true, turnId } | throws with code
import { randomUUID } from 'node:crypto'
import { joinedShadow } from './roster-join.js'
import { listenBotTurnResult, JOINED_TURN_TIMEOUT_MS } from './joined-turn.js'

/**
    // KNIFE: removed check
 *   E_REJECTED — node explicitly rejected the turn (ok:false with error code)
 */
export class ExecutorError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.code = code
    this.name = 'ExecutorError'
  }
}

/**
 * Send text to a bot.
 *
 * For remote joined bots: sends bot/turn via registry, waits for bot/turn-result.
 * For local bots: calls rt.sendUser to the bot's session.
 *
 * @param {object} opts
 * @param {string} opts.botId   - The bot id (shadow id for joined, session/bot id for local)
 * @param {string} opts.text    - Message text
 * @param {object} opts.rt      - Runtime object
 * @param {number} [opts.timeoutMs] - Override timeout (default JOINED_TURN_TIMEOUT_MS)
 * @returns {{ ok: true, turnId: string }}
 * @throws {ExecutorError}
 */
export async function send({ botId, text, rt, timeoutMs: timeoutOverride }) {
  const bot = rt.botOf?.(botId)
  if (!bot) throw new ExecutorError('E_REJECTED', `bot not found: ${botId}`)

  if (joinedShadow(bot)) {
    return await sendRemote({ bot, text, rt, timeoutOverride })
  }
  return await sendLocal({ bot, text, rt })
}

async function sendRemote({ bot, text, rt, timeoutOverride }) {
  const nodeId = bot.worker?.nodeId
  const remoteBotId = bot.worker?.remoteBotId
  if (!nodeId || !remoteBotId) {
    throw new ExecutorError('E_REJECTED', 'joined shadow missing nodeId/remoteBotId')
  }

  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch {}
  if (!registry || typeof registry.send !== 'function') {
    throw new ExecutorError('E_OFFLINE', 'registry unavailable')
  }

  const turnId = randomUUID()
  const timeoutMs = Number.isFinite(timeoutOverride) ? timeoutOverride : (rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS)
  const { pending, cancel } = listenBotTurnResult(registry, turnId, nodeId, timeoutMs)

  const sent = registry.send(nodeId, 'bot/turn', {
    nodeId,
    remoteBotId,
    exchangeId: turnId,
    text: text ?? '',
  })

  if (sent !== true) {
    cancel()
    throw new ExecutorError('E_OFFLINE', 'node offline or send failed')
  }

  const result = await pending

  if (result === undefined) {
    throw new ExecutorError('E_TIMEOUT', `no result within ${timeoutMs}ms`)
  }
  if (!result || result.error === 'bridge-down') {
    throw new ExecutorError('E_OFFLINE', result?.error ?? 'bridge-down')
  }
  if (result.ok === false) {
    throw new ExecutorError('E_REJECTED', result.error ?? 'bot-turn-rejected')
  }

  return { ok: true, turnId }
}

async function sendLocal({ bot, text, rt }) {
  if (!rt.sendUser) throw new ExecutorError('E_REJECTED', 'sendUser not available')
  const sessionId = rt.chatOf?.(bot.id) ?? bot.id
  const turnId = randomUUID()
  await rt.sendUser({ sessionId, content: [{ type: 'text', text: text ?? '' }], requestId: turnId })
  return { ok: true, turnId }
}
