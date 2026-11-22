// thread-queue.js — P1's serial gate: one turn per Bot at a time, the rest FIFO.
//
// Every way a message reaches a Bot's Session goes through `rt.sendThreadTurn`: the web
// send endpoint, the local executor, and team delivery. The gate keeps at most one running
// turn per Bot (`maxParallelThreads = 1`, docs/thread-model.md §4.5) and parks the others
// in an in-memory queue. A queued message is only handed to the Session once the turn in
// front of it ends: the gate arms the Session's `turn/end` listener before it runs the
// message, so a turn that ends before the listener is up cannot strand the queue.
// Waiting user text sends survive a restart in thread-queue.json.
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainThreadId, threadOf } from './bot-store.js'

// A turn the Session accepted but never started (no `turn/start`) would hold the Bot
// forever; past this it is let go once, with a warning, and the queue moves on.
const ACCEPT_WAIT_MS = 60_000
// A Session whose agent sits idle with nothing waiting in its inbox this long after the prompt was
// accepted will never start that turn (an older part, a message the core dropped): let it go early
// instead of holding the Bot for the whole accept wait.
const IDLE_NO_START_MS = 5_000
// How often a running turn that has not started is checked for a failure. A refused turn
// sets `bot.blocked` and may never emit `turn/end` (turns.js), so nothing else tells the
// queue; this is not the accept wait, which stays above.
const FAILURE_POLL_MS = 250
// What a queued message shows in the Bot's queue panel.
const PREVIEW_MAX = 120

/**
 * @param {object} rt
 */
export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {botId: string, running: object|null, entry: object|null, queue: object[]}>} */
  const slots = new Map()

  const slotOf = (botId) => {
    let slot = slots.get(botId)
    if (slot === undefined) {
      slot = { botId, running: null, entry: null, queue: [], state: 'idle', failure: null }
      slots.set(botId, slot)
    }
    return slot
  }

  // Which Bot (and Thread, and Session) a queued action belongs to. `undefined` means
  // the action is not a Bot's own conversation (a group's Session, an unknown part), so
  // the gate stays out of its way and `run` happens at once.
  function ownerOf(spec) {
    const threadId = typeof spec.threadId === 'string' && spec.threadId !== '' ? spec.threadId : undefined
    if (threadId !== undefined) {
      const thread = threadOf(rt.state, threadId)
      if (thread !== undefined) {
        // A local Bot's Main thread has no Session field of its own (the Bot's chat is its
        // Session until a part moves it); resolve that now rather than ungating the Bot.
        const sessionId = thread.sessionId ?? (thread.id === mainThreadId(thread.botId) ? (rt.chatOf?.(thread.botId) ?? null) : null)
        return { botId: thread.botId, threadId: thread.id, sessionId, title: thread.title, thread }
      }
    }
    const sessionId = typeof spec.sessionId === 'string' && spec.sessionId !== '' ? spec.sessionId : undefined
    if (sessionId !== undefined) {
      const full = rt.bySessionIdFull?.(sessionId)
      if (full !== undefined) {
        return { botId: full.botId, threadId: full.threadId, sessionId, title: threadOf(rt.state, full.threadId)?.title }
      }
    }
    if (typeof spec.botId === 'string' && spec.botId !== '' && rt.botOf?.(spec.botId) !== undefined) {
      const threadIdOfBot = mainThreadId(spec.botId)
      return { botId: spec.botId, threadId: threadIdOfBot, sessionId: rt.chatOf?.(spec.botId), title: threadOf(rt.state, threadIdOfBot)?.title }
    }
    return undefined
  }

  const clearWatch = (entry) => {
    if (entry.watch !== undefined) {
      clearTimeout(entry.watch)
      entry.watch = undefined
    }
    if (entry.probe !== undefined) {
      clearInterval(entry.probe)
      entry.probe = undefined
    }
  }

  // The failure a turn left on its Bot, if it left one since it started: `bot.blocked`
  // is written by turns.js (a refused turn, a managed-model failure) and only an
  // earlier-than-this-turn record is not this turn's.
  const failureOf = (entry) => {
    const blocked = rt.botOf?.(entry.botId)?.blocked
    if (blocked === undefined || typeof blocked.code !== 'string') return undefined
    if (typeof blocked.at === 'number' && typeof entry.startedAt === 'number' && blocked.at < entry.startedAt) return undefined
    return blocked
  }

  // running -> failed: record it, show it, release the queue at once. The next message
  // moves failed -> queued (or runs) like any other.
  function fail(entry, failure, { report = true } = {}) {
    const slot = slots.get(entry.botId)
    if (slot === undefined || slot.running?.queueId !== entry.queueId) return
    slot.state = 'failed'
    slot.failure = { code: failure.code, at: Date.now(), threadId: entry.threadId }
    // turns.js already rows a failure that came as an error `turn/end`; one the queue
    // finds on the Bot (a refused turn with no turn/end) gets its row here.
    if (report) {
      rt.noteFailure?.({
        source: 'turn',
        code: failure.code,
        text: failure.message || `the turn failed (${failure.code})`,
        bot: rt.botOf?.(entry.botId)?.name,
        sessionId: entry.sessionId,
        threadId: entry.threadId,
      })
    }
    release(entry)
  }

  // A queued message can be withdrawn (explicit cancel, Session disposal, caller abort)
  // before the turn in front of it ends; then its abort listener must go with it.
  const clearAbort = (entry) => {
    if (entry.onAbort !== undefined) {
      entry.signal?.removeEventListener?.('abort', entry.onAbort)
      entry.onAbort = undefined
    }
  }

  const abortError = () => Object.assign(new Error('This message was cancelled before it started'), { name: 'AbortError', code: 'ABORT_ERR' })
  const runningEntryOf = (sessionId) => {
    for (const slot of slots.values()) {
      if (slot.entry !== null && slot.running?.sessionId === sessionId) return slot.entry
    }
    return undefined
  }

  // Let the running entry go and start the first queued one. Safe to call twice: an
  // entry that already left the running slot is ignored.
  function release(entry) {
    const slot = slots.get(entry.botId)
    if (slot === undefined || slot.running?.queueId !== entry.queueId) return
    clearWatch(entry)
    clearAbort(entry)
    slot.running = null
    slot.entry = null
    if (slot.state !== 'failed') slot.state = 'idle'
    const next = slot.queue.shift()
    if (next !== undefined) {
      void start(slot, next).catch(error => rt.warn?.('ds-bot: queued turn for %s failed: %s', slot.botId, error))
    }
  }

  // The Session's agent is there, idle, and nothing is queued for it: no turn will start from what was sent.
  const idleWithNothingWaiting = (sessionId) => {
    let agent
    try { agent = ctx.get?.('agents')?.get(sessionId) } catch { agent = undefined }
    if (agent === undefined || agent.status !== 'idle') return false
    const inbox = agent.inbox
    return (inbox?.nextStep?.length ?? 0) === 0 && (inbox?.nextTurn?.length ?? 0) === 0
  }

  async function start(slot, entry) {
    // It is this entry's turn: the caller's abort no longer withdraws it, the Session's
    // own `turn/end` (or the watch) releases it from here.
    clearAbort(entry)
    // failed -> queued -> running: a failure does not stop the next message.
    slot.state = 'running'
    slot.failure = null
    slot.running = { queueId: entry.queueId, threadId: entry.threadId, sessionId: entry.sessionId, startedAt: Date.now(), kind: entry.kind }
    slot.entry = entry
    entry.startedAt = slot.running.startedAt
    removePending(entry)
    if (entry.releaseOn === 'turn-end') {
      // Armed before `run`: a Session that starts and ends its turn quickly must still
      // find a listener, and a prompt that is refused must not leave the Bot held.
      entry.watch = setTimeout(() => {
        if (slot.running?.queueId !== entry.queueId) return
        if (entry.sawStart === true) return
        rt.warn?.('ds-bot: a turn for %s was accepted but never started; letting the next one run', entry.sessionId)
        release(entry)
      }, ACCEPT_WAIT_MS)
      entry.watch.unref?.()
      // A failure is not an accept wait: it is seen as soon as the Bot records it.
      entry.probe = setInterval(() => {
        if (slot.running?.queueId !== entry.queueId) return clearWatch(entry)
        if (entry.sawStart === true) return clearWatch(entry)
        const failure = failureOf(entry)
        if (failure !== undefined) return fail(entry, failure)
        if (entry.accepted === true && Date.now() - entry.acceptedAt >= IDLE_NO_START_MS && idleWithNothingWaiting(entry.sessionId)) {
          rt.warn?.('ds-bot: a turn for %s was accepted but its Session is idle with nothing waiting; letting the next one run', entry.sessionId)
          release(entry)
        }
      }, FAILURE_POLL_MS)
      entry.probe.unref?.()
    }
    try {
      await entry.run()
      entry.accepted = true
      entry.acceptedAt = Date.now()
    } catch (error) {
      if (typeof error?.code === 'string' && slot.running?.queueId === entry.queueId) {
        slot.state = 'failed'
        slot.failure = { code: error.code, at: Date.now(), threadId: entry.threadId }
      }
      release(entry)
      throw error
    }
    if (entry.releaseOn === 'turn-end' && slot.running?.queueId === entry.queueId && entry.sawStart !== true) {
      const failure = failureOf(entry)
      if (failure !== undefined) fail(entry, failure)
    }
    // A joined turn's `done` resolves when the node finished the turn, so it releases here.
    if (entry.releaseOn === 'run') release(entry)
  }

  /**
   * Queue one turn for a Bot, or run it now when the Bot is free. Resolves once the
   * turn has been handed to its Session (not once the turn finished), with
   * `{queued: false, queueId}` when it ran now and `{queued: true, queueId, position}`
   * when it waits.
   */
  async function enqueueThreadTurn(spec, restored) {
    if (restored === undefined && ready !== undefined) await ready
    const run = spec?.run
    if (typeof run !== 'function') throw new Error('enqueueThreadTurn needs run()')
    const signal = spec?.signal
    if (signal?.aborted === true) throw abortError()
    const owner = ownerOf(spec)
    if (owner === undefined || typeof owner.sessionId !== 'string' || owner.sessionId === '') {
      await run()
      return { queued: false }
    }
    const entry = {
      queueId: restored?.queueId ?? randomUUID(),
      botId: owner.botId,
      threadId: owner.threadId,
      sessionId: owner.sessionId,
      title: owner.title ?? '',
      kind: spec.kind === 'dispatch' ? 'dispatch' : 'send',
      preview: String(spec.preview ?? '').slice(0, PREVIEW_MAX),
      // A joined turn's `done` ends it, and a team delivery is only handed to the Session
      // (followup + flush + record); neither has a local `turn/end` of its own to wait for.
      releaseOn: spec.releaseOn ?? (spec.kind === 'dispatch' || rt.botOf?.(owner.botId)?.origin === 'joined' ? 'run' : 'turn-end'),
      run,
      enqueuedAt: restored?.enqueuedAt ?? Date.now(),
      startedAt: undefined,
      sawStart: false,
      watch: undefined,
      signal,
      onAbort: undefined,
      onCancel: spec.onCancel,
    }
    const slot = slotOf(owner.botId)
    if (slot.running === null) {
      await start(slot, entry)
      return { queued: false, queueId: entry.queueId }
    }
    slot.queue.push(entry)
    // Bot-only actions (e.g. routines) have their own recovery and no explicit send Session.
    if (path !== undefined && restored === undefined && spec.kind === 'send' && spec.sessionId === owner.sessionId) {
      const text = spec.text ?? spec.preview
      if (hasText(text)) {
        pending.set(entry.queueId, savedItem({ ...entry, text }))
        persist()
      }
    }
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      entry.onAbort = () => {
        const at = slot.queue.findIndex(candidate => candidate.queueId === entry.queueId)
        if (at === -1) return
        slot.queue.splice(at, 1)
        clearAbort(entry)
        cancelled(entry)
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    return { queued: true, queueId: entry.queueId, position: slot.queue.length }
  }

  /** `sendThreadTurn` is the name the rest of the host calls; same gate. */
  async function sendThreadTurn(spec, restored) {
    return await enqueueThreadTurn(spec, restored)
  }

  async function restoreQueue() {
    let file
    try {
      file = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') rt.warn?.('ds-bot: could not read thread-queue.json')
      return
    }
    if (file?.version !== QUEUE_VERSION || !Array.isArray(file.items)) {
      rt.warn?.('ds-bot: invalid thread-queue.json format')
      return
    }
    if (file.items.length === 0) return
    await rt.load()
    if (unloaded() || rt.readOnly?.() !== undefined) return
    const valid = new Map()
    for (const item of file.items) {
      const thread = threadOf(rt.state, item?.threadId)
      if (!hasText(item?.queueId) || !hasText(item.botId) || !hasText(item.sessionId) || typeof item.preview !== 'string' || !hasText(item.text) ||
          !Number.isFinite(item.enqueuedAt) || valid.has(item.queueId) || thread?.botId !== item.botId ||
          thread.archived || rt.botOf(item.botId) === undefined || ownerOf(item)?.sessionId !== item.sessionId) {
        rt.warn?.('ds-bot: skipping invalid or stale thread-queue.json item')
        continue
      }
      valid.set(item.queueId, savedItem(item))
    }
    const items = [...valid.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt)
    // A plugin reload can leave a Session turn running, even on another Thread of
    // this Bot. Reserve its slot until turn/end, without replaying the running turn.
    const botIds = [...new Set(items.map(item => item.botId))]
    const active = await Promise.all(botIds.map(async botId => {
      const sessions = new Set(rt.threadsOfBot(botId).map(thread => ownerOf({ threadId: thread.id })?.sessionId).filter(Boolean))
      const agents = await Promise.all([...sessions].map(async sessionId => ({
        sessionId, agent: await rt.resolveAgent(sessionId).catch(() => undefined),
      })))
      return { botId, agents }
    }))
    if (unloaded()) return
    for (const { botId, agents } of active) {
      const running = agents.find(({ sessionId, agent }) => !endedDuringRestore.has(sessionId) &&
        (agent?.status === 'running' || rt.live?.get(sessionId)?.turn !== undefined))
      if (running === undefined) continue
      const { sessionId } = running
      const threadId = rt.bySessionIdFull?.(sessionId)?.threadId ?? mainThreadId(botId)
      const entry = { queueId: randomUUID(), botId, threadId, sessionId, kind: 'send', startedAt: Date.now(), sawStart: true }
      const slot = slotOf(botId)
      slot.entry = entry
      slot.running = { queueId: entry.queueId, threadId, sessionId, kind: entry.kind, startedAt: entry.startedAt }
      slot.state = 'running'
    }
    for (const item of items) pending.set(item.queueId, item)
    if (valid.size !== file.items.length) persist()
    for (const item of items) {
      const { botId, threadId, sessionId, preview, text } = item
      void rt.sendThreadTurn({
        botId, threadId, sessionId, kind: 'send', preview,
        run: () => rt.sendUser({ sessionId, content: [{ type: 'text', text }] }),
      }, item).catch(error => rt.warn?.('ds-bot: restored thread queue turn for %s failed: %s', botId, error))
    }
  }

  // What the Bot is running and what waits, for the thread list and the queue panel.
  const liveOf = (botId) => {
    const slot = slots.get(botId)
    if (slot === undefined) return { running: null, queued: [] }
    return {
      running: slot.running === null ? null : { ...slot.running },
      queued: slot.queue.map((entry, index) => ({
        queueId: entry.queueId,
        threadId: entry.threadId,
        title: entry.title,
        preview: entry.preview,
        enqueuedAt: entry.enqueuedAt,
        position: index + 1,
      })),
    }
  }

  // Drop a deleted Bot's slot. Its running turn was ended by the deletion itself.
  const forget = (botId) => {
    const slot = slots.get(botId)
    if (slot === undefined) return
    if (slot.entry !== null) clearWatch(slot.entry)
    for (const entry of slot.queue) { clearAbort(entry); cancelled(entry) }
    slots.delete(botId)
  }

  // A Bot deleted while another message waits must not run it after the deletion.
  const dropCancelled = (botId, queueId) => {
    const slot = slots.get(botId)
    if (slot === undefined) return { cancelled: false, remaining: 0 }
    const at = slot.queue.findIndex(entry => entry.queueId === queueId)
    if (at === -1) return { cancelled: false, remaining: slot.queue.length }
    const [gone] = slot.queue.splice(at, 1)
    clearAbort(gone)
    cancelled(gone)
    return { cancelled: true, remaining: slot.queue.length }
  }

  // Stop ends the running turn and leaves its queue in order. For a disposed Session,
  // drop its waiting entries and release the running slot because no turn/end will come.
  const dropSession = (sessionId, options = {}) => {
    if (typeof sessionId !== 'string' || sessionId === '') return 0
    if (options.release !== true && runningEntryOf(sessionId) !== undefined) return 0
    let dropped = 0
    let running
    for (const slot of slots.values()) {
      for (let at = slot.queue.length - 1; at >= 0; at -= 1) {
        const entry = slot.queue[at]
        if (entry.sessionId !== sessionId) continue
        slot.queue.splice(at, 1)
        clearAbort(entry)
        cancelled(entry)
        dropped += 1
      }
      if (slot.entry !== null && slot.entry.sessionId === sessionId) running = slot.entry
    }
    if (options.release === true && running !== undefined) release(running)
    return dropped
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (ready !== undefined) {
      if (event?.type === 'turn/end') endedDuringRestore.add(sessionId)
      if (event?.type === 'turn/start') endedDuringRestore.delete(sessionId)
    }
    const entry = runningEntryOf(sessionId)
    if (entry === undefined) return
    if (event?.type === 'turn/start') {
      entry.sawStart = true
      clearWatch(entry)
      return
    }
    if (event?.type === 'turn/end') {
      const kind = event.data?.reason?.kind
      const failure = kind === 'error' ? { code: event.data.reason.error?.code ?? 'UNKNOWN', message: event.data.reason.error?.message } : kind === 'completed' ? undefined : failureOf(entry)
      if (failure !== undefined) fail(entry, failure, { report: kind !== 'error' })
      else release(entry)
    }
  })

  const path = rt.home === undefined ? undefined : join(rt.home, 'thread-queue.json')
  const pending = new Map()
  const endedDuringRestore = new Set()
  let ready
  const unloaded = () => ctx.fiber?.uid === null

  function persist() {
    if (unloaded() || rt.readOnly?.() !== undefined) return
    try {
      const temp = `${path}.tmp`
      writeFileSync(temp, JSON.stringify({ version: QUEUE_VERSION, items: [...pending.values()] }), { mode: 0o600 })
      renameSync(temp, path)
    } catch (error) {
      rt.warn?.('ds-bot: could not save thread-queue.json (%s)', error.code)
    }
  }

  function removePending(entry) {
    if (pending.delete(entry.queueId)) persist()
  }

  const cancelled = entry => {
    removePending(entry)
    void Promise.resolve().then(() => entry.onCancel?.()).catch(error => rt.warn?.('ds-bot: queued cancellation failed: %s', error))
  }

  Object.assign(rt, {
    sendThreadTurn,
    enqueueThreadTurn,
    threadQueueLive: liveOf,
    threadQueueCancel: dropCancelled,
    dropThreadQueue: forget,
    dropThreadQueueSession: dropSession,
  })
  if (path !== undefined) {
    ready = Promise.resolve().then(restoreQueue)
      .catch(() => rt.warn?.('ds-bot: could not restore thread-queue.json'))
      .finally(() => {
        ready = undefined
        endedDuringRestore.clear()
      })
  }
}

const QUEUE_VERSION = 1
const hasText = value => typeof value === 'string' && value.trim() !== ''

function savedItem({ queueId, botId, threadId, sessionId, preview, text, enqueuedAt }) {
  return { queueId, botId, threadId, sessionId, preview, text, enqueuedAt }
}
