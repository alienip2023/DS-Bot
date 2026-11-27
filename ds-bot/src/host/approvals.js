// Approvals. A member's group Session is hidden, so DSH's approval card never shows
// there and the turn would wait forever: DS Bot answers those requests itself, from
// the group chat. A Bot's own chat keeps DSH's card, but DS Bot can answer those too
// (IM chats, the phone app): the request is raced — whichever side answers first wins,
// and the other card withdraws. A Bot or group set to `review` has a model look at the
// request first (approval-review.js) and falls back to the card.
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, sep } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { cleanText } from './diagnostics.js'
import { REFERENCE_KIND, REPLY_KIND } from './constants.js'
import { reviewApproval, reviewContext, reviewSessionIds, REVIEW_TIMEOUT_MS } from './approval-review.js'
import { AUDIT_DIR, createAuditWriter } from './approval-audit.js'
import { ESCALATION } from './extra-folders.js'

const OUTCOMES = Object.freeze({ allow: 'allowed-once', reject: 'rejected' })
const FILE_ESCALATION_TOOLS = new Set(['write', 'edit', 'apply_patch'])
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
const sessionOf = agent => agent?.session?.id ?? agent?.id
const keyOf = (agent, callId) => JSON.stringify([sessionOf(agent), callId])

function cleanDisplayReason(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const [lang, text] of Object.entries(raw)) {
    if (typeof lang === 'string' && lang.length <= 16 && typeof text === 'string' && text.trim() !== '') {
      out[lang] = text.slice(0, 500)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

async function nativeEvidence(ctx, exec) {
  const evidence = { kind: 'tool', tool: exec.name, arguments: JSON.parse(JSON.stringify(exec.arguments ?? {})) }
  if (!['bash', 'pwsh'].includes(exec.name) || !exec.agent?.session) return evidence
  const directories = ctx.get?.('workingDirectory')
  const shell = ctx.get?.('shell')
  const fs = ctx.get?.('fs')
  if (!directories?.ensure || !shell?.resolve || !fs?.resolve || !fs?.processPath || !fs?.stat) return evidence
  const sessionCwd = await directories.ensure(exec.agent, exec.signal)
  if (typeof sessionCwd !== 'string' || !isAbsolute(sessionCwd)) return evidence
  const args = evidence.arguments
  if (args.workdir !== undefined && typeof args.workdir !== 'string') return evidence
  // Match the native tools' relative override, then let the execution backend resolve it.
  const workdir = args.workdir === undefined ? sessionCwd : isAbsolute(args.workdir) ? args.workdir : `${sessionCwd}${sep}${args.workdir}`
  const spec = shell.resolve({ command: args.command, workdir })
  if (typeof spec.workdir !== 'string' || !isAbsolute(spec.workdir)) return evidence
  const target = await fs.resolve(spec.workdir, { signal: exec.signal })
  if ((await fs.stat(target, exec.signal))?.type !== 'directory') return evidence
  const cwd = fs.processPath(target)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return evidence
  return { ...evidence, sessionCwd, workdir: spec.workdir, cwd }
}

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
  /** @type {Map<string, {id:string, sessionId:string, botId:string, roomId?:string, tool:string, reason:string, detail:{text?:string, code?:string}, at:number, fingerprint:string, answer?:(outcome:string, marker?:string, actor?:string)=>void}>} */
  const pending = new Map()
  const executions = new Map()
  const actionScope = new AsyncLocalStorage()
  const approvalListeners = new Set()
  const clean = text => cleanText(text, { redact: rt.redactSecrets }).slice(0, 1000)
  const emit = (kind, data) => {
    for (const listener of approvalListeners) {
      try { listener(kind, data) } catch (error) { rt.warn('ds-bot: approval listener failed: %s', error) }
    }
  }
  const view = ({ answer, cancelReview, toManual, isAborted, ownerSessionId, lineageSessionIds, prepareAlways, settling, privacy: _, ...entry }) => {
    const taskSessionId = rt.taskOwners?.has(entry.sessionId) ? entry.sessionId : ownerSessionId ?? entry.sessionId
    const liveTask = entry.taskId === undefined ? rt.taskOwners?.get(taskSessionId) : undefined
    const liveEntry = liveTask === undefined ? undefined : rt.taskBySession?.(taskSessionId)?.task
    const liveTitle = entry.taskTitle ?? liveEntry?.title
    const liveRoomId = entry.roomId === undefined ? (liveTask?.roomId ?? liveEntry?.roomId) : undefined
    return {
      ...entry,
      ...(ownerSessionId !== undefined && ownerSessionId !== entry.sessionId ? { ownerSessionId } : {}),
      ...(liveRoomId !== undefined ? { roomId: liveRoomId } : {}),
      ...(liveTask ? { taskId: liveTask.taskId, ...(liveTitle ? { taskTitle: liveTitle } : {}) } : {}),
      answerable: answer !== undefined,
    }
  }
  const changed = entry => emit('updated', view(entry))

  // Queued user input is not a user/message until the pending tool yields.
  ctx.on('session/event', (session, event) => {
    const input = event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(message => ['user', REFERENCE_KIND, REPLY_KIND].includes(message.source?.kind))
    if (!input && event.type !== 'working-directory/change') return
    for (const entry of pending.values()) {
      if (reviewSessionIds(rt, entry).includes(session.id)) entry.cancelReview()
    }
  })

  // Capture immutable tool arguments before any pre-execute policy asks. Result
  // events release both successful and rejected calls, including PTC sub-calls.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const owner = await ownerOf(exec.agent)
    if (!owner) return next()
    if (enabled(owner)) {
      if (exec.callId !== undefined) {
        const key = keyOf(exec.agent, exec.callId)
        const readEvidence = () => nativeEvidence(ctx, exec)
        const evidence = await readEvidence().catch(() => ({ kind: 'tool', tool: exec.name }))
        executions.set(key, { evidence, readEvidence })
        if (executions.size > 1000) executions.delete(executions.keys().next().value)
      }
    } else if (FILE_ESCALATION_TOOLS.has(exec.name) && exec.arguments?.sandbox_permissions !== undefined && exec.callId !== undefined) {
      // Capture only the file-tool arguments needed to evaluate "Always allow" extra-folder eligibility,
      // never touching workingDirectory.ensure when automatic review is off.
      const key = keyOf(exec.agent, exec.callId)
      const evidence = { kind: 'tool', tool: exec.name, arguments: JSON.parse(JSON.stringify(exec.arguments ?? {})) }
      executions.set(key, { evidence })
      if (executions.size > 1000) executions.delete(executions.keys().next().value)
    }
    return next()
  }, { prepend: true })
  ctx.on('tools/result', exec => {
    executions.delete(keyOf(exec.agent, exec.callId))
    if (exec.name === 'ask_user_question') {
      for (const entry of pending.values()) if (reviewSessionIds(rt, entry).includes(sessionOf(exec.agent))) entry.cancelReview()
    }
  })

  // Async-local evidence belongs to one request, even when a script makes several
  // concurrent requests with the same outer call id. The host API stays unchanged.
  const requestActionApproval = (request, evidence) => actionScope.run(evidence,
    () => ctx.get('approval').request(request))

  const ownerAt = (sessionId, id, seen) => {
    const group = rt.groupOwners.get(id)
    const taskOwner = rt.taskOwners?.get(id)
    const botId = group?.botId ?? taskOwner?.botId ?? rt.chatOwners.get(id)
    if (botId === undefined) {
      const agentOwner = rt.agentOf?.(id)
      if (agentOwner === undefined) return undefined
      return { sessionId, ownerSessionId: id, lineageSessionIds: [...seen] }
    }
    const task = taskOwner === undefined ? undefined : rt.taskBySession?.(id)?.task
    const taskTitle = task?.title
    const roomId = group ? group.roomId : (taskOwner?.roomId ?? task?.roomId)
    return {
      sessionId, ownerSessionId: id, lineageSessionIds: [...seen], botId,
      ...(roomId !== undefined ? { roomId } : {}),
      ...(taskOwner ? { taskId: taskOwner.taskId, ...(taskTitle ? { taskTitle } : {}) } : {}),
    }
  }

  async function ownerOf(agent) {
    const sessionId = sessionOf(agent)
    let current = agent
    const seen = new Set()
    while (current && seen.size < 16) {
      const id = sessionOf(current)
      if (id === undefined || seen.has(id)) break
      seen.add(id)
      const owner = ownerAt(sessionId, id, seen)
      if (owner) return owner
      const parent = current.session?.header?.parentSession
      if (!parent || current.session.header.origin !== 'subagent') break
      current = await rt.resolveAgent(parent).catch(() => undefined)
      if (sessionOf(current) !== parent) break
    }
    return undefined
  }

  // ownerOf only awaits while it walks a subagent's parent chain; a directly owned
  // Session resolves here, so the request's card exists before the listener returns.
  const followParent = {}
  const ownerNow = (agent) => {
    const id = sessionOf(agent)
    if (id === undefined) return undefined
    const owner = ownerAt(id, id, new Set([id]))
    if (owner) return owner
    const parent = agent.session?.header?.parentSession
    if (parent && agent.session.header.origin === 'subagent') return followParent
    return undefined
  }
  const enabled = owner => owner.botId !== undefined && (rt.roomOf(owner.roomId)?.permission ?? rt.botOf(owner.botId)?.permission) === 'review'

  async function record(entry, decision) {
    const item = {
      id: entry.id, botId: entry.botId, ...(entry.roomId ? { roomId: entry.roomId } : {}),
      tool: entry.tool, at: Date.now(), outcome: decision.decision, reason: clean(decision.reason),
      ...(entry.review?.model ? { model: entry.review.model } : {}),
    }
    rt.state.approvalReviews = [...(rt.state.approvalReviews ?? []).filter(previous => previous.id !== item.id), item].slice(-100)
    await rt.save()
  }

  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  ctx.on('approval/request', (request, next) => {
    const explicit = actionScope.getStore()
    const owner = ownerNow(request.agent)
    if (owner === followParent) return ownerOf(request.agent).then(resolved => handleRequest(request, next, resolved, explicit))
    return handleRequest(request, next, owner, explicit)
  }, { prepend: true })

  function handleRequest(request, next, owner, explicit) {
    if (!owner) return next()
    if (request.signal?.aborted) return 'cancelled'
    const captured = executions.get(keyOf(request.agent, request.callId))
    const execution = captured?.evidence.tool === request.toolName ? captured.evidence : undefined
    const nativeShell = ['bash', 'pwsh'].includes(request.toolName)
    // Privacy guards can ask before the shell itself; their payload still needs its execution scope.
    const evidence = explicit && nativeShell ? { ...explicit, execution } : explicit ?? execution
    const validateEvidence = execution && nativeShell ? async () => {
      if (JSON.stringify(await captured.readEvidence()) !== JSON.stringify(execution)) throw new Error('The native execution directory or arguments changed')
    } : undefined
    const id = randomUUID()
    const original = request.signal
    const linked = new AbortController()
    const reviewer = new AbortController()
    const at = Date.now()
    const toolName = String(request.toolName ?? '')
    const displayReason = cleanDisplayReason(request.displayReason)
    const entry = {
      id, sessionId: owner.sessionId, ownerSessionId: owner.ownerSessionId, lineageSessionIds: owner.lineageSessionIds,
      ...(owner.botId !== undefined ? { botId: owner.botId } : {}),
      ...(owner.roomId ? { roomId: owner.roomId } : {}),
      ...(owner.taskId ? { taskId: owner.taskId, ...(owner.taskTitle ? { taskTitle: owner.taskTitle } : {}) } : {}),
      tool: toolName, reason: String(request.reason ?? '').slice(0, 500),
      ...(displayReason ? { displayReason } : {}),
      ...(request.privacy === true ? { privacy: true } : {}),
      detail: rt.callDetail?.(owner.sessionId, request.callId) ?? {}, at,
      fingerprint: approvalFingerprint(owner.sessionId, toolName, request.callId, at),
    }
    const automatic = enabled(owner)
    if (automatic) entry.review = { status: 'reviewing' }
    return new Promise((resolve, reject) => {
      let manualStarted = false
      let timer
      const abort = () => complete('cancelled')
      // Returns the outcome actually given, or undefined when the entry was already
      // settled. If the audit record cannot be cleared the outcome can only be a denial.
      // `marker` is set by the answer path, which has already persisted the result and
      // written the audit line; any other settlement (abort, DSH's card, the review
      // model, cancel) publishes first and appends its audit line right after.
      const settle = (outcome, { reviewed = false, marker, actor = 'host' } = {}) => {
        if (!pending.has(id)) return undefined
        pending.delete(id)
        const logged = rt.state?.approvalReviews?.find(item => item.id === id)
        if (!reviewed && logged && ['allow', 'reject'].includes(logged.outcome)) {
          logged.outcome = 'cancelled'
          logged.reason = 'The model decision was withdrawn before it took effect.'
          void rt.save().catch(() => {})
        }
        clearTimeout(timer)
        original?.removeEventListener('abort', abort)
        reviewer.abort()
        linked.abort()
        if (request.signal === linked.signal) request.signal = original
        let given = outcome
        try {
          rt.noteApproval?.(owner.ownerSessionId, undefined)
        } catch (error) {
          rt.warn('ds-bot: approval audit clear failed, denying: %s', error)
          given = outcome === OUTCOMES.allow ? 'cancelled' : outcome
        }
        if (marker === undefined && !audit.enabled()) marker = 'unaudited'
        entry.given = given
        const settledTaskId = entry.taskId ?? rt.taskOwners?.get(owner.sessionId)?.taskId ?? rt.taskOwners?.get(owner.ownerSessionId)?.taskId
        emit('settled', { id, outcome: given, ...(settledTaskId ? { taskId: settledTaskId } : {}), ...(marker !== undefined ? { audit: marker } : {}) })
        if (entry.audited === undefined) void audit.append({ ts: Date.now(), actor, entry, result: given, phase: 'settled' })
        return given
      }
      const complete = (outcome, options) => {
        const given = settle(outcome, options)
        if (given !== undefined) resolve(given)
        return given
      }
      const manual = reason => {
        // An answer being persisted (answerApproval) is the user's: nothing opens over it.
        if (!pending.has(id) || manualStarted || entry.settling) return
        manualStarted = true
        clearTimeout(timer)
        if (automatic) entry.review = { ...entry.review, status: 'manual', reason: clean(reason) }
        changed(entry)
        // Group sessions and background tasks run in hidden Sessions owned by DS Bot's
        // cards (group member card or task deck), so they never race DSH's own card.
        // Own-chat children still need the host path, since their Bot may have no group
        // approval controls.
        const yieldSession = owner.taskId === undefined || owner.roomId === undefined
          ? owner.ownerSessionId
          : rt.roomOf(owner.roomId)?.sessions?.[owner.botId] ?? owner.ownerSessionId
        rt.yieldRoomTurn?.(yieldSession)
        if (owner.roomId !== undefined || owner.taskId !== undefined) return
        request.signal = linked.signal
        // DSH's card is asked a microtask later. An answer that got there first is being
        // saved before it takes effect (answerApproval): it has won, so the card is not
        // asked, and a card that answers meanwhile does not override it (an abort still does).
        const SKIPPED = Symbol('answered first')
        Promise.resolve().then(() => (entry.settling ? SKIPPED : next())).then(outcome => {
          if (outcome === SKIPPED || entry.settling) return
          if (outcome !== 'unavailable' || owner.ownerSessionId !== owner.sessionId) complete(outcome, { actor: 'card' })
        }, error => {
          if (entry.settling) return
          if (settle('cancelled') !== undefined) reject(error)
        })
      }
      entry.answer = (outcome, marker, actor) => complete(outcome, { marker, actor })
      entry.cancelReview = () => reviewer.abort()
      entry.toManual = () => {
        if (automatic && pending.has(id) && entry.review?.status === 'reviewing') {
          manual('Automatic review stopped; review this action manually.')
        }
      }
      entry.isAborted = () => original?.aborted === true
      // The audit note is part of the approval path: if it cannot be written the request
      // is not shown or answerable, and the caller gets a denial, never an allow.
      try {
        rt.noteApproval?.(owner.ownerSessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200), ...(entry.privacy ? { privacy: true } : {}) })
      } catch (error) {
        rt.warn('ds-bot: approval audit write failed, denying: %s', error)
        return resolve('cancelled')
      }
      pending.set(id, entry)
      void audit.append({ ts: at, actor: owner.botId, entry, phase: 'open' })
      // The open position stays in inflight.json (noteApproval above); state.json takes the
      // settled one, so opening an approval does not change the team's revision.
      rt.approvalWaiting?.(entry)
      original?.addEventListener('abort', abort, { once: true })
      emit('open', view(entry))
      // "Always allow" is offered only for direct (non-subagent) Bot/group file-tool sandbox
      // escalations (`extraDirs`), where DS Bot has a visible, revocable folder-grant store and
      // matching auto-allow escalation handler. Browser write prompts stay one-time (preauthorization
      // lives in Browser settings); shell commands, privacy gates, private Bots, local agents,
      // classic sessions, and subagent child sessions stay strictly one-time.
      if (owner.botId !== undefined
        && owner.sessionId === owner.ownerSessionId
        && request.privacy !== true
        && !explicit
        && !entry.alwaysAllow
        && FILE_ESCALATION_TOOLS.has(entry.tool)
        && entry.reason.startsWith(ESCALATION)
        && execution?.arguments
        && typeof rt.resolvableExtraDirs === 'function') {
        void rt.resolvableExtraDirs({
          session: request.agent?.session,
          botId: owner.botId,
          roomId: owner.roomId,
          name: entry.tool,
          args: execution.arguments,
        }).then((dirs) => {
          if (!pending.has(id) || entry.settling || !Array.isArray(dirs) || dirs.length === 0) return
          const scopeRoom = owner.roomId ? rt.roomOf(owner.roomId) : undefined
          const groupScoped = scopeRoom?.workDir !== undefined
          const scope = groupScoped ? 'group' : 'bot'
          entry.alwaysAllow = {
            kind: 'extra-dir',
            dirs,
            scope,
            ...(groupScoped && scopeRoom?.name ? { scopeName: scopeRoom.name } : {}),
          }
          entry.prepareAlways = () => rt.prepareGrantExtraDirs({ botId: owner.botId, roomId: owner.roomId, dirs, scope })
          changed(entry)
        }).catch(() => {})
      }
      if (original?.aborted) return complete('cancelled')
      if (!automatic) return manual()
      const timeout = new Promise((_, fail) => {
        const interrupted = () => fail(new Error('Automatic review stopped; review this action manually'))
        reviewer.signal.addEventListener('abort', interrupted, { once: true })
        // Once the model wins the race, a stalled save no longer rejects it.
        // Open the card from the timer itself so persistence cannot block it.
        timer = setTimeout(() => {
          reviewer.abort()
          if (pending.has(id)) manual('Automatic review could not decide. Review this action manually.')
        }, REVIEW_TIMEOUT_MS)
      })
      void Promise.race([reviewApproval(rt, {
        request, owner, evidence, validateEvidence, signal: reviewer.signal,
        onModel: model => { if (pending.has(id)) { entry.review.model = model; changed(entry) } },
      }), timeout]).then(async decision => {
        if (!pending.has(id) || entry.settling) return
        if (reviewer.signal.aborted || !enabled(owner)) throw new Error('Automatic review was invalidated')
        if (decision.decision === 'manual') {
          manual(decision.reason)
          await record(entry, decision)
          return
        }
        await record(entry, decision)
        if (JSON.stringify(await reviewContext(rt, owner, reviewer.signal)) !== JSON.stringify(decision.context)) {
          throw new Error('The conversation changed while saving the review')
        }
        await validateEvidence?.()
        if (!pending.has(id) || entry.settling) return
        if (reviewer.signal.aborted || !enabled(owner)) throw new Error('Automatic review was invalidated')
        complete(OUTCOMES[decision.decision], { reviewed: true, actor: 'review' })
      }).catch(async () => {
        if (!pending.has(id) || entry.settling) return
        const reason = 'Automatic review could not decide. Review this action manually.'
        manual(reason)
        try { await record(entry, { decision: 'manual', reason }) } catch { /* the manual card remains available */ }
      }).finally(() => clearTimeout(timer))
    })
  }

  const approvalsView = () => [...pending.values()].map(view)
  const approvalById = id => pending.get(String(id ?? ''))
  const approvalReviewsView = () => rt.state.approvalReviews ?? []
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)

  // "Always allow": validate the folder grant first (the tool stays blocked), then settle
  // `allowed-once` and commit the pre-validated grant. A failed validation reopens the card.
  function answerAlways(entry) {
    if (!entry.alwaysAllow || typeof entry.prepareAlways !== 'function') {
      throw Object.assign(new Error('Always allow is not available for this request'), { code: 'bot/refused' })
    }
    entry.cancelReview()
    if (entry.isAborted?.()) {
      entry.answer('cancelled')
      throw stale('This approval is no longer open')
    }
    entry.settling = true
    return (async () => {
      let prepared
      try {
        prepared = await entry.prepareAlways()
      } catch (error) {
        if (pending.has(entry.id)) {
          entry.settling = false
          if (entry.isAborted?.()) entry.answer('cancelled')
          else entry.toManual?.()
        }
        throw error
      }
      if (!pending.has(entry.id) || entry.isAborted?.()) {
        if (pending.has(entry.id)) entry.answer('cancelled')
        throw stale('This approval is no longer open')
      }
      if (typeof prepared?.verifySync === 'function' && !prepared.verifySync()) {
        entry.settling = false
        entry.toManual?.()
        throw Object.assign(new Error('Always allow is not available for this request'), { code: 'bot/refused' })
      }
      const settled = entry.answer(OUTCOMES.allow, canPersist() ? undefined : 'unaudited', 'unknown')
      if (settled === undefined) throw stale('This approval is no longer open')
      if (canPersist()) await persistResult(entry, OUTCOMES.allow).catch(() => {})
      return await prepared.commit()
    })()
  }
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
    if (sessionId !== undefined && sessionId !== entry.sessionId) {
      throw Object.assign(new Error('Only the owning session can answer this approval'), { code: 'bot/forbidden' })
    }
    if (choice === 'always') return answerAlways(entry)
    if (typeof choice !== 'string' || !Object.hasOwn(OUTCOMES, choice)) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    const outcome = OUTCOMES[choice]
    if (!canPersist()) {
      entry.answer(outcome, 'unaudited', 'unknown')
      return undefined
    }
    entry.settling = true
    // The user's answer stands over the model's: stop a review still under way.
    entry.cancelReview?.()
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
  // A Session that leaves its group (or a task that ends) has no card left to answer from.
  const cancelApprovals = sessionId => {
    for (const entry of pending.values()) {
      if (entry.lineageSessionIds.includes(sessionId)) entry.answer('cancelled')
    }
  }
  const cancelApprovalReviews = ({ botId, roomId } = {}) => {
    for (const entry of pending.values()) {
      if (roomId !== undefined ? entry.roomId === roomId && (botId === undefined || entry.botId === botId) : botId === undefined || (entry.botId === botId && entry.roomId === undefined)) entry.cancelReview()
    }
  }
  ctx.effect?.(() => () => {
    for (const entry of Array.from(pending.values())) entry.answer?.('cancelled')
    pending.clear()
    approvalListeners.clear()
    executions.clear()
    actionScope.disable()
  }, 'ds-bot: approval review')
  const onApproval = listener => { approvalListeners.add(listener); return () => approvalListeners.delete(listener) }
  const isPrivacyApproval = id => pending.get(id)?.privacy === true

  // On a node, an approval reaches the hub as a card in the roster report (node-cards.js) and is answered
  // there with bot/action card-answer. The roster goes out every few seconds; publish at once when a card
  // opens or settles so the hub shows it (and drops it) without that wait.
  onApproval(() => { void Promise.resolve(rt.publishSkillRoster?.()).catch(() => {}) })

  Object.assign(rt, { approvalsView, approvalById, approvalReviewsView, waitsForApproval, answerApproval, cancelApprovals, cancelApprovalReviews, onApproval, requestActionApproval, isPrivacyApproval })
}
