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
 *   - (botId, nodeSeq): skip if already seen — caller maintains the seenKeys Set
 *   - (turn, step): skip assistant/message if already present — checked against seenSteps
 *
 * Accounting is done AFTER each successful append so that a throw on step N
 * does not permanently block a retry from completing step N.
 *
 * turn/end is written in a finally block so it is always emitted on the way out,
 * whether steps 2-3 succeed or throw.
 *
 * @param {object} session    - A store-owned DSH Session (session.append is available)
 * @param {object} opts
 * @param {number}  opts.turn      - Logical turn number (integer ≥ 1)
 * @param {number}  [opts.step]    - Step within the turn (default 1); used as idempotency key
 * @param {string}  opts.userText  - The user message text
 * @param {string}  opts.botText   - The assistant reply text
 * @param {string}  [opts.botId]   - The joined shadow bot id (for logging)
 * @param {number}  [opts.nodeSeq] - Remote node sequence number (for idempotency check)
 * @param {Set}     [opts.seenKeys]  - Caller-owned Set<string> of "botId:nodeSeq" already written
 * @param {Set}     [opts.seenSteps] - Caller-owned Set<string> of "turn:step" already written
 * @param {object}  [opts.usage]   - Optional usage metadata from node (tokens etc)
 * @returns {{ skipped: boolean, reason?: string }}
 */
export async function mirrorTurn(session, opts = {}) {
  const { turn, step = 1, userText, botText, botId, nodeSeq, seenKeys, seenSteps, usage } = opts

  // (botId, nodeSeq) idempotency — check BEFORE writing, account AFTER
  const nodeKey = (botId != null && nodeSeq != null && seenKeys instanceof Set)
    ? `${botId}:${nodeSeq}` : null
  if (nodeKey !== null && seenKeys.has(nodeKey)) {
    return { skipped: true, reason: 'already-written:nodeSeq' }
  }

  // (turn, step) idempotency — check BEFORE writing, account AFTER
  const stepKey = `${turn}:${step}`
  if (seenSteps instanceof Set && seenSteps.has(stepKey)) {
    return { skipped: true, reason: 'already-written:step' }
  }

  const turnInt = typeof turn === 'number' && Number.isInteger(turn) ? turn : 1

  // Step 1: turn/start
  session.append('turn/start', { turn: turnInt })

  try {
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
      step,
      message: botMsg,
      ...(usage ?? {}),
    }, { surfaceOp: 'append' })

    // Account AFTER successful writes (so a throw on step N allows retry)
    if (nodeKey !== null) seenKeys.add(nodeKey)
    if (seenSteps instanceof Set) seenSteps.add(stepKey)
  } finally {
    // Step 4: turn/end — always written, even if steps 2-3 throw
    session.append('turn/end', { turn: turnInt, reason: MIRROR_REASON })
  }

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
