// mirror.js — write remote bot/turn results into a local mirror Session.
// The session is store-owned; writes go through session.append ONLY.
// No followup / steer / sendUser / sessionController.prompt.
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'

const MIRROR_PROVIDER = 'mirror'
const MIRROR_MODEL = 'mirror-proxy'

/**
 * Allocate the next turn number from session.log.
 * Reads already-committed events, finds the last turn/end, and returns max+1.
 * If there is an unclosed turn (turn/start without matching turn/end), closes
 * it first with reason {kind:'aborted'} before returning the next number.
 * Always returns an integer >= 1.
 */
export function allocateTurn(session) {
  const log = Array.isArray(session?.log) ? session.log : []
  let maxClosedTurn = 0
  let openTurn = null

  for (const ev of log) {
    if (ev?.type === 'turn/start') {
      openTurn = ev.data?.turn ?? null
    } else if (ev?.type === 'turn/end') {
      const t = ev.data?.turn
      if (typeof t === 'number') maxClosedTurn = Math.max(maxClosedTurn, t)
      openTurn = null
    }
  }

  if (openTurn !== null) {
    // Close the dangling turn before opening a new one
    session.append('turn/end', { turn: openTurn, reason: { kind: 'aborted' } })
    return openTurn + 1
  }

  return maxClosedTurn + 1
}

export async function mirrorTurn(session, opts = {}) {
  const { step = 1, userText, botText, botId, nodeSeq, seenKeys, closedKeys, seenSteps, usage } = opts

  const nodeKey = (botId != null && nodeSeq != null && seenKeys instanceof Set)
    ? String(botId) + ':' + String(nodeSeq) : null

  if (nodeKey !== null && seenKeys.has(nodeKey)) {
    return { skipped: true, reason: 'already-written:nodeSeq' }
  }
  if (nodeKey !== null && closedKeys instanceof Set && closedKeys.has(nodeKey)) {
    return { skipped: true, reason: 'already-closed' }
  }

  // Allocate turn from session.log — never trust caller-supplied turn number.
  const turnInt = allocateTurn(session)
  const stepKey = turnInt + ':' + step

  if (seenSteps instanceof Set && seenSteps.has(stepKey)) {
    return { skipped: true, reason: 'already-written:step' }
  }

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
      stream: [],   // required by dsh-session assertAssistantSettlementShape
      ...(usage ?? {}),
    }, { surfaceOp: 'append' })

    session.append('step/end', { turn: turnInt, step })
    stepEnded = true

    session.append('turn/end', { turn: turnInt, reason: { kind: 'completed' } })

    if (nodeKey !== null) seenKeys.add(nodeKey)
    if (nodeKey !== null && closedKeys instanceof Set) closedKeys.add(nodeKey)
    if (seenSteps instanceof Set) seenSteps.add(stepKey)

  } catch (err) {
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

// ── Page-origin turn: the user's message lands first, the node's answer later ──
//
// mirrorTurn above writes a whole exchange after the node answered. A message typed on a
// joined Bot's page must show at once and must end visibly when the node never answers, so
// the same events are written through three entry points (S2-4 contract). These and
// mirrorTurn are the only writers; the caller allocates `turn` with allocateTurn() and
// calls mirrorTurnStart with NO await in between (Session.append is synchronous, so two
// concurrent calls could otherwise take the same turn).

const mirrorSource = { kind: 'model', provider: MIRROR_PROVIDER, model: MIRROR_MODEL }

/**
 * turn/start, step/start, user/message. `rpcId` is the prompt's requestId: the client
 * retires its local echo only on a user/message whose source carries it (client.js
 * observeSubmissionMessage); imported history has no requestId and omits it.
 */
export function mirrorTurnStart(session, { turn, step = 1, userText, rpcId } = {}) {
  session.append('turn/start', { turn })
  try {
    session.append('step/start', { turn, step })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: String(userText ?? '') }],
      source: rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId },
    }), { surfaceOp: 'append' })
  } catch (err) {
    try { session.append('turn/end', { turn, reason: { kind: 'error', error: { message: String(err?.message ?? err) } } }) } catch {}
    throw err
  }
}

function appendAssistant(session, turn, step, text, usage) {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({ content: [{ type: 'text', text: String(text ?? '') }], source: mirrorSource }),
    stream: [],   // required by dsh-session assertAssistantSettlementShape
    ...(usage ?? {}),
  }, { surfaceOp: 'append' })
}

/**
 * assistant/message, step/end, turn/end completed. A node result already written
 * ((botId,nodeSeq) in seenKeys/closedKeys) still closes the turn — as aborted, without a
 * second answer. `closedTurns` guarantees exactly one turn/end per Start.
 */
export function mirrorTurnFinish(session, { turn, step = 1, botText, botId, nodeSeq, seenKeys, closedKeys, seenSteps, closedTurns, usage } = {}) {
  if (closedTurns instanceof Set && closedTurns.has(turn)) return { skipped: true, reason: 'already-closed:turn' }
  const nodeKey = (botId != null && nodeSeq != null && seenKeys instanceof Set) ? String(botId) + ':' + String(nodeSeq) : null
  const duplicate = nodeKey !== null && (seenKeys.has(nodeKey) || (closedKeys instanceof Set && closedKeys.has(nodeKey)))
  if (duplicate) {
    try { session.append('step/end', { turn, step }) } catch {}
    try { session.append('turn/end', { turn, reason: { kind: 'aborted' } }) } catch {}
    if (closedTurns instanceof Set) closedTurns.add(turn)
    return { skipped: true, reason: 'already-written:nodeSeq' }
  }
  try {
    appendAssistant(session, turn, step, botText, usage)
    session.append('step/end', { turn, step })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  } catch (err) {
    mirrorTurnFail(session, { turn, step, code: 'E_MIRROR_WRITE', message: err?.message ?? err, visible: false, closedTurns })
    throw err
  }
  if (closedTurns instanceof Set) closedTurns.add(turn)
  if (nodeKey !== null) {
    seenKeys.add(nodeKey)
    if (closedKeys instanceof Set) closedKeys.add(nodeKey)
  }
  if (seenSteps instanceof Set) seenSteps.add(turn + ':' + step)
  return { skipped: false }
}

/**
 * A visible assistant message "⚠ 无法送达节点：<message>", then step/end and
 * turn/end {kind:'error', error:{message, code}}, so the turn never stays open.
 * `visible:false` only closes (used when the write itself failed).
 */
export function mirrorTurnFail(session, { turn, step = 1, code, message, visible = true, closedTurns } = {}) {
  if (closedTurns instanceof Set && closedTurns.has(turn)) return { skipped: true, reason: 'already-closed:turn' }
  const text = String(message ?? 'unknown')
  if (visible) { try { appendAssistant(session, turn, step, `⚠ 无法送达节点：${text}`) } catch {} }
  try { session.append('step/end', { turn, step }) } catch {}
  try { session.append('turn/end', { turn, reason: { kind: 'error', error: { message: text, ...(code === undefined ? {} : { code }) } } }) } catch {}
  if (closedTurns instanceof Set) closedTurns.add(turn)
  return { skipped: false }
}

/** Per-Bot idempotency state shared by every path that mirrors a joined Bot's turns. */
export function mirrorStateOf(rt, botId) {
  if (!rt._mirrorState) rt._mirrorState = new Map()
  let state = rt._mirrorState.get(botId)
  if (!state) { state = { seenKeys: new Set(), closedKeys: new Set(), seenSteps: new Set(), closedTurns: new Set() }; rt._mirrorState.set(botId, state) }
  return state
}

/** Did this session already receive the prompt with `requestId`? (user/message source.rpcId) */
export function hasPromptRequest(session, requestId) {
  if (typeof requestId !== 'string' || requestId === '') return false
  const log = Array.isArray(session?.log) ? session.log : []
  return log.some(event => event?.type === 'user/message' && event.data?.source?.rpcId === requestId)
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
/**
 * Import a batch of normalized history items into a mirror Session.
 * Each item represents one complete exchange (user + bot).
 * items: [{userText, botText, turn, step?, seq?, time?}]
 * opts:  {seenKeys, closedKeys, seenSteps, watermark=0, botId}
 * Returns {imported, skipped, warnings}
 */
export async function importHistory(session, items, opts = {}) {
  const { seenKeys, closedKeys, seenSteps, watermark = 0, botId, seqStep = 1, gapMode = 'seq' } = opts
  const warnings = []
  let imported = 0
  let skipped = 0

  for (const item of items) {
    const { userText, botText, turn, step = 1, seq } = item

    // watermark check: seq <= watermark → silent skip
    if (typeof seq === 'number' && seq <= watermark) {
      skipped++
      continue
    }

    // gap check (gapMode: 'seq' checks event-seq continuity; 'turn' checks turn order; 'none' skips)
    if (gapMode === 'seq' && typeof seq === 'number' && seq > watermark + seqStep + (imported + skipped) * seqStep) {
      warnings.push(`gap: seq=${seq} watermark=${watermark}`)
      skipped++
      continue
    }
    if (gapMode === 'turn' && typeof item.turn === 'number' && imported + skipped > 0) {
      // Only warn on turn gaps, never skip (bulk migration may have sparse turns)
      const expectedTurn = imported + skipped + 1
      if (item.turn !== expectedTurn && item.turn > expectedTurn) {
        warnings.push(`gap: turn=${item.turn} expected=${expectedTurn}`)
      }
    }

    // dedup check via seenKeys (seq-based) or seenSteps (turn:step-based)
    const nodeKey = (botId != null && typeof seq === 'number' && seenKeys instanceof Set)
      ? String(botId) + ':' + String(seq) : null
    if (nodeKey !== null && seenKeys.has(nodeKey)) { skipped++; continue }
    if (nodeKey !== null && closedKeys instanceof Set && closedKeys.has(nodeKey)) { skipped++; continue }

    const stepKey = String(turn) + ':' + String(step)
    if (seenSteps instanceof Set && seenSteps.has(stepKey)) { skipped++; continue }

    // Allocate turn from session.log — never use items.turn directly in turn/start
    const turnInt = allocateTurn(session)

    let stepEnded = false
    try {
      session.append('turn/start', { turn: turnInt })
      session.append('step/start', { turn: turnInt, step })

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
        stream: [],   // required by dsh-session assertAssistantSettlementShape
      }, { surfaceOp: 'append' })

      session.append('step/end', { turn: turnInt, step })
      stepEnded = true
      session.append('turn/end', { turn: turnInt, reason: { kind: 'completed' } })

      if (nodeKey !== null) seenKeys.add(nodeKey)
      if (nodeKey !== null && closedKeys instanceof Set) closedKeys.add(nodeKey)
      if (seenSteps instanceof Set) seenSteps.add(stepKey)

      imported++
    } catch (err) {
      // Single-item failure: close any open turn, record warning, continue
      try { if (!stepEnded) session.append('step/end', { turn: turnInt, step }) } catch {}
      try { session.append('turn/end', { turn: turnInt, reason: { kind: 'error', error: { message: String(err?.message ?? err) } } }) } catch {}
      warnings.push(`item turn=${turn} seq=${seq ?? '?'} failed: ${err?.message ?? err}`)
    }
  }

  return { imported, skipped, warnings }
}


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
