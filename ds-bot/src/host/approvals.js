// Approvals. A member's group Session is hidden, so DSH's approval card never shows
// there and the turn would wait forever: DS Bot answers those requests itself, from
// the group chat. A Bot's own chat keeps DSH's card, but DS Bot can answer those too
// (IM chats, the phone app): the request is raced — whichever side answers first wins,
// and the other card withdraws.
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AUDIT_DIR, createAuditWriter } from './approval-audit.js'

const OUTCOMES = Object.freeze({ allow: 'allowed-once', reject: 'rejected' })
// The three outcome values an approval can settle with; `unavailable` and `expired` are not among them.
export const APPROVAL_OUTCOME_VALUES = Object.freeze({ allow: 'allowed-once', reject: 'rejected', cancel: 'cancelled' })

// The request fingerprint binds an answer to the one request it was shown for:
//   sha256(sessionId \0 toolName \0 callId \0 at)
// all taken from the DSH `approval/request` event (`request.agent.session.id ?? request.agent.id`,
// `request.toolName`, `request.callId`) plus the entry's open time. A missing callId is ''.
export const approvalFingerprint = (sessionId, tool, callId, at) => createHash('sha256')
  .update([String(sessionId), String(tool), String(callId ?? ''), String(at)].join('\u0000')).digest('hex')

const stale = (message) => Object.assign(new Error(message), { code: 'bot/stale' })

// Persisted approval results kept in state.json, by fingerprint; the oldest go first.
export const APPROVAL_RESULTS_MAX = 200
const table = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})

export function install(rt) {
  const { ctx } = rt
  // Only the host that saves the team writes the audit and the critical state; a host
  // without a store (unit harnesses) or a read-only one writes neither.
  const canPersist = () => rt.state !== undefined && typeof rt.save === 'function' && rt.readOnly?.() === undefined
  const audit = createAuditWriter({
    dir: typeof rt.home === 'string' && rt.home !== '' ? join(rt.home, AUDIT_DIR) : '',
    writable: canPersist,
    warn: (...args) => rt.warn?.(...args),
  })
  rt.approvalAudit = audit
  // The result and the Session's resume position are written with save({required:true}),
  // which resolves only once state.json holds them (temp file, then rename).
  const recordResult = (entry, result) => {
    const state = rt.state
    const results = { ...table(state.approvalResults) }
    delete results[entry.fingerprint]
    results[entry.fingerprint] = { result, at: Date.now(), sessionId: entry.sessionId }
    const keys = Object.keys(results)
    for (const key of keys.slice(0, Math.max(0, keys.length - APPROVAL_RESULTS_MAX))) delete results[key]
    state.approvalResults = results
    const cursors = { ...table(state.resumeCursor) }
    const since = rt.turnSince?.(entry.sessionId)
    cursors[entry.sessionId] = { ...(since !== undefined ? { since } : {}), approval: 'settled', fp: entry.fingerprint }
    state.resumeCursor = cursors
  }
  const persistResult = (entry, result) => {
    recordResult(entry, result)
    return rt.save({ required: true })
  }
  /** @type {Map<string, {id:string, sessionId:string, botId:string, roomId?:string, tool:string, reason:string, detail:{text?:string, code?:string}, at:number, fingerprint:string, answer?:(outcome:string)=>void}>} */
  const pending = new Map()
  const approvalListeners = new Set()
  const onApproval = (listener) => {
    approvalListeners.add(listener)
    return () => approvalListeners.delete(listener)
  }
  const emit = (kind, data) => {
    for (const listener of approvalListeners) {
      try { listener(kind, data) } catch (error) { rt.warn('ds-bot: approval listener failed: %s', error) }
    }
  }

  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  ctx.on('approval/request', (request, next) => {
    const sessionId = request.agent?.session?.id ?? request.agent?.id
    const owner = sessionId === undefined ? undefined : rt.groupOwners.get(sessionId)
    const taskOwner = sessionId === undefined ? undefined : rt.taskOwners?.get(sessionId)
    const botId = owner?.botId ?? taskOwner?.botId ?? (sessionId === undefined ? undefined : rt.chatOwners.get(sessionId))
    if (botId === undefined) return next()
    const taskTitle = taskOwner === undefined ? undefined : rt.taskBySession?.(sessionId)?.task?.title
    const id = randomUUID()
    const at = Date.now()
    const toolName = String(request.toolName ?? '')
    const roomId = owner?.roomId ?? taskOwner?.roomId
    const entry = {
      id,
      sessionId,
      botId,
      ...(roomId ? { roomId } : {}),
      ...(taskOwner ? { taskId: taskOwner.taskId, ...(taskTitle ? { taskTitle } : {}) } : {}),
      tool: toolName,
      reason: String(request.reason ?? '').slice(0, 500),
      detail: rt.callDetail?.(sessionId, request.callId) ?? {},
      at,
      fingerprint: approvalFingerprint(sessionId, toolName, request.callId, at),
    }
    // The audit note is part of the approval path: if it cannot be written the request
    // is not shown or answerable, and the caller gets a denial, never an allow.
    try {
      rt.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
    } catch (error) {
      rt.warn('ds-bot: approval audit write failed, denying: %s', error)
      return 'cancelled'
    }
    pending.set(id, entry)
    void audit.append({ ts: at, actor: botId, entry, phase: 'open' })
    // The open position stays in inflight.json (noteApproval above); state.json takes the
    // settled one, so opening an approval does not change the team's revision.
    rt.approvalWaiting?.(entry)
    emit('open', { ...entry, answerable: true })
    // Returns the outcome actually given, or undefined when the entry was already
    // settled. If the audit record cannot be cleared the outcome can only be a denial.
    // `marker` is set by the answer path, which has already persisted the result and
    // written the audit line; any other settlement (abort, DSH's card, cancel) publishes
    // first and appends its audit line right after.
    const settle = (outcome, marker, actor = 'host') => {
      if (!pending.has(id)) return undefined
      pending.delete(id)
      let given = outcome
      try {
        rt.noteApproval?.(sessionId, undefined)
      } catch (error) {
        rt.warn('ds-bot: approval audit clear failed, denying: %s', error)
        given = outcome === OUTCOMES.allow ? 'cancelled' : outcome
      }
      if (marker === undefined && !audit.enabled()) marker = 'unaudited'
      entry.given = given
      const settledTaskId = entry.taskId ?? rt.taskOwners?.get(sessionId)?.taskId
      emit('settled', { id, outcome: given, ...(settledTaskId ? { taskId: settledTaskId } : {}), ...(marker !== undefined ? { audit: marker } : {}) })
      if (entry.audited === undefined) void audit.append({ ts: Date.now(), actor, entry, result: given, phase: 'settled' })
      return given
    }
    if (owner === undefined && taskOwner === undefined) {
      // An own-chat approval races DSH's card. The card sees `linked`, our own
      // AbortSignal: answering here resolves the request, then withdraws the card;
      // an answer there settles `next()` first and is adopted. An abort of the
      // original signal cancels either way.
      const original = request.signal
      const linked = new AbortController()
      request.signal = linked.signal
      return new Promise((resolve, reject) => {
        const complete = (outcome, marker, actor) => {
          const given = settle(outcome, marker, actor)
          if (given === undefined) return
          resolve(given)
          linked.abort()
          if (request.signal === linked.signal) request.signal = original
        }
        entry.answer = complete
        if (original?.aborted) entry.answer('cancelled')
        else original?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
        Promise.resolve(next()).then(
          (outcome) => {
            if (!pending.has(id)) return
            complete(outcome, undefined, 'card')
          },
          // DSH's answerer threw: close the entry and give the caller the error
          // the way the pre-race code did, instead of hanging forever.
          (error) => {
            if (settle('cancelled') === undefined) return
            reject(error)
            linked.abort()
            if (request.signal === linked.signal) request.signal = original
          },
        )
      })
    }
    if (owner !== undefined) rt.yieldRoomTurn?.(sessionId)
    else if (taskOwner?.roomId !== undefined) {
      const groupSid = rt.roomOf(taskOwner.roomId)?.sessions?.[botId]
      if (groupSid !== undefined) rt.yieldRoomTurn?.(groupSid)
    }
    return new Promise((resolve) => {
      entry.answer = (outcome, marker, actor) => {
        const given = settle(outcome, marker, actor)
        if (given === undefined) return
        resolve(given)
      }
      if (request.signal?.aborted) entry.answer('cancelled')
      request.signal?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
    })
  }, { prepend: true })

  const approvalsView = () => [...pending.values()].map(({ answer, ...entry }) => {
    const liveTask = entry.taskId === undefined ? rt.taskOwners?.get(entry.sessionId) : undefined
    const liveTitle = entry.taskTitle ?? (liveTask === undefined ? undefined : rt.taskBySession?.(entry.sessionId)?.task?.title)
    return {
      ...entry,
      ...(liveTask ? { taskId: liveTask.taskId, ...(liveTitle ? { taskTitle: liveTitle } : {}) } : {}),
      answerable: answer !== undefined,
    }
  })
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)

  // A supplied binding must still match the original card. The caller must also name
  // the owning Session, either through that binding or separately.
  //
  // On the host that saves the team the answer is persisted before it is published:
  // the result goes to state.json (save({required:true})), then the audit line, and only
  // then the engine's request resolves and `settled` is emitted; the returned promise
  // resolves after that. If the save fails the approval settles 'cancelled' and the
  // promise rejects with the save error. A read-only host (or one without a store)
  // answers as before, synchronously, and marks the settlement 'unaudited'.
  // The checks below stay synchronous: an id that is closed or already being settled
  // throws bot/stale at once, so the first answer wins.
  function answerApproval(id, choice, binding, sessionId = binding?.sessionId) {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined || entry.settling) throw stale('This approval is no longer open')
    if (binding !== undefined && binding !== null
      && (typeof binding.sessionId !== 'string' || typeof binding.fingerprint !== 'string'
        || binding.sessionId !== entry.sessionId || binding.fingerprint !== entry.fingerprint)) {
      throw stale('This approval no longer matches the request it was shown for')
    }
    if (sessionId !== entry.sessionId) {
      throw Object.assign(new Error('Only the owning session can answer this approval'), { code: 'bot/forbidden' })
    }
    const outcome = OUTCOMES[choice]
    if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    if (!canPersist()) {
      entry.answer(outcome, 'unaudited', 'unknown')
      return undefined
    }
    entry.settling = true
    const run = (async () => {
      try {
        await persistResult(entry, outcome)
      } catch (error) {
        // The answer was not saved: the in-memory copy must not hold it either, or a
        // later save would write an allow that was never published.
        recordResult(entry, 'cancelled')
        entry.settling = false
        entry.answer('cancelled', undefined, 'host')
        throw error
      }
      // Settled meanwhile by another path (an abort): that outcome stands, and the saved
      // result follows it.
      if (!pending.has(entry.id)) {
        if (entry.given !== undefined && entry.given !== outcome) await persistResult(entry, entry.given).catch(() => {})
        throw stale('This approval is no longer open')
      }
      const marker = await audit.append({ ts: Date.now(), actor: 'unknown', entry, result: outcome, phase: 'settled' })
      // An abort during the append settled it (and wrote its own, later audit line).
      if (!pending.has(entry.id)) {
        if (entry.given !== undefined && entry.given !== outcome) await persistResult(entry, entry.given).catch(() => {})
        throw stale('This approval is no longer open')
      }
      entry.audited = true
      entry.answer(outcome, marker, 'unknown')
      return outcome
    })()
    // IM answers without awaiting; the rejection is still handled there by its caller's
    // own path, and never left unhandled here.
    run.catch(() => {})
    return run
  }

  // A group Session that leaves its group has no card left to answer from.
  const cancelApprovals = (sessionId) => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId) entry.answer?.('cancelled')
    }
  }

  // On a node, an approval reaches the hub as a card in the roster report (node-cards.js) and is answered
  // there with bot/action card-answer. The roster goes out every few seconds; publish at once when a card
  // opens or settles so the hub shows it (and drops it) without that wait.
  onApproval(() => { void Promise.resolve(rt.publishSkillRoster?.()).catch(() => {}) })

  Object.assign(rt, { approvalsView, waitsForApproval, answerApproval, cancelApprovals, onApproval })
}
