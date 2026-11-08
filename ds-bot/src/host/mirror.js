// mirror.js — write remote bot/turn results into a local mirror Session.
// The session is store-owned; writes go through session.append ONLY.
// No followup / steer / sendUser / sessionController.prompt.
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'

/** Sentinel reason for a mirrored turn */
const MIRROR_REASON = { kind: 'completed', source: 'mirror' }

/**
 * Write one remote exchange into the mirror session.
 *
 * Idempotency:
 *   - (botId, nodeSeq): skip if already seen — caller maintains the seenNodeSeqs Set
 *   - (turn, step): skip assistant/message if already present — checked against seen pairs
 *
 * @param {object} session   - A store-owned DSH Session (session.append is available)
 * @param {object} opts
 * @param {number}  opts.turn      - Logical turn number (integer ≥ 1)
 * @param {string}  opts.userText  - The user message text
 * @param {string}  opts.botText   - The assistant reply text
 * @param {string}  [opts.botId]   - The joined shadow bot id (for logging)
 * @param {number}  [opts.nodeSeq] - Remote node sequence number (for idempotency check)
 * @param {Set}     [opts.seenKeys]- Caller-owned Set<string> of "botId:nodeSeq" already written
 * @param {Set}     [opts.seenSteps] - Caller-owned Set<string> of "turn:step" already written
 * @param {object}  [opts.usage]   - Optional usage metadata from node (tokens etc)
 * @returns {{ skipped: boolean, reason?: string }}
 */
export async function mirrorTurn(session, opts = {}) {
  const { turn, userText, botText, botId, nodeSeq, seenKeys, seenSteps, usage } = opts

  // (botId, nodeSeq) idempotency
  if (botId != null && nodeSeq != null && seenKeys instanceof Set) {
    const key = `${botId}:${nodeSeq}`
    if (seenKeys.has(key)) return { skipped: true, reason: 'already-written:nodeSeq' }
    seenKeys.add(key)
  }

  // (turn, step) idempotency guard
  const stepKey = `${turn}:1`
  if (seenSteps instanceof Set) {
    if (seenSteps.has(stepKey)) return { skipped: true, reason: 'already-written:step' }
    seenSteps.add(stepKey)
  }

  const turnInt = typeof turn === 'number' && Number.isInteger(turn) ? turn : 1

  // Step 1: turn/start
  session.append('turn/start', { turn: turnInt })

  // Step 2: user/message — data IS the message object (not wrapped in {turn, message})
  const userMsg = createUserMessage({
    content: [{ type: 'text', text: String(userText ?? '') }],
    source: { kind: 'user' },
  })
  session.append('user/message', userMsg, { surfaceOp: 'append' })

  // Step 3: assistant/message — data is {turn, step, message, ...usage}
  const botMsg = createAssistantMessage({
    content: [{ type: 'text', text: String(botText ?? '') }],
    source: { kind: 'model' },
  })
  session.append('assistant/message', {
    turn: turnInt,
    step: 1,
    message: botMsg,
    ...(usage ?? {}),
  }, { surfaceOp: 'append' })

  // Step 4: turn/end — always in finally semantics (caller wraps in try/finally if needed)
  session.append('turn/end', { turn: turnInt, reason: MIRROR_REASON })

  return { skipped: false }
}

/**
 * Write turn/end for a turn that was started but did not complete (error path).
 * @param {object} session
 * @param {number} turn
 * @param {string} [errorMessage]
 */
export function mirrorTurnEnd(session, turn, errorMessage) {
  const reason = errorMessage
    ? { kind: 'error', message: String(errorMessage) }
    : { kind: 'aborted' }
  session.append('turn/end', { turn, reason })
}
