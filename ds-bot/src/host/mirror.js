// mirror.js — write remote bot/turn results into a local mirror Session.
// The session is store-owned; writes go through session.append ONLY.
// No followup / steer / sendUser / sessionController.prompt.
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'

const MIRROR_PROVIDER = 'mirror'
const MIRROR_MODEL = 'mirror-proxy'

export async function mirrorTurn(session, opts = {}) {
  const { turn, step = 1, userText, botText, botId, nodeSeq, seenKeys, closedKeys, seenSteps, usage } = opts

  const nodeKey = (botId != null && nodeSeq != null && seenKeys instanceof Set)
    ? String(botId) + ':' + String(nodeSeq) : null

  if (nodeKey !== null && seenKeys.has(nodeKey)) {
    return { skipped: true, reason: 'already-written:nodeSeq' }
  }
  if (nodeKey !== null && closedKeys instanceof Set && closedKeys.has(nodeKey)) {
    return { skipped: true, reason: 'already-closed' }
  }

  const stepKey = turn + ':' + step
  if (seenSteps instanceof Set && seenSteps.has(stepKey)) {
    return { skipped: true, reason: 'already-written:step' }
  }

  const turnInt = typeof turn === 'number' && Number.isInteger(turn) ? turn : 1

  session.append('turn/start', { turn: turnInt })

  try {
    session.append('step/start', { turn: turnInt, step })
    let stepEnded = false

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: String(userText ?? '') }],
      source: { kind: 'user' },
    })
    session.append('user/message', userMsg, { surfaceOp: 'append' })

    const botMsg = createAssistantMessage({
      content: [{ type: 'text', text: String(botText ?? '') }],
      source: { kind: 'model', provider: MIRROR_PROVIDER, model: MIRROR_MODEL },
    })
    session.append('assistant/message', {
      turn: turnInt,
      step,
      message: botMsg,
      ...(usage ?? {}),
    }, { surfaceOp: 'append' })

    session.append('step/end', { turn: turnInt, step })
    stepEnded = true

    session.append('turn/end', { turn: turnInt, reason: { kind: 'completed' } })

    if (nodeKey !== null) seenKeys.add(nodeKey)
    if (nodeKey !== null && closedKeys instanceof Set) closedKeys.add(nodeKey)
    if (seenSteps instanceof Set) seenSteps.add(stepKey)

  } catch (err) {
    // stepEnded guards against a double step/end if the error occurred on or after step/end
    try { if (!stepEnded) session.append('step/end', { turn: turnInt, step }) } catch {}
    try {
      session.append('turn/end', {
        turn: turnInt,
        reason: { kind: 'error', error: { message: String(err?.message ?? err) } },
      })
    } catch {}
    if (nodeKey !== null && closedKeys instanceof Set) closedKeys.add(nodeKey)
    throw err
  }

  return { skipped: false }
}

export function mirrorTurnEnd(session, turn, errorMessage) {
  const reason = errorMessage
    ? { kind: 'error', error: { message: String(errorMessage) } }
    : { kind: 'aborted' }
  session.append('turn/end', { turn, reason })
}

/**
 * Ensure a mirror Session exists for a joined Bot.
 * If bot.sessionId is already set, resolves and returns the existing Session.
 * If not, creates a new Session, updates bot.sessionId + bySessionId index, saves, then returns.
 *
 * @param {object} rt
 * @param {object} bot  - raw state.bots entry (mutable)
 * @returns {Promise<object>}  store-owned Session
 * @throws {Error} with code 'no-session' on any failure
 */
export async function ensureMirrorSession(rt, bot) {
  if (typeof bot?.sessionId === 'string' && bot.sessionId !== '') {
    try {
      const agent = await rt.resolveAgent(bot.sessionId)
      return agent.session
    } catch (err) {
      throw Object.assign(new Error('mirror session resume failed: ' + (err?.message ?? err)), { code: 'no-session' })
    }
  }

  let sessionId
  try {
    sessionId = await rt.createSession(bot.id + ' (mirror)')
  } catch (err) {
    throw Object.assign(new Error('mirror session creation failed: ' + (err?.message ?? err)), { code: 'no-session' })
  }

  if (typeof sessionId !== 'string' || sessionId === '') {
    throw Object.assign(new Error('mirror session creation returned no id'), { code: 'no-session' })
  }

  const oldSessionId = typeof bot.sessionId === 'string' ? bot.sessionId : null
  bot.sessionId = sessionId
  rt.updateBySessionId?.(bot.id, oldSessionId, sessionId)
  await rt.save?.()

  // S2-3 will implement importHistory(session, items, opts) to pull node history.

  try {
    const agent = await rt.resolveAgent(sessionId)
    return agent.session
  } catch (err) {
    throw Object.assign(new Error('mirror session resolve failed: ' + (err?.message ?? err)), { code: 'no-session' })
  }
}
