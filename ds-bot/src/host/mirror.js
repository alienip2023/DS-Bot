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
