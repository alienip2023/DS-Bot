// thread-queue.js — P1's serial gate: one turn per Bot at a time, the rest FIFO.
//
// Every way a message reaches a Bot's Session goes through `rt.sendThreadTurn`: the web
// send endpoint, the local executor, and team delivery. The gate keeps at most one running
// turn per Bot (`maxParallelThreads = 1`, docs/thread-model.md §4.5) and parks the others
// in an in-memory queue. A queued message is only handed to the Session once the turn in
// front of it ends: the gate arms the Session's `turn/end` listener before it runs the
// message, so a turn that ends before the listener is up cannot strand the queue.
//
// The queue is memory only. A restart drops it: state.json never carries a queue, and a
// Bot with no running entry has both `running` and `queued` at zero in the thread view.
import { randomUUID } from 'node:crypto'
import { mainThreadId, threadOf } from './bot-store.js'

// A turn the Session accepted but never started (no `turn/start`) would hold the Bot
// forever; past this it is let go once, with a warning, and the queue moves on.
const ACCEPT_WAIT_MS = 60_000
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
      slot = { botId, running: null, entry: null, queue: [] }
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
  }

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
    slot.running = null
    slot.entry = null
    const next = slot.queue.shift()
    if (next !== undefined) {
      void start(slot, next).catch(error => rt.warn?.('ds-bot: queued turn for %s failed: %s', slot.botId, error))
    }
  }

  async function start(slot, entry) {
    slot.running = { queueId: entry.queueId, threadId: entry.threadId, sessionId: entry.sessionId, startedAt: Date.now(), kind: entry.kind }
    slot.entry = entry
    entry.startedAt = slot.running.startedAt
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
    }
    try {
      await entry.run()
    } catch (error) {
      release(entry)
      throw error
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
  async function enqueueThreadTurn(spec) {
    const run = spec?.run
    if (typeof run !== 'function') throw new Error('enqueueThreadTurn needs run()')
    const owner = ownerOf(spec)
    if (owner === undefined || typeof owner.sessionId !== 'string' || owner.sessionId === '') {
      await run()
      return { queued: false }
    }
    const entry = {
      queueId: randomUUID(),
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
      enqueuedAt: Date.now(),
      startedAt: undefined,
      sawStart: false,
      watch: undefined,
    }
    const slot = slotOf(owner.botId)
    if (slot.running === null) {
      await start(slot, entry)
      return { queued: false, queueId: entry.queueId }
    }
    slot.queue.push(entry)
    return { queued: true, queueId: entry.queueId, position: slot.queue.length }
  }

  /** `sendThreadTurn` is the name the rest of the host calls; same gate. */
  async function sendThreadTurn(spec) {
    return await enqueueThreadTurn(spec)
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
    slots.delete(botId)
  }

  // A Bot deleted while another message waits must not run it after the deletion.
  const dropCancelled = (botId, queueId) => {
    const slot = slots.get(botId)
    if (slot === undefined) return { cancelled: false, remaining: 0 }
    const at = slot.queue.findIndex(entry => entry.queueId === queueId)
    if (at === -1) return { cancelled: false, remaining: slot.queue.length }
    slot.queue.splice(at, 1)
    return { cancelled: true, remaining: slot.queue.length }
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const entry = runningEntryOf(sessionId)
    if (entry === undefined) return
    if (event?.type === 'turn/start') {
      entry.sawStart = true
      clearWatch(entry)
      return
    }
    if (event?.type === 'turn/end') release(entry)
  })

  Object.assign(rt, {
    sendThreadTurn,
    enqueueThreadTurn,
    threadQueueLive: liveOf,
    threadQueueCancel: dropCancelled,
    dropThreadQueue: forget,
  })
}
