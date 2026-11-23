// mirror.js — write remote bot/turn results into a local mirror Session.
// The session is store-owned; writes go through session.append ONLY.
// No followup / steer / sendUser / sessionController.prompt.
import { createUserMessage, createAssistantMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import { userContentOf } from './joined-attachments.js'
import { turnEnd } from './turn-end.js'

const MIRROR_PROVIDER = 'mirror'
const MIRROR_MODEL = 'mirror-proxy'

/**
 * Allocate the next turn number from session.log.
 * Reads already-committed events, finds the last turn/end, and returns max+1.
 * If there is an unclosed turn (turn/start without matching turn/end), closes
 * it first with reason {kind:'interrupted'} (turn-end.js) before returning the next number.
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
    session.append('turn/end', { turn: openTurn, reason: turnEnd.interrupted() })
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

  let stepEnded = false
  try {
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
      ...(usage ?? {}),
    }, { surfaceOp: 'append' })

    session.append('step/end', { turn: turnInt, step })
    stepEnded = true

    session.append('turn/end', { turn: turnInt, reason: turnEnd.completed() })

    if (nodeKey !== null) seenKeys.add(nodeKey)
    if (nodeKey !== null && closedKeys instanceof Set) closedKeys.add(nodeKey)
    if (seenSteps instanceof Set) seenSteps.add(stepKey)

  } catch (err) {
    try { if (!stepEnded) session.append('step/end', { turn: turnInt, step }) } catch {}
    try {
      session.append('turn/end', {
        turn: turnInt,
        reason: turnEnd.error(err?.message ?? err, 'E_MIRROR_WRITE'),
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
// joined Bot's page must show at once and stay pending until a result, disconnect or Stop, so
// the same events are written through three entry points (S2-4 contract). These and
// mirrorTurn are the only writers; the caller allocates `turn` with allocateTurn() and
// calls mirrorTurnStart with NO await in between (Session.append is synchronous, so two
// concurrent calls could otherwise take the same turn).

const mirrorSource = { kind: 'model', provider: MIRROR_PROVIDER, model: MIRROR_MODEL }

/**
 * turn/start, step/start, user/message. `rpcId` is the prompt's requestId: the client
 * retires its local echo only on a user/message whose source carries it (client.js
 * observeSubmissionMessage); imported history has no requestId and omits it. `content` is the message as the page shows
 * it when the caller took it earlier (a write that waits for a turn in front of it must not look the attachments up
 * after they were let go).
 */
export function mirrorTurnStart(session, { turn, step = 1, userText, rpcId, content } = {}) {
  session.append('turn/start', { turn })
  try {
    session.append('step/start', { turn, step })
    session.append('user/message', createUserMessage({
      content: content ?? userContentOf(rpcId, userText),
      source: rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId },
    }), { surfaceOp: 'append' })
  } catch (err) {
    try { session.append('turn/end', { turn, reason: turnEnd.error(err?.message ?? err, 'E_MIRROR_WRITE') }) } catch {}
    throw err
  }
}

// `reasoning` is what the node Bot thought before this message (bot/trace): a reasoning block ahead of the text,
// the same content a local model step has, which is what the page folds into its "思考过程" row.
function appendAssistant(session, turn, step, text, usage, reasoning) {
  const content = typeof reasoning === 'string' && reasoning.trim() !== '' ? [{ type: 'reasoning', text: reasoning }] : []
  content.push({ type: 'text', text: String(text ?? '') })
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({ content, source: mirrorSource }),
    stream: [],   // required by dsh-session assertAssistantSettlementShape
    ...(usage ?? {}),
  }, { surfaceOp: 'append' })
}

/** Record progress without ending the remote turn or consuming its result's idempotency key. */
export function mirrorTurnPending(session, { turn, step = 1, text } = {}) {
  appendAssistant(session, turn, step, text)
}

/**
 * Append a streaming text delta while a page-origin turn is open.
 * Writes an assistant/message with the accumulated-so-far text so the page shows it live.
 * Does NOT close the step or turn — mirrorTurnFinish does that when the result arrives.
 * `text` is the full accumulated text so far (not a delta), so the page always shows the latest.
 */
export function mirrorTurnStream(session, { turn, step = 1, text } = {}) {
  appendAssistant(session, turn, step, text ?? '')
}

/**
 * assistant/message, step/end, turn/end completed. A node result already written
 * ((botId,nodeSeq) in seenKeys/closedKeys) still closes the turn — as aborted, without a
 * second answer. `closedTurns` guarantees exactly one turn/end per Start.
 */
export function mirrorTurnFinish(session, { turn, step = 1, botText, botId, nodeSeq, seenKeys, closedKeys, seenSteps, closedTurns, usage, reasoning } = {}) {
  if (closedTurns instanceof Set && closedTurns.has(turn)) return { skipped: true, reason: 'already-closed:turn' }
  const nodeKey = (botId != null && nodeSeq != null && seenKeys instanceof Set) ? String(botId) + ':' + String(nodeSeq) : null
  const duplicate = nodeKey !== null && (seenKeys.has(nodeKey) || (closedKeys instanceof Set && closedKeys.has(nodeKey)))
  if (duplicate) {
    try { session.append('step/end', { turn, step }) } catch {}
    try { session.append('turn/end', { turn, reason: turnEnd.duplicateResult() }) } catch {}
    if (closedTurns instanceof Set) closedTurns.add(turn)
    return { skipped: true, reason: 'already-written:nodeSeq' }
  }
  try {
    appendAssistant(session, turn, step, botText, usage, reasoning)
    session.append('step/end', { turn, step })
    session.append('turn/end', { turn, reason: turnEnd.completed() })
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
export function mirrorTurnFail(session, { turn, step = 1, code, message, visible = true, closedTurns, reasoning } = {}) {
  if (closedTurns instanceof Set && closedTurns.has(turn)) return { skipped: true, reason: 'already-closed:turn' }
  const text = String(message ?? 'unknown')
  if (visible) { try { appendAssistant(session, turn, step, `⚠ 无法送达节点：${text}`, undefined, reasoning) } catch {} }
  try { session.append('step/end', { turn, step }) } catch {}
  try { session.append('turn/end', { turn, reason: turnEnd.error(text, code) }) } catch {}
  if (closedTurns instanceof Set) closedTurns.add(turn)
  return { skipped: false }
}

/** What the page says when the user stopped waiting for the node. */
export const STOPPED_TEXT = '已停止等待节点'

/**
 * The user pressed Stop on a turn still waiting for the node: one visible assistant line
 * "⏹ 已停止等待节点（…）", step/end, turn/end {kind:'aborted', reason:{kind:'user'}}. `closedTurns` keeps it to one
 * turn/end per Start, whichever of Finish / Fail / Abort comes first.
 */
export function mirrorTurnAbort(session, { turn, step = 1, closedTurns, reasoning } = {}) {
  if (closedTurns instanceof Set && closedTurns.has(turn)) return { skipped: true, reason: 'already-closed:turn' }
  try { appendAssistant(session, turn, step, `⏹ ${STOPPED_TEXT}（节点之后若回复，会补在这里）`, undefined, reasoning) } catch {}
  try { session.append('step/end', { turn, step }) } catch {}
  try { session.append('turn/end', { turn, reason: turnEnd.stopped() }) } catch {}
  if (closedTurns instanceof Set) closedTurns.add(turn)
  return { skipped: false }
}

/** The line a late reply starts with: the page shows which message it answers is already behind it. */
export const LATE_REPLY_MARK = '↩ 节点迟到回复'
/** The first line of what a node Bot's background task reports after its turn was answered. */
export const TASK_RESULT_MARK = '↩ 节点后台任务结果'
/** The first line of a note that a Stop could not reach the node. */
export const STOP_NOTE_MARK = '⚠ 停止'
/** The first line of a node Bot's answer to a steer whose page turn had already ended. */
export const STEER_REPLY_MARK = '↩ 对插话的回复'

/**
 * The node answered AFTER the page turn ended with E_TIMEOUT. The answer is written as a NEW
 * turn — turn/start, step/start, one assistant message that starts with LATE_REPLY_MARK,
 * step/end, turn/end completed — without a user message (the original one is already on the
 * page). The number comes from allocateTurn like every other turn (I1), the message carries
 * stream:[] (I4), and (botId,nodeSeq) makes a repeated delivery write nothing (I3).
 * The caller makes sure no page turn is open on this Session: allocateTurn would close it.
 */
export function mirrorLateReply(session, { step = 1, botText, botId, nodeSeq, seenKeys, closedKeys, seenSteps, closedTurns, usage, mark = LATE_REPLY_MARK } = {}) {
  const nodeKey = (botId != null && nodeSeq != null && seenKeys instanceof Set) ? String(botId) + ':' + String(nodeSeq) : null
  if (nodeKey !== null && (seenKeys.has(nodeKey) || (closedKeys instanceof Set && closedKeys.has(nodeKey)))) {
    return { skipped: true, reason: 'already-written:nodeSeq' }
  }
  const turn = allocateTurn(session)
  session.append('turn/start', { turn })
  try {
    session.append('step/start', { turn, step })
    appendAssistant(session, turn, step, `${mark}\n\n${String(botText ?? '')}`, usage)
    session.append('step/end', { turn, step })
    session.append('turn/end', { turn, reason: turnEnd.completed() })
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
  return { skipped: false, turn }
}

/** Per-Bot idempotency state shared by every path that mirrors a joined Bot's turns. */
export function mirrorStateOf(rt, botId, session) {
  if (!rt._mirrorState) rt._mirrorState = new Map()
  let state = rt._mirrorState.get(botId)
  if (!state) { state = { seenKeys: new Set(), closedKeys: new Set(), seenSteps: new Set(), closedTurns: new Set() }; rt._mirrorState.set(botId, state) }
  // The mirror Session can be rebuilt while the runtime lives on, and its turn numbers restart
  // at 1. closedTurns carried over from the previous Session would mark a real turn as already
  // closed and leave it open, so that bookkeeping starts fresh for each Session object.
  if (session !== undefined && state.session !== session) {
    state.session = session
    state.closedTurns = new Set()
  }
  return state
}

/** Did this session already receive the prompt with `requestId`? (user/message source.rpcId) */
export function hasPromptRequest(session, requestId) {
  if (typeof requestId !== 'string' || requestId === '') return false
  const log = Array.isArray(session?.log) ? session.log : []
  return log.some(event => event?.type === 'user/message' && event.data?.source?.rpcId === requestId)
}

export function mirrorTurnEnd(session, turn, errorMessage) {
  session.append('turn/end', { turn, reason: errorMessage ? turnEnd.error(errorMessage) : turnEnd.stopped() })
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
    const { userText, botText, turn, step = 1, seq, partId } = item

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
      ? (partId ? JSON.stringify([botId, partId, seq]) : String(botId) + ':' + String(seq)) : null
    if (nodeKey !== null && seenKeys.has(nodeKey)) { skipped++; continue }
    if (nodeKey !== null && closedKeys instanceof Set && closedKeys.has(nodeKey)) { skipped++; continue }

    const stepKey = partId ? JSON.stringify([partId, turn, step]) : String(turn) + ':' + String(step)
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
      session.append('turn/end', {
        turn: turnInt, reason: turnEnd.completed(),
        ...(partId ? { mirrorHistory: { botId, partId, turn, seq } } : {}),
      })

      if (nodeKey !== null) seenKeys.add(nodeKey)
      if (nodeKey !== null && closedKeys instanceof Set) closedKeys.add(nodeKey)
      if (seenSteps instanceof Set) seenSteps.add(stepKey)

      imported++
    } catch (err) {
      // Single-item failure: close any open turn, record warning, continue
      try { if (!stepEnded) session.append('step/end', { turn: turnInt, step }) } catch {}
      try { session.append('turn/end', {
        turn: turnInt, reason: turnEnd.error(err?.message ?? err, 'E_MIRROR_WRITE'),
        ...(partId ? { mirrorHistory: { botId, partId, turn, seq } } : {}),
      }) } catch {}
      warnings.push(`item turn=${turn} seq=${seq ?? '?'} failed: ${err?.message ?? err}`)
    }
  }

  return { imported, skipped, warnings }
}


const mirrorSessions = new WeakMap()

export async function ensureMirrorSession(rt, bot) {
  let pending = mirrorSessions.get(rt)
  if (!pending) { pending = new Map(); mirrorSessions.set(rt, pending) }
  if (pending.has(bot.id)) return pending.get(bot.id)
  const job = createMirrorSession(rt, bot)
  pending.set(bot.id, job)
  try {
    return await job
  } finally {
    if (pending.get(bot.id) === job) pending.delete(bot.id)
  }
}

/**
 * The Session a file for this Bot's chat is uploaded under. A joined Bot has no Session of its own until its page is
 * first opened (`rt.chatOf` then answers the Bot's id, which no Agent lives under), so an IM or phone file sent
 * before that would find nothing to be staged for: the mirror Session is created first.
 */
export async function uploadSessionOf(rt, botId) {
  const bot = rt.botOf?.(botId)
  if (bot?.origin === 'joined' && bot.worker?.home === 'remote' && !(typeof bot.sessionId === 'string' && bot.sessionId !== '')) {
    try { await ensureMirrorSession(rt, bot) } catch { /* the upload says it cannot, as before */ }
  }
  return rt.chatOf(botId)
}

async function createMirrorSession(rt, bot) {
  bot = rt.botOf?.(bot.id) ?? bot
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

  let session
  try {
    const agent = await rt.resolveAgent(sessionId)
    session = agent.session
    if (!session) throw new Error('session unavailable')
  } catch (err) {
    throw Object.assign(new Error('mirror session resolve failed: ' + (err?.message ?? err)), { code: 'no-session' })
  }

  // DSH session format requires the first surface to be a protected system/message head.
  // Without it every turn that appends a system prompt update corrupts the log
  // (SessionFormatError: system/message requires a protected first surface head).
  // Write the head immediately after the bare session is created, before any turn.
  try {
    session.append('system/message', createSystemMessage(`[mirror: ${bot.name}]`), { protected: true })
  } catch {
    // Some DSH versions accept protected:true; others write without it.
    // Swallow to let the session proceed — worse than corrupt format is no session.
    try { session.append('system/message', createSystemMessage(`[mirror: ${bot.name}]`)) } catch { /* ignore */ }
  }

  // A roster report can replace the row while create/resolve is awaited. Publish to
  // the current row, and never bring back a Bot deleted while its page was opening.
  const current = typeof rt.botOf === 'function' ? rt.botOf(bot.id) : bot
  if (!current) throw Object.assign(new Error('mirror Bot was removed'), { code: 'no-session' })
  if (typeof current.sessionId === 'string' && current.sessionId !== '') {
    return (await rt.resolveAgent(current.sessionId)).session
  }
  const oldSessionId = current.sessionId
  current.sessionId = sessionId
  rt.updateBySessionId?.(current.id, oldSessionId, sessionId)
  try {
    await rt.save?.()
  } catch (err) {
    const latest = rt.botOf?.(current.id) ?? current
    if (latest.sessionId === sessionId) {
      if (oldSessionId === undefined) delete latest.sessionId
      else latest.sessionId = oldSessionId
      rt.updateBySessionId?.(latest.id, sessionId, oldSessionId)
    }
    throw err
  }
  return session
}
