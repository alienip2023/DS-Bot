// The mirror Session of a joined Bot has two writers: the page's own turn
// (executor.startPageTurn, one at a time through rt.joinedInFlight) and Bot-to-Bot
// deliveries (joined-turn). A Session cannot hold two open turns — allocateTurn would
// close the other writer's turn as interrupted and the log stops restoring strictly.
//
// So a Bot-to-Bot exchange writes its turn only when no page turn is open: if one is
// open, the exchange waits in this in-memory queue and is written start-then-result in
// one tick when the page turn ends. Delivery and the reply to the sender are not
// delayed — only the page write is buffered. The queue never enters state.json.
import { allocateTurn, mirrorTurnStart, mirrorTurnFinish, mirrorTurnFail } from './mirror.js'

const writersOf = rt => {
  if (!rt._joinedMirrorWriters) rt._joinedMirrorWriters = new Map()
  return rt._joinedMirrorWriters
}

function writerOf(rt, botId) {
  const writers = writersOf(rt)
  let writer = writers.get(botId)
  if (!writer) {
    writer = { open: null, queue: [], waiters: [] }
    writers.set(botId, writer)
  }
  return writer
}

/** Is a Bot-to-Bot mirror turn open (the page must not start until it closes)? */
export function mirrorTurnOpen(rt, botId) {
  return writerOf(rt, botId).open !== null
}

function pageBusy(rt, botId) {
  return rt.joinedInFlight?.has(botId) === true
}

/**
 * Resolve when no Bot-to-Bot turn is open, so the page may take its own turn.
 * Times out with E_BUSY rather than writing into an open turn.
 */
export function waitForJoinedMirror(rt, botId, timeoutMs = 600_000) {
  const writer = writerOf(rt, botId)
  if (writer.open === null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: undefined }
    waiter.timer = setTimeout(() => {
      const at = writer.waiters.indexOf(waiter)
      if (at >= 0) writer.waiters.splice(at, 1)
      const error = new Error('the Bot-to-Bot turn on this page did not finish')
      error.code = 'E_BUSY'
      reject(error)
    }, timeoutMs)
    waiter.timer.unref?.()
    writer.waiters.push(waiter)
  })
}

function wakeOne(writer) {
  const waiter = writer.waiters.shift()
  if (!waiter) return
  clearTimeout(waiter.timer)
  waiter.resolve()
}

/**
 * Open the mirror turn for a Bot-to-Bot exchange.
 * Returns {queued:true, item} when a page turn is open (or another exchange owns the
 * Session); the caller records the outcome on `item` through closeJoinedMirror.
 * Returns {turn, session, state, botId} when the turn is open now.
 */
export function beginJoinedMirror(rt, bot, session, { text, rpcId, state }) {
  const writer = writerOf(rt, bot.id)
  const queued = pageBusy(rt, bot.id) || writer.open !== null
  if (queued) {
    const item = { botId: bot.id, session, text, rpcId, state, outcome: null }
    writer.queue.push(item)
    return { queued: true, item }
  }
  const turn = allocateTurn(session)
  mirrorTurnStart(session, { turn, step: 1, userText: text ?? '', rpcId })
  writer.open = turn
  return { botId: bot.id, turn, session, state }
}

/**
 * Close a Bot-to-Bot mirror turn. `error` is {code, message} for a failed/timeout turn.
 * A queued exchange stores the outcome and is written later, in arrival order, by drain.
 */
export function closeJoinedMirror(rt, mirror, { text, seq, error } = {}) {
  if (!mirror) return
  if (mirror.queued) {
    mirror.item.outcome = { text, seq, error: error ?? null }
    drainJoinedMirror(rt, mirror.item.botId)
    return
  }
  const writer = writerOf(rt, mirror.botId)
  try {
    if (error) {
      mirrorTurnFail(mirror.session, {
        turn: mirror.turn,
        step: 1,
        code: error.code,
        message: error.message,
        closedTurns: mirror.state?.closedTurns,
      })
    } else {
      mirrorTurnFinish(mirror.session, {
        turn: mirror.turn,
        step: 1,
        botText: text ?? '',
        botId: mirror.botId,
        nodeSeq: seq,
        ...(mirror.state ?? {}),
      })
    }
  } catch (err) {
    rt.warn?.('ds-bot: a Bot-to-Bot mirror turn for %s could not be closed: %s', mirror.botId, err?.message ?? err)
  }
  writer.open = null
  drainJoinedMirror(rt, mirror.botId)
  wakeOne(writer)
}

function writeQueued(rt, item) {
  const turn = allocateTurn(item.session)
  mirrorTurnStart(item.session, { turn, step: 1, userText: item.text ?? '', rpcId: item.rpcId })
  const outcome = item.outcome ?? {}
  if (outcome.error) {
    mirrorTurnFail(item.session, {
      turn,
      step: 1,
      code: outcome.error.code,
      message: outcome.error.message,
      closedTurns: item.state?.closedTurns,
    })
    return
  }
  mirrorTurnFinish(item.session, {
    turn,
    step: 1,
    botText: outcome.text ?? '',
    botId: item.botId,
    nodeSeq: outcome.seq,
    ...(item.state ?? {}),
  })
}

/**
 * Write every queued exchange whose outcome is known, in arrival order, one whole turn
 * at a time. Does nothing while a page turn is open: the page turn ends first.
 */
export function drainJoinedMirror(rt, botId) {
  const writer = writerOf(rt, botId)
  if (pageBusy(rt, botId)) return
  while (writer.open === null && writer.queue.length > 0) {
    const item = writer.queue[0]
    if (!item.outcome) return
    writer.queue.shift()
    try {
      writeQueued(rt, item)
    } catch (err) {
      rt.warn?.('ds-bot: a queued Bot-to-Bot mirror turn for %s was not written: %s', botId, err?.message ?? err)
    }
  }
  if (writer.queue.length === 0 && writer.open === null) wakeOne(writer)
}

/** Drop buffered writes that will never be written (the plugin is unloading). Warn, never half-write. */
export function dropJoinedMirrorQueues(rt) {
  const writers = rt._joinedMirrorWriters
  if (!writers) return
  for (const [botId, writer] of writers) {
    if (writer.queue.length > 0) {
      rt.warn?.('ds-bot: %d buffered Bot-to-Bot page write(s) for %s were dropped at unload', writer.queue.length, botId)
    }
    for (const waiter of writer.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      const error = new Error('the joined mirror writer was unloaded')
      error.code = 'E_BUSY'
      waiter.reject(error)
    }
  }
  writers.clear()
}
