// Delivery: how one Bot, the user, or DS Bot itself puts a message into a Bot Session.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HISTORY_TIMEOUT_MS, LONG_HEAD, MESSAGE_INLINE_MAX, READ_LINE_MAX, SOURCE_KIND, TEXT_KEPT, TEXT_SHOW_MAX } from './constants.js'
import { joinedShadow, refuseJoinedDispatch } from './roster-join.js'
import { headOf, textOf } from './text.js'
import { classify } from './msg-classes.js'
import { sameConversation, threadCurrentOfPart } from './threads.js'

// For remote dispatch, control is local, an answer is refused, everything else is work.
// An answer is not new work: never dispatch it to another machine.
const ANSWER_ROLES = new Set(['reply', 'report', 'results'])

export function install(rt) {
  const { ctx, state } = rt
  const visibleTurns = new WeakMap()
  // A delivery waiting for its Bot's turn, by Bot and message: the same message sent again meanwhile is not queued twice (D6).
  const queuedDeliveries = new Set()
  let disposed = false
  ctx.effect?.(() => () => { disposed = true }, 'ds-bot: visible delivery turns')

  const resolveAgent = async (sessionId) => {
    if (ctx.fiber?.uid === null || ctx.sessionController === undefined) {
      throw Object.assign(new Error('Plugin context is inactive'), { code: 'plugin/disposed' })
    }
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw Object.assign(new Error(resolved.error?.message ?? 'Session unavailable'), { code: resolved.error?.code })
    rt.hideBotUnusedTools(resolved.agent)
    return resolved.agent
  }

  const headerFor = (role, fromName, roomName, audience, note, deferred = false, { resumed = false, retried = false, resent = false, abandoned = false, abandonedReason, asker } = {}) => {
    const label = note ?? 'new message'
    const reportLabel = note ?? 'replies to your post'
    // What came back for work another Bot gave this one says where its answer goes.
    const goesOn = asker === undefined ? '' : ` · for the work ${asker} asked you for; your answer goes to ${asker} once everything you handed on is back`
    // Silent one-way notices keep their exact header regardless of deferred/resent flags.
    if (role === 'note') return `[Note from ${fromName} · FYI only, no reply needed]`
    // Everything a Bot handed on for one work, back together: it goes on with that work now (work model, W1).
    const allBack = asker === undefined ? ' · everything you handed on is back' : ` · everything you handed on for the work ${asker} asked you for is back; your answer goes to ${asker}`
    if (role === 'results' && deferred) return `[Work handed back to you · from ${note} · you read it during your last task; go on with that work now${allBack}]`
    if (role === 'results') return `[Work handed back to you · from ${note}${allBack}]`
    // A wait the user gave up reads as its own thing: the other Bot never answered.
    if (abandoned && abandonedReason === 'restart') return `[${fromName} did not complete the work before DeepSeek Harness restarted${goesOn}]`
    if (abandoned) return `[Waiting given up · ${fromName} did not hand back this work; go on with the work it was for${goesOn}]`
    if (deferred && role === 'reply') return `[Reply from ${fromName} · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role === 'report') return `[Group chat "${roomName}" · ${reportLabel} · you read them during your last task; go on with the work they are for now${goesOn}]`
    if (deferred && role === 'task-report') return `[Background task report · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role !== 'room') return `[Message from ${fromName} · you read it during your last task; answer it now]`
    // DS Bot's own retry after a failed model call says why (fork.129); the user's Retry has no note.
    if (role === 'continue' && note !== undefined) return `[Retry after a failed turn · ${note}]`
    if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
    if (resumed && role === 'resume') return '[DeepSeek Harness restarted while you were working]'
    if (resumed && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted while you were working on it]`
    if (resent && role === 'reply') return `[Reply from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (resent && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (role === 'reply') return `[Reply from ${fromName}${goesOn}]`
    if (role === 'stopped') return `[Stopped by ${fromName}]`
    if (role === 'room') return `[Group chat "${roomName}" · ${label}]`
    if (role === 'report') return `[Group chat "${roomName}" · ${reportLabel}${goesOn}]`
    if (role === 'kickoff') return '[Bot team setup]'
    if (role === 'continue') return '[Retry after a failed turn]'
    // The editor can be the user or a Bot (its own tool call, or a Main Bot's):
    // the header stays neutral about who changed the profile.
    if (role === 'update') return '[Your profile was updated — follow the latest version]'
    if (role === 'secret') return '[Secret card]'
    if (role === 'task') return `[Background task · ${label}]`
    if (role === 'task-followup') return `[Follow-up from your own chat · ${label}]`
    if (role === 'task-report') return `[Background task report · ${label}${goesOn}]`
    if (audience === 'user') return `[Message from ${fromName} · the user sees your reply here]`
    return `[Message from ${fromName}]`
  }


  // Silent (zero-wake) messages buffered while a target Session is busy.
  // In real DSH (`dsh-agent-loop`), `agent.inject()` puts messages into `inbox.nextStep`,
  // which while `agent.status === 'running'` forces an extra step or starts a spurious
  // turn when checked at `turnEnds`. Buffering until idle (and prepending before step 1
  // via `agent/pre-step` if another turn starts first) guarantees true zero-wake AND
  // deterministic causal ordering ahead of queued delegations. Persisted in `inflight.json`
  // with no silent drop cap so notices survive restarts and bursts intact.
  /** @type {Map<string, {message:any, ledger?:{book:string, id:string, sessionId:string, failureRequestId?:string, work?:string}}[]>} */
  const pendingSilent = new Map()
  const flushingSilent = new Set()
  const isBusyAgent = (agent, sessionId) => agent?.status === 'running' || rt.live?.get(sessionId)?.turn !== undefined
  const syncSilent = (sessionId) => { rt.noteSilent?.(sessionId, pendingSilent.get(sessionId)) }
  const waitIdleBriefly = (agent, timeoutMs = 2000) => {
    if (typeof agent?.whenIdle !== 'function') return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } }
      const timer = setTimeout(done, timeoutMs)
      timer?.unref?.()
      Promise.resolve(agent.whenIdle()).then(done, done)
    })
  }
  const markSilentDelivered = (entries, overrideSessionId) => {
    const writes = []
    for (const entry of entries ?? []) {
      const ledger = entry?.ledger
      if (ledger?.book === undefined) continue
      rt.ledger.append(ledger.book, {
        event: 'delivered',
        id: ledger.id,
        sessionId: overrideSessionId ?? ledger.sessionId,
        time: Date.now(),
        ...(typeof ledger.failureRequestId === 'string' && ledger.failureRequestId !== '' ? { failureRequestId: ledger.failureRequestId } : {}),
        ...(typeof ledger.work === 'string' && ledger.work !== '' ? { work: ledger.work } : {}),
      })
      writes.push(rt.ledger.written(ledger.book).catch(() => {}))
    }
    return writes.length > 0 ? Promise.all(writes) : Promise.resolve()
  }
  const bufferSilent = (sessionId, message, agent, ledger) => {
    const list = pendingSilent.get(sessionId) ?? []
    const exchangeId = message?.source?.exchangeId
    if (exchangeId !== undefined && list.some(item => item?.message?.source?.exchangeId === exchangeId)) return
    list.push({ message, ...(ledger !== undefined ? { ledger } : {}) })
    pendingSilent.set(sessionId, list)
    syncSilent(sessionId)
    if (typeof agent?.whenIdle === 'function') {
      void Promise.resolve(agent.whenIdle()).then(() => flushSilentNotes(sessionId)).catch(() => {})
    }
  }
  const putBackSilentNotes = (sessionId, entries) => {
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(entries) || entries.length === 0) return
    const existing = pendingSilent.get(sessionId) ?? []
    const existingIds = new Set(existing.map(item => item?.message?.source?.exchangeId).filter(Boolean))
    const restored = entries.filter(item => {
      if (item?.message === undefined) return false
      const exId = item.message?.source?.exchangeId
      return exId === undefined || !existingIds.has(exId)
    })
    if (restored.length === 0) return
    pendingSilent.set(sessionId, [...restored, ...existing])
    syncSilent(sessionId)
  }
  const pendingMessageIds = (agent) => new Set([
    ...(agent?.inbox?.nextStep ?? []),
    ...(agent?.inbox?.nextTurn ?? []),
  ].map(item => item?.id).filter(Boolean))
  const injectIfNotPending = (agent, message, pendingIds) => {
    if (message?.id !== undefined && pendingIds.has(message.id)) return false
    agent.inject(message)
    if (message?.id !== undefined) pendingIds.add(message.id)
    return true
  }
  async function flushSilentNotes(sessionId, { rethrow = false } = {}) {
    if (!pendingSilent.has(sessionId) || flushingSilent.has(sessionId)) return
    if (rt.live?.get(sessionId)?.turn !== undefined) return
    flushingSilent.add(sessionId)
    let queued
    try {
      const agent = await resolveAgent(sessionId).catch(() => undefined)
      if (agent === undefined) {
        if (rt.selfOf?.(sessionId) === undefined) {
          pendingSilent.delete(sessionId)
          syncSilent(sessionId)
        }
        return
      }
      if (isBusyAgent(agent, sessionId)) {
        if (typeof agent.whenIdle === 'function') {
          void Promise.resolve(agent.whenIdle()).then(() => flushSilentNotes(sessionId)).catch(() => {})
        }
        return
      }
      queued = pendingSilent.get(sessionId)
      if (queued === undefined || queued.length === 0) return
      pendingSilent.delete(sessionId)
      const pendingIds = pendingMessageIds(agent)
      for (const entry of queued) injectIfNotPending(agent, entry.message, pendingIds)
      await ctx.sessions.flush(agent.session)
      syncSilent(sessionId)
      void markSilentDelivered(queued, sessionId)
      queued = undefined
    } catch (error) {
      if (queued !== undefined && queued.length > 0) putBackSilentNotes(sessionId, queued)
      if (rethrow) throw error
      rt.warn('ds-bot: flushing silent notes for %s failed: %s', sessionId, error)
    } finally {
      flushingSilent.delete(sessionId)
    }
  }
  const takeSilentEntries = (sessionId) => {
    const queued = pendingSilent.get(sessionId)
    if (queued === undefined) return []
    pendingSilent.delete(sessionId)
    syncSilent(sessionId)
    return queued
  }
  const takeSilentNotes = (sessionId) => takeSilentEntries(sessionId).map(entry => entry.message)
  const moveSilentNotes = (fromSessionId, toSessionId, { awaitFlush = false, rethrow = false } = {}) => {
    if (fromSessionId === undefined || toSessionId === undefined || fromSessionId === toSessionId) return Promise.resolve()
    const entries = takeSilentEntries(fromSessionId)
    if (entries.length > 0) {
      const targetList = pendingSilent.get(toSessionId) ?? []
      const seenIds = new Set(targetList.map(item => item?.message?.source?.exchangeId).filter(Boolean))
      const seenMsgIds = new Set(targetList.map(item => item?.message?.id).filter(Boolean))
      for (const entry of entries) {
        const exId = entry?.message?.source?.exchangeId
        const msgId = entry?.message?.id
        if ((exId !== undefined && seenIds.has(exId)) || (msgId !== undefined && seenMsgIds.has(msgId))) continue
        if (exId !== undefined) seenIds.add(exId)
        if (msgId !== undefined) seenMsgIds.add(msgId)
        targetList.push({
          message: entry.message,
          ...(entry.ledger !== undefined ? { ledger: { ...entry.ledger, sessionId: toSessionId } } : {}),
        })
      }
      pendingSilent.set(toSessionId, targetList)
      syncSilent(toSessionId)
    }
    if (!pendingSilent.has(toSessionId)) return Promise.resolve()
    if (awaitFlush) return flushSilentNotes(toSessionId, { rethrow })
    queueMicrotask(() => void flushSilentNotes(toSessionId))
    return Promise.resolve()
  }
  async function restoreSilentNotes(savedMap) {
    if (savedMap === null || typeof savedMap !== 'object') return
    const touched = new Set()
    for (const [oldSid, list] of Object.entries(savedMap)) {
      if (!Array.isArray(list) || list.length === 0) continue
      const botId = rt.selfOf?.(oldSid)
      const bot = botId === undefined ? undefined : rt.botOf(botId)
      if (bot === undefined) continue
      const groupOwner = rt.groupOwners?.get(oldSid)
      const destSid = groupOwner !== undefined
        ? (rt.roomOf(groupOwner.roomId)?.sessions?.[botId] ?? oldSid)
        : (threadCurrentOfPart(bot, oldSid) ?? (rt.isBotSession?.(oldSid) ? oldSid : rt.chatOf(botId)))
      if (destSid === undefined) continue
      const destList = pendingSilent.get(destSid) ?? []
      const seenIds = new Set(destList.map(item => item?.message?.source?.exchangeId).filter(Boolean))
      for (const raw of list) {
        const message = raw?.message
        if (message === undefined) continue
        const exId = message?.source?.exchangeId
        if (exId !== undefined && seenIds.has(exId)) continue
        if (exId !== undefined) seenIds.add(exId)
        destList.push({
          message,
          ...(raw.ledger !== undefined ? { ledger: { ...raw.ledger, sessionId: destSid } } : {}),
        })
      }
      if (destList.length > 0) {
        pendingSilent.set(destSid, destList)
        syncSilent(destSid)
        touched.add(destSid)
      }
    }
    for (const sid of touched) await flushSilentNotes(sid)
  }
  const injectSilent = (sessionId, message, agent, ledger) => {
    if (isBusyAgent(agent, sessionId)) {
      bufferSilent(sessionId, message, agent, ledger)
      return false
    }
    injectIfNotPending(agent, message, pendingMessageIds(agent))
    return true
  }

  const NON_WAKING_PRE_STEP_KINDS = new Set([
    'working-directory', 'runtime-context', 'time-context', 'ds-bot-time-context',
    'bot-memory', 'skill-catalog', 'compact-checkpoint', 'snapshot',
  ])
  const isWakingPreStepMessage = (msg) => {
    const src = msg?.source
    if (src === undefined) return true
    if (src.form === 'snapshot' || NON_WAKING_PRE_STEP_KINDS.has(src.kind)) return false
    if (src.kind === SOURCE_KIND && (src.silent === true || ['note', 'cancelled'].includes(src.role))) return false
    return true
  }

  // Deterministically prepend any buffered silent notices before step 1 of a real
  // waking turn so queued work (e.g. a request queued after a silent note) never runs
  // ahead of them, while never waking an empty or snapshot-only wake boundary.
  ctx.on?.('agent/pre-step', async ({ agent, step, messages, signal }, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || signal?.aborted || !Array.isArray(decision?.messages)) return decision
    if (step !== 1 || !decision.messages.some(isWakingPreStepMessage) || (Array.isArray(messages) && !messages.some(isWakingPreStepMessage))) return decision
    if (!pendingSilent.has(agent.id)) return decision
    const entries = takeSilentEntries(agent.id)
    if (entries.length === 0) return decision
    const alreadyIds = new Set(decision.messages.map(m => m?.id).filter(Boolean))
    const alreadyExchanges = new Set(decision.messages.map(m => m?.source?.exchangeId).filter(Boolean))
    const toPrepend = entries
      .map(entry => entry.message)
      .filter(msg => (msg?.id === undefined || !alreadyIds.has(msg.id))
        && (msg?.source?.exchangeId === undefined || !alreadyExchanges.has(msg.source.exchangeId)))
    void markSilentDelivered(entries, agent.id)
    if (toPrepend.length === 0) return decision
    return {
      ...decision,
      messages: [...toPrepend, ...decision.messages],
    }
  })

  // Roles recorded as team exchanges.
  const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped'])
  const TASK_ROLES = new Set(['task', 'task-followup', 'task-report'])
  // Drawn as one line from its `kind: 'bot'` source (who handed back), never as text the user typed.
  const RESULT_ROLES = new Set(['results'])

  // What two Bots say to each other is in the book of the pair (ledger.js), whole, written
  // before the message goes out. A message is shown once a record says it was delivered.
  const pairBook = (a, b) => `pair-${[String(a), String(b)].sort().join('-')}`
  // A pair's book starts from the exchanges a team kept in state.json before the ledger.
  rt.ledger.importer('pair-', book => state.exchanges
    .filter(entry => entry.from !== undefined && entry.to !== undefined && pairBook(entry.from, entry.to) === book)
    .map(entry => ({ ...entry, delivered: true })))
  // Incremental per-pair index cache: advances only over newly appended records and
  // rebuilds in O(1) detection whenever `ledger.js` replaces the array reference
  // (rollback, prepend, drop, or read-only reload).
  const pairCache = new Map()
  function pairRecords(a, b) {
    const book = pairBook(a, b)
    const records = rt.ledger.records(book)
    let cache = pairCache.get(book)
    if (cache === undefined || cache.ref !== records || cache.count > records.length) {
      cache = {
        ref: records,
        peers: [String(a), String(b)],
        count: 0,
        written: new Map(),
        shown: new Map(),
        marks: [],
        replies: new Map(),
        failures: new Map(),
      }
      pairCache.set(book, cache)
    }
    const indexShown = (record) => {
      cache.shown.set(record.id, record)
      if (record.role === 'reply' && typeof record.replyTo === 'string' && record.replyTo !== '') {
        cache.replies.set(`${record.from}\u0000${record.to}\u0000${record.replyTo}`, record)
        // A request whose answer came back was delivered, whether or not its own mark was kept: a
        // dispatch to a node leaves no Session on this machine to mark, so older books hold such
        // requests written but never marked.
        if (cache.written.has(record.replyTo) && !cache.shown.has(record.replyTo)) cache.shown.set(record.replyTo, cache.written.get(record.replyTo))
      }
    }
    for (let i = cache.count; i < records.length; i += 1) {
      const record = records[i]
      if (record.event === 'delivered') {
        const message = cache.written.get(record.id)
        if (message !== undefined) indexShown(message)
        cache.marks.push(record)
        if (typeof record.failureRequestId === 'string' && record.failureRequestId !== '') {
          let list = cache.failures.get(record.failureRequestId)
          if (list === undefined) { list = []; cache.failures.set(record.failureRequestId, list) }
          list.push(record)
        }
      } else if (record.event === undefined) {
        cache.written.set(record.id, record)
        if (record.delivered === true) indexShown(record)
      }
    }
    cache.count = records.length
    return cache
  }
  // In the order they were sent; messages of the same millisecond keep the order they were written to the book.
  const pairMessages = (a, b) => {
    const { shown, written } = pairRecords(a, b)
    const at = new Map([...written.keys()].map((id, index) => [id, index]))
    return [...shown.values()].sort((x, y) => ((x.time ?? 0) - (y.time ?? 0)) || ((at.get(x.id) ?? 0) - (at.get(y.id) ?? 0)))
  }

  // A message between two Bots of other machines that this hub carried (bot/assign relay): kept in their
  // pair's book here too, so the hub's exchange view shows node-to-node conversations.
  rt.recordPairMessage = async ({ from, to, id, role, text, replyTo }) => {
    if (typeof id !== 'string' || id === '' || rt.botOf(from) === undefined || rt.botOf(to) === undefined) return
    const book = pairBook(from, to)
    if (rt.ledger.records(book).some(record => record.event === undefined && record.id === id)) return
    rt.ledger.append(book, { id, from, to, role, text, time: Date.now(), ...(replyTo ? { replyTo } : {}) })
    await rt.ledger.written(book).catch(() => {})
  }

  // A message that left for another machine (bot/assign) is shown in the pair's view once that machine
  // has it: the ack marks it delivered, as a Session marks a local one.
  rt.markPairDelivered = async (a, b, id) => {
    if (typeof id !== 'string' || id === '') return
    const book = pairBook(a, b)
    if (rt.ledger.records(book).some(record => record.event === 'delivered' && record.id === id)) return
    rt.ledger.append(book, { event: 'delivered', id, time: Date.now() })
    await rt.ledger.written(book).catch(() => {})
  }

  function dropBotLedgers(botId) {
    if (typeof botId !== 'string' || botId === '') return
    const booksToDrop = new Set()
    for (const otherId of Object.keys(state.bots ?? {})) {
      if (otherId !== botId) booksToDrop.add(pairBook(botId, otherId))
    }
    for (const [book, cache] of pairCache.entries()) {
      if (cache.peers?.includes(botId)) booksToDrop.add(book)
    }
    for (const book of booksToDrop) {
      pairCache.delete(book)
      rt.ledger.drop(book)
    }
    if (Array.isArray(state.exchanges) && state.exchanges.length > 0) {
      state.exchanges = state.exchanges.filter(entry => entry?.from !== botId && entry?.to !== botId)
    }
  }

  // One-time transparent migration for teams saved before the pair ledger (#1316):
  // durably moves legacy `state.exchanges` entries into `bot/ledger/pair-*.jsonl`
  // without losing entries for books that already exist on disk, and keeps any pair's
  // entries fail-closed in `state.exchanges` if its ledger write fails.
  async function migrateLegacyExchanges() {
    if (rt.readOnly?.() !== undefined || !Array.isArray(state.exchanges) || state.exchanges.length === 0) return false
    const snapshot = state.exchanges.slice()
    const byBook = new Map()
    const migratedRefs = new Set()
    for (const entry of snapshot) {
      if (!entry || typeof entry !== 'object') {
        migratedRefs.add(entry)
        continue
      }
      const from = typeof entry.from === 'string' && entry.from !== '' ? entry.from : undefined
      const to = typeof entry.to === 'string' && entry.to !== '' ? entry.to : undefined
      if (from === undefined || to === undefined || rt.botOf(from) === undefined || rt.botOf(to) === undefined) {
        // Legacy records for deleted Bots or non-Bot senders cannot be opened as a pair chat.
        migratedRefs.add(entry)
        continue
      }
      const book = pairBook(from, to)
      let bucket = byBook.get(book)
      if (bucket === undefined) {
        bucket = []
        byBook.set(book, bucket)
      }
      bucket.push(entry)
    }
    for (const [book, entries] of byBook.entries()) {
      const ok = await rt.ledger.mergeRecords(book, entries.map(entry => ({ ...entry, delivered: true })))
      if (ok) {
        for (const entry of entries) migratedRefs.add(entry)
      }
    }
    if (migratedRefs.size === 0) return false
    const before = state.exchanges.length
    state.exchanges = state.exchanges.filter(entry => !migratedRefs.has(entry))
    return state.exchanges.length !== before
  }

  function deliveredReplyOf(fromId, toId, replyTo) {
    if (typeof fromId !== 'string' || fromId === '' || typeof replyTo !== 'string' || replyTo === '') return undefined
    if (typeof toId === 'string' && toId !== '') {
      if (rt.botOf(fromId) !== undefined && rt.botOf(toId) !== undefined) {
        const found = pairRecords(fromId, toId).replies.get(`${fromId}\u0000${toId}\u0000${replyTo}`)
        if (found !== undefined) return found
      }
      return (state.exchanges ?? []).findLast(entry => entry.from === fromId && entry.to === toId && entry.role === 'reply' && entry.replyTo === replyTo)
    }
    if (rt.botOf(fromId) !== undefined) {
      for (const otherId of Object.keys(state.bots ?? {})) {
        if (otherId === fromId) continue
        const found = pairRecords(fromId, otherId).replies.get(`${fromId}\u0000${otherId}\u0000${replyTo}`)
        if (found !== undefined) return found
      }
    }
    return (state.exchanges ?? []).findLast(entry => entry.from === fromId && entry.role === 'reply' && entry.replyTo === replyTo)
  }

  const wasReplyDelivered = (fromId, toId, replyTo) => deliveredReplyOf(fromId, toId, replyTo) !== undefined

  function deliveredFailuresOf(fromId, toId, requestId, targetSessionId, parentWork) {
    if (typeof fromId !== 'string' || typeof toId !== 'string' || typeof requestId !== 'string' || requestId === '') return []
    if (rt.botOf(fromId) === undefined || rt.botOf(toId) === undefined) return []
    const wantedWork = typeof parentWork === 'string' && parentWork !== '' ? parentWork : undefined
    const { written, failures } = pairRecords(fromId, toId)
    const marks = failures.get(requestId)
    if (marks === undefined) return []
    const matches = []
    for (const mark of marks) {
      const markWork = typeof mark.work === 'string' && mark.work !== '' ? mark.work : undefined
      if (markWork !== wantedWork) continue
      const message = written.get(mark.id)
      if (message?.from === fromId && message?.to === toId && sameConversation(state, toId, mark.sessionId, targetSessionId)) {
        matches.push({ id: mark.id, replyTo: message.replyTo, work: markWork, sessionId: mark.sessionId })
      }
    }
    return matches
  }

  const wasFailureRequestDelivered = (fromId, toId, requestId, targetSessionId, parentWork) =>
    deliveredFailuresOf(fromId, toId, requestId, targetSessionId, parentWork).length > 0

  // `sessionId` defaults to the recipient's own chat; group turns name its group Session.
  // `deferred`: a request the Bot already read mid-turn, handed back to answer in a
  // turn of its own; its exchange was recorded when it first arrived. `resumed` and
  // `retried` carry on a turn that a restart cut off or that wrote its tool call as
  // text (resume.js, turns.js); their exchange is recorded already too. `resent` is
  // a message a shutdown cancelled; its first send may not have been recorded.
  // `askedBy` is the member whose @mention called a group turn (groups.js).
  // `fromRoomId`: the group whose Session the sender wrote from; the reply goes back
  // to that Session (turns.js). `images` and `files` go along as image and file blocks,
  // which DSH projects for the recipient's model and tools. `length`: the whole message's
  // length when it went as a file (attachLong). `work`: the work (handoffs.js) a
  // result that came back goes on with. `merged`: a request that takes in an earlier
  // one its recipient had not read, under that one's exchange. `fromPart`: the Session
  // of the sending Bot, which a reply comes back to when that is a background part.
  async function deliver({ fromId, fromName: senderName, pairFrom, toId, sessionId, text, role, replyTo, roomId, audience, note, exchangeId = randomUUID(), untilSent = false, steer = false, wake = true, afterCancel = false, deferred = false, resumed = false, retried = false, resent = false, merged = false, abandoned = false, abandonedReason, recordExchange = true, askedBy, fromRoomId, fromPart, images = [], files = [], length, work, taskId, imOrigin, failureRequestId, joinedTurn = false, joinedAsync = false, wait = false, stopped = false, results, resultFrom }) {
    const from = rt.botOf(fromId)
    const to = rt.botOf(toId)
    if (to === undefined) throw Object.assign(new Error(`Unknown Bot ${toId}`), { delivered: false })
    // Joined members have no local model turn to settle the group's waiter.
    // Route their result through the same collection/late-reply path as local members.
    if (role === 'reply' && roomId && joinedShadow(from) && rt.roomOf?.(roomId)) {
      const waiter = rt.roomWaiters?.get(replyTo)
      if (waiter) waiter.resolve(text)
      else await rt.lateRoomReply?.(rt.roomOf(roomId).sessions?.[fromId], { role: 'room', roomId, exchangeId: replyTo }, text)
      return exchangeId
    }
    // On disk before it goes out: a message the book could not keep is not sent, so none is
    // delivered with no record of it. A resend keeps the record it has; only a merged request
    // replaces it with its added text. A joined turn leaves this machine before it reaches a
    // Session, so it is booked here too (below) — a restart after the send still owes it.
    // `pairFrom`: the Bot whose pair book a message the user sends on its behalf belongs to.
    const bookPeer = fromId !== undefined && from !== undefined
      ? fromId
      : (pairFrom !== undefined && rt.botOf(pairFrom) !== undefined ? pairFrom : undefined)
    const book = bookPeer !== undefined && recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried ? pairBook(bookPeer, toId) : undefined
    const writeBook = async () => {
      if (book === undefined) return
      if (!merged && pairRecords(bookPeer, toId).written.has(exchangeId)) return
      rt.ledger.append(book, { id: exchangeId, from: fromId ?? 'user', to: toId, role, text, time: Date.now(), ...(length !== undefined ? { length, files } : {}), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}), ...(roomId ? { roomId } : {}) })
      await rt.ledger.written(book)
    }
    // A joined shadow is visible in the sidebar. Step 2 sends the turn to that
    // remote Bot. If the handler is not installed, keep the step-1 refusal and
    // do not fall through to a local session or handleRemoteTurn.
    const refused = refuseJoinedDispatch(to)
    // Work for a Bot of another machine leaves as `work/handoff` (bot-link.js, work model W3), never from here; what
    // still reaches a joined shadow here is a group round, a page turn, or a message the user is meant to read.
    if (refused) {
      if (!ANSWER_ROLES.has(role) && classify(role) !== 'control' && typeof rt.handleJoinedTurn === 'function') {
        await writeBook()
        // joinedAsync remains accepted for older callers; only wait:true opts out of deferral.
        const outcome = await rt.handleJoinedTurn({ fromId, toId, text, role, exchangeId, replyTo, work, ...(roomId ? { roomId, roomName: rt.roomOf?.(roomId)?.name } : {}), defer: wait !== true, ...(joinedAsync ? { joinedAsync: true } : {}), ...(stopped === true ? { stopped: true } : {}) })
        // The node has the request (an offline node or a refused dispatch answers `{ ok: false }` and
        // stays unmarked). The pair's view shows a message once it is marked: with no Session here to
        // take it up, this is the only place the request can be.
        if (book !== undefined && !(outcome !== null && typeof outcome === 'object' && outcome.ok === false)) {
          rt.ledger.append(book, { event: 'delivered', id: exchangeId, sessionId: sessionId ?? rt.chatOf(toId), time: Date.now(), ...(typeof work === 'string' && work !== '' ? { work } : {}) })
          await rt.ledger.written(book).catch(() => {})
        }
        return outcome
      }
      return refused
    }
    // A peer row is another machine's Bot: nothing reaches it from here (work goes over bot-link.js), and it never
    // falls through to a local Session.
    if (to.origin === 'peer') return { ok: false, error: 'E_PEER_READONLY' }
    // Worker Bot routing: dispatch to the remote hub instead of a local Session turn.
    // Phase 1: remote-worker dispatch path is legacy; joined (origin:'joined') uses handleJoinedTurn.
    // Answers and lifecycle controls keep the local delivery path.
    if (to.type === 'remote-worker' && to.origin !== 'joined'
      && rt.handleRemoteTurn !== undefined
      && !ANSWER_ROLES.has(role) && classify(role) !== 'control') {
      return rt.handleRemoteTurn({ fromId, toId, text, role, exchangeId, replyTo, work })
    }
    const fromName = senderName ?? from?.name ?? 'You'
    const room = rt.roomOf(roomId)
    const asker = work === undefined ? undefined : rt.botOf(state.works?.[work]?.from)?.name
    // Session events reject `undefined` members, so optional fields are omitted instead.
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      senderName: fromName,
      ...(wake === false ? { silent: true } : {}),
      ...(work ? { work } : {}),
      ...(taskId ? { taskId } : {}),
      ...(imOrigin ? { imOrigin } : {}),
      ...(fromId ? { senderSessionId: fromId } : {}),
      ...(fromPart ? { senderPart: fromPart } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(roomId ? { roomId } : {}),
      ...(audience === 'user' ? { audience } : {}),
      ...(deferred ? { deferred: true } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(retried ? { retried: true } : {}),
      ...(askedBy ? { askedBy } : {}),
      ...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
      ...(joinedTurn ? { joinedTurn: true } : {}),
      ...(abandoned ? { abandoned: true } : {}),
      ...(Array.isArray(results) && results.length > 0 ? { results } : {}),
      ...(Array.isArray(resultFrom) && resultFrom.length > 0 ? { resultFrom } : {}),
      ...(role === 'results' && note ? { note } : {}),
    }
    const targetSessionId = sessionId ?? rt.chatOf(toId)
    await writeBook()
    await rt.ensureCapabilities(targetSessionId)
    const agent = await resolveAgent(targetSessionId)
    const message = createUserMessage({
      content: [
        { type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried, resent, abandoned, abandonedReason, asker })}\n${text}` },
        ...images.map(attachment => ({ type: 'image', attachment })),
        ...files.map(attachment => ({ type: 'file', attachment })),
      ],
      source,
    })
    // The book holds the text already; its mark says the message went out. A mark
    // that is lost only hides it from the dialog.
    const ledgerMeta = book !== undefined
      ? {
          book,
          id: exchangeId,
          sessionId: targetSessionId,
          ...(typeof failureRequestId === 'string' && failureRequestId !== '' ? { failureRequestId } : {}),
          ...(typeof work === 'string' && work !== '' ? { work } : {}),
        }
      : undefined
    const markDelivered = () => markSilentDelivered([{ ledger: ledgerMeta }])
    // A non-waking notice is put into the conversation only while it is idle (buffered until then, or prepended
    // before step 1 of the next turn), so DSH never runs an extra model step or starts a turn for it.
    if (wake === false) {
      if (afterCancel && isBusyAgent(agent, targetSessionId)) await waitIdleBriefly(agent)
      if (injectSilent(targetSessionId, message, agent, ledgerMeta)) {
        await ctx.sessions.flush(agent.session)
        if (book !== undefined) await markDelivered()
      }
      return exchangeId
    }
    // A message between Bots is an event line ("Reply from X", opened for the whole text), as it is
    // between Bots on one machine: it keeps `kind: 'bot'`, so it is not drawn as something the
    // user typed. Other visible roles (group, report, task) are still written as user text.
    // Background task roles (DS Bot 0.3.10) are drawn by the task bar from their `kind: 'bot'` source, not as text the user typed.
    const visible = classify(role) === 'visible' && !EXCHANGE_ROLES.has(role) && !TASK_ROLES.has(role) && !RESULT_ROLES.has(role) && typeof agent.session?.append === 'function'
    if (visible) {
      // The chat projector renders user sources verbatim; relay sources show only an
      // exchange link. Keep the relay metadata on the wake that owns the next turn.
      agent.session.append('user/message', { ...message, source: { ...source, kind: 'user' } }, { surfaceOp: 'append' })
      await ctx.sessions.flush(agent.session)
    }
    // A teammate's answer never steers into a running turn (work model, docs/plans/2026-11-24-work-model.md):
    // it waits for that conversation to be idle, behind the serial gate below.
    const send = async () => {
      if (visible) {
        // The content is already in model history. An empty, deferred relay wakes the
        // agent without rendering or admitting that content a second time. Never wait
        // for the sender's active turn here: it may itself be awaiting this delivery.
        const wake = createUserMessage({ content: [], source: { ...source, deferred: true } })
        const previous = visibleTurns.get(agent) ?? Promise.resolve()
        const pending = previous.catch(() => {}).then(async () => {
          await agent.whenIdle()
          if (disposed) return
          agent.followup(wake)
          await agent.whenIdle()
          await ctx.sessions.flush(agent.session)
        })
        visibleTurns.set(agent, pending)
        void pending.catch(error => rt.warn('ds-bot: visible delivery turn failed: %s', error)).finally(() => {
          if (visibleTurns.get(agent) === pending) visibleTurns.delete(agent)
        })
      } else {
        // Notices buffered while the conversation was busy go in ahead of this message.
        const takenSilent = !isBusyAgent(agent, targetSessionId) && pendingSilent.has(targetSessionId)
          ? takeSilentEntries(targetSessionId)
          : []
        let woke = false
        try {
          const pendingIds = pendingMessageIds(agent)
          for (const entry of takenSilent) injectIfNotPending(agent, entry.message, pendingIds)
          if (steer) agent.steer(message)
          else agent.followup(message)
          woke = true
        } catch (error) {
          if (takenSilent.length > 0) putBackSilentNotes(targetSessionId, takenSilent)
          if (error !== null && typeof error === 'object' && error.delivered === undefined) error.delivered = false
          throw error
        }
        if (woke && takenSilent.length > 0) void markSilentDelivered(takenSilent, targetSessionId)
      }
      await ctx.sessions.flush(agent.session)
      if (book !== undefined) await markDelivered()
    }
    // Steering bypasses the serial gate; visible input still waits for its own turn.
    if (steer) {
      await send()
      return exchangeId
    }
    // Visible input is already on the timeline; the serial gate orders its wake
    // behind the Bot's current turn (thread-model §4.5).
    const run = async () => {
      await send()
    }
    if (typeof rt.sendThreadTurn === 'function') {
      // The same message waiting for this Bot already (sent again before the first went out) is not queued twice.
      const key = `${toId}\u0000${exchangeId}`
      if (queuedDeliveries.has(key)) return exchangeId
      // The Session decides the Bot; a group's own Session has no Bot and stays ungated.
      const full = rt.bySessionIdFull?.(targetSessionId)
      const bot = full === undefined ? (targetSessionId === rt.chatOf(toId) ? to : undefined) : undefined
      const threadId = full?.threadId ?? (bot === undefined ? undefined : rt.mainThreadOf?.(bot.id)?.id)
      queuedDeliveries.add(key)
      // With `untilSent`, a delivery that waits for its turn resolves once it went out, and fails if it could not:
      // the caller can send it again (what comes back for a work must not be lost in the queue).
      let settle
      const sent = new Promise((resolve, reject) => { settle = { resolve, reject } })
      sent.catch(() => {})
      let outcome
      try {
        outcome = await rt.sendThreadTurn({
          botId: full?.botId ?? bot?.id, threadId, sessionId: targetSessionId, kind: 'dispatch', preview: text,
          onCancel: () => { queuedDeliveries.delete(key); settle.reject(new Error('the delivery was withdrawn before it went out')) },
          run: async () => {
            try { await run(); settle.resolve() } catch (error) { settle.reject(error); throw error } finally { queuedDeliveries.delete(key) }
          },
        })
      } finally {
        if (outcome?.queued !== true) queuedDeliveries.delete(key)
      }
      if (untilSent && outcome?.queued === true) await sent
    } else {
      await run()
    }
    return exchangeId
  }

  // A message between Bots, whole, from the Session it was delivered to: the message
  // there is its header line, then the text. `whole` is false when only the start could
  // be read (the Session is gone, or the message is past what the dialog shows).
  async function exchangeText(entry) {
    // A message of the ledger is whole there, or in its file when it went as one.
    if (entry.ledger === true && entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: headOf(entry.text, TEXT_SHOW_MAX), whole: false }
    if (entry.ledger === true) return { text: headOf(entry.text, TEXT_SHOW_MAX), whole: entry.text.length <= TEXT_SHOW_MAX }
    if (entry.length === undefined) return { text: entry.text, whole: true }
    if (entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: entry.text, whole: false }
    try {
      for await (const event of rt.eventsBackwards(entry.sessionId ?? rt.chatOf(entry.to), AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        if (event.type !== 'user/message' || event.data?.source?.exchangeId !== entry.id) continue
        const delivered = textOf(event.data.content)
        const text = delivered.slice(delivered.indexOf('\n') + 1)
        return { text: headOf(text, TEXT_SHOW_MAX), whole: text.length <= TEXT_SHOW_MAX }
      }
    } catch (error) {
      rt.warn('ds-bot: message %s not read back: %s', entry.id, error)
    }
    return { text: entry.text, whole: false }
  }

  // A message a Bot sends past MESSAGE_INLINE_MAX goes as a DSH file: it is stored once,
  // not in every Session it reaches, and the model reads it with its file tools when it
  // needs it. Undefined when this DSH cannot store files.
  async function attachLong(text, name) {
    if (text.length <= MESSAGE_INLINE_MAX) return { text, files: [] }
    try {
      const file = await ctx.get?.('attachments')?.saveFile({ data: new TextEncoder().encode(text), name })
      if (file === undefined) return undefined
      // The file stays verbatim, so a line past what the read tool shows needs another way.
      const wide = text.split('\n').some(line => line.length > READ_LINE_MAX)
      const note = `[A long message: ${text.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.${wide ? ` Some lines are longer than the ${READ_LINE_MAX} characters the read tool shows of a line; read those with a shell command.` : ''}]`
      return { text: `${note}\n${headOf(text, LONG_HEAD)}…`, files: [file], length: text.length }
    } catch (error) {
      rt.warn('ds-bot: long message not stored as a file: %s', error)
      return undefined
    }
  }

  // The text of a stored file, limited to what the dialogs show by default.
  async function fileText(file, maxLength = TEXT_SHOW_MAX) {
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined) return undefined
    const decoder = new TextDecoder()
    let text = ''
    try {
      for await (const chunk of attachments.readFileStream(file, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        text += decoder.decode(chunk, { stream: true })
        if (text.length > maxLength) return { text: headOf(text, maxLength), whole: false }
      }
    } catch (error) {
      rt.warn('ds-bot: file %s not read: %s', file?.name, error)
      return undefined
    }
    text += decoder.decode()
    return { text, whole: true }
  }


  // ── Worker Bot reply helpers (Subtask B) ──────────────────────────────────
  // deliverHandoff: formats a remote_handoff result as a Bot reply and delivers it.
  // deliverProgress: sends a live progress note as an intermediate message.

  rt.deliverHandoff = async function deliverHandoff(sessionId, { exchangeId, fromId, toId, work, handoffResult }) {
    try {
      let text
      if (handoffResult?.isError) {
        text = `[远程任务失败: ${handoffResult.value ?? 'unknown error'}]`
      } else {
        const h = handoffResult?.value
        const status = h?.status ?? '已结束'
        const exit = typeof h?.exit?.code === 'number' ? ` (exit ${h.exit.code})` : ''
        const summary = typeof h?.summary?.text === 'string' && h.summary.text.trim() !== ''
          ? `\n\n${h.summary.text.trim()}`
          : ''
        text = `[任务 ${status}${exit}]${summary}`
      }
      const long = await rt.attachLong?.(text, 'handoff.txt')
      void rt.deliver?.({
        fromId, toId,
        text: long?.text ?? text,
        ...(long?.files?.length ? { files: long.files, length: long.length } : {}),
        role: 'reply',
        replyTo: exchangeId,
        ...(work ? { work } : {}),
      }).catch(err => rt.warn('ds-bot: deliverHandoff failed: %s', err))
    } catch (err) {
      rt.warn('ds-bot: deliverHandoff error: %s', err)
    }
  }

  rt.deliverProgress = async function deliverProgress(sessionId, { fromId, toId, text }) {
    try {
      if (!text || !fromId || !toId) return
      void rt.deliver?.({
        fromId, toId,
        text: `[进度] ${text}`,
        role: 'reply',
      }).catch(err => rt.warn('ds-bot: deliverProgress failed: %s', err))
    } catch (err) {
      rt.warn('ds-bot: deliverProgress error: %s', err)
    }
  }
  const exchangesOf = (a, b) => pairMessages(a, b).map((record) => {
    const kept = headOf(record.text ?? '', TEXT_KEPT)
    const { delivered: _delivered, ...rest } = record
    return { ...rest, text: kept, ...(record.length === undefined && kept.length < (record.text ?? '').length ? { length: record.text.length } : {}) }
  })
  const formatExchangeRecord = (record) => {
    if (record === undefined) return undefined
    // Imported from before the ledger: as whole as it was kept then.
    if (record.sessionId !== undefined || (record.length !== undefined && !(record.files?.length > 0))) return record
    return { ...record, ledger: true }
  }
  const exchangeOf = (id, a, b) => formatExchangeRecord(pairRecords(a, b).shown.get(id))
  const exchangeById = (id) => {
    if (typeof id !== 'string' || id === '') return undefined
    for (const cache of pairCache.values()) {
      if (!Array.isArray(cache.peers) || cache.peers.length < 2) continue
      const hit = pairRecords(cache.peers[0], cache.peers[1]).shown.get(id)
      if (hit !== undefined) return formatExchangeRecord(hit)
    }
    const botIds = Object.keys(state.bots ?? {})
    for (let i = 0; i < botIds.length; i += 1) {
      for (let j = i + 1; j < botIds.length; j += 1) {
        const book = pairBook(botIds[i], botIds[j])
        if (pairCache.has(book)) continue
        if (typeof rt.ledger.hasBook === 'function' && !rt.ledger.hasBook(book)) continue
        const hit = pairRecords(botIds[i], botIds[j]).shown.get(id)
        if (hit !== undefined) return formatExchangeRecord(hit)
      }
    }
    return (state.exchanges ?? []).find(item => item?.id === id)
  }

  Object.assign(rt, {
    resolveAgent, deliver, flushSilentNotes, takeSilentNotes, takeSilentEntries, putBackSilentNotes,
    markSilentDelivered, moveSilentNotes, restoreSilentNotes, injectSilent, dropBotLedgers,
    migrateLegacyExchanges, exchangeText, attachLong, fileText, exchangesOf, exchangeOf, exchangeById,
    deliveredReplyOf, wasReplyDelivered, deliveredFailuresOf, wasFailureRequestDelivered,
  })
}
