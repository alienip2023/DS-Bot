// Resume: Bot work that DeepSeek Harness dropped when it closed or restarted. DSH closes
// a turn it never finished as interrupted when the Session next opens, and a clean
// shutdown also cancels the messages still waiting in a Session's inbox; nothing would
// ever run either again, and whoever waited for them was not told. DS Bot notes each
// running Bot turn and each message it delivers until a turn takes it up, in
// inflight.json; queued deliveries are recovered, but a turn can replay only if
// it was rejected before the engine accepted it.
//
// A turn that ends while DS Bot is not watching it (the plugin reloaded, DSH went on)
// is settled from the Session's durable log: an answer that was produced goes to the Bot
// that waits for it, and an outcome that cannot be read is said to be unknown. The
// request itself is never sent again there.
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, isWorkTool, MESSAGE_INLINE_MAX, SOURCE_KIND, STEER_CUT } from './constants.js'
import { eventMatchesReceipt, receiptKeyOf } from './coordination.js'
import { replaceFile } from './files.js'
import { stripOwnName } from './groups.js'
import { answerSender, cutOffText, failureLine, turnFailure } from './turns.js'
import { textOf } from './text.js'
import { addressedSession, isActiveTask, returnAddress, sessionRoomId, threadCurrentOfPart, threadOfPart } from './threads.js'
import { joinedShadow } from './roster-join.js'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000
export const QUEUED_TTL_MS = 30 * 60 * 1000

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
].filter(Boolean).join(' ')

// The turns of a Session's durable log, each with the exchanges it took up, what it
// said and how it ended.
export function turnsOf(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, took: [], messages: {}, messageSeqs: {}, texts: [], toolCount: 0, reason: undefined, end: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'step/start') {
      current.stepFrom = current.texts.length
      continue
    }
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      if (isWorkTool(String(event.data?.name ?? ''))) current.toolCount += 1
      const callId = event.data?.subCallId ?? event.data?.callId
      if (callId) (current.unconfirmedCalls ??= new Set()).add(callId)
      continue
    }
    if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const callId = event.data?.subCallId ?? event.data?.callId ?? event.data?.message?.toolCallId
      if (callId) current.unconfirmedCalls?.delete(callId)
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) {
        current.took.push(source)
        // What the message held, for handing it back when its turn completed and no
        // deferred delivery made it: text, and the attachments it carried.
        current.messages[source.exchangeId] = { content: event.data?.content }
        if (event.seq !== undefined) current.messageSeqs[source.exchangeId] = event.seq
      }
      // A turn resumed across a part switch carries steered requests in source.joined
      // ({ info, text }[]) instead of separate user/message events.
      if (Array.isArray(source?.joined)) {
        for (const item of source.joined) {
          const info = item?.info
          if (info?.exchangeId === undefined) continue
          current.took.push(info)
          if (current.messages[info.exchangeId] === undefined) {
            current.messages[info.exchangeId] = { text: typeof item.text === 'string' ? item.text : '' }
          }
          if (event.seq !== undefined && current.messageSeqs[info.exchangeId] === undefined) {
            current.messageSeqs[info.exchangeId] = event.seq
          }
        }
      }
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
      continue
    }
    if (event.type === 'turn/end') {
      current.reason = event.data?.reason
      current.end = event.seq
    }
  }
  return turns
}

const isSteerCutTurn = turn => turn?.reason?.kind === 'aborted'
  && turn.reason.reason?.kind === 'hook'
  && turn.reason.reason?.reason === STEER_CUT

function chainSteerCuts(turns, startAt) {
  let found = turns[startAt]
  let next = startAt + 1
  // A steer cut lands inside a step's model call, so the cut turn's last step left
  // an interrupted draft: texts before the last step/start stay, the rest is a
  // fragment the continuation replaces.
  const finished = turn => turn.texts.slice(0, turn.stepFrom ?? turn.texts.length)
  while (isSteerCutTurn(found) && next < turns.length) {
    const follow = turns[next]
    const kept = finished(found)
    found = {
      ...follow,
      took: [...found.took, ...follow.took],
      messages: { ...found.messages, ...follow.messages },
      messageSeqs: { ...found.messageSeqs, ...follow.messageSeqs },
      texts: [...kept, ...follow.texts],
      toolCount: (found.toolCount ?? 0) + (follow.toolCount ?? 0),
      stepFrom: kept.length + (follow.stepFrom ?? follow.texts.length),
    }
    next += 1
  }
  return isSteerCutTurn(found) ? { ...found, texts: finished(found), reason: undefined } : found
}

// The last turn that took up an exchange: what it said and how it ended. A turn cut
// by a user steer keeps going in the turn that starts right after it, so the reason
// that counts is the continuation's.
export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (!turns[at].took.some(source => source.exchangeId === exchangeId)) continue
    return chainSteerCuts(turns, at)
  }
  return undefined
}

function findRecordedTurn(events, record) {
  if (!Array.isArray(events) || events.length === 0) return undefined
  if (record?.trigger?.exchangeId !== undefined) {
    const byExchange = turnOf(events, record.trigger.exchangeId)
    if (byExchange !== undefined) return byExchange
  }
  const turns = turnsOf(events)
  if (typeof record?.turn === 'number') {
    for (let at = turns.length - 1; at >= 0; at -= 1) {
      if (turns[at].turn === record.turn) return chainSteerCuts(turns, at)
    }
    return undefined
  }
  return turns.length > 0 ? chainSteerCuts(turns, turns.length - 1) : undefined
}

// Whether a Session already holds the answer to an exchange.
export function answeredIn(events, exchangeId) {
  return events.some(event => event.type === 'user/message' && event.data?.source?.replyTo === exchangeId)
}

// The trigger fields a resumed turn needs to answer the same sender.
const triggerOf = info => ({
  role: info.role,
  ...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
  ...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
  ...(info.senderPart ? { senderPart: info.senderPart } : {}),
  ...(info.roomId ? { roomId: info.roomId } : {}),
  ...(info.work ? { work: info.work } : {}),
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.batchKey ? { batchKey: info.batchKey } : {}),
  ...(info.resumedUpstream ? { resumedUpstream: true } : {}),
  ...(info.resultRef ? { resultRef: info.resultRef } : {}),
  ...(info.replyTo ? { replyTo: info.replyTo } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

// Written into inflight.json so a later format can tell itself apart. A file without it is
// the legacy format and loads as is; `turns` and `queued` keep their names and shapes, so
// an older reader still reads a newer file.
export const NOTES_VERSION = 1

const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})

// A missing file is a first start. A file that cannot be read as notes is kept under
// another name (its bytes untouched), reported once, and read as empty: nothing is guessed
// from it and nothing is delivered from it.
const readNotes = (file, rt) => {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') rt?.warn?.('ds-bot: reading the noted running turns failed: %s', error)
    return { turns: {}, queued: {}, silent: {} }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('inflight.json is not an object')
    return { turns: object(parsed.turns), queued: object(parsed.queued), silent: object(parsed.silent) }
  } catch (error) {
    let kept = 'left in place'
    // A read-only host writes nothing, a rename included.
    if (rt?.readOnly?.() === undefined) {
      const target = `${file}.corrupt-${Date.now()}`
      try {
        renameSync(file, target)
        kept = target
      } catch { /* the file stays where it is */ }
    }
    rt?.noteFailure?.({
      level: 'warn',
      source: 'resume',
      text: `the noted running turns could not be read (${error?.message ?? error}); nothing from them will be picked up (${kept})`,
    })
    return { turns: {}, queued: {}, silent: {} }
  }
}

export function classifyResume(record) {
  if (record.producedOutput || record.promptSubmitted) return 'after-accept'
  // A pre-accept rejection needs explicit negatives for both flags.
  if (record.attempted === true && record.rejected === true
    && record.producedOutput === false && record.promptSubmitted === false) return 'before-accept'
  return 'unknown'
}

export const mayReplay = cls => cls === 'before-accept'

export async function resumeTurn(rt, sessionId, record) {
  const alreadyResumed = record.resumed
  const cls = alreadyResumed ? 'unknown' : classifyResume(record)
  if (!alreadyResumed && !mayReplay(cls)) return cls
  const bot = rt.botOf(record.botId)
  if (bot === undefined) return cls
  const room = record.roomId === undefined ? undefined : rt.roomOf(record.roomId)
  if (record.roomId !== undefined && (room === undefined || !room.members.includes(bot.id))) return cls
  // Resolve by logical address: a closed or retired background task never falls back to the Bot's
  // private foreground chat.
  const address = room === undefined ? returnAddress(bot, sessionId) : undefined
  const dest = address === undefined ? undefined : addressedSession(rt, bot.id, address)
  if (room === undefined && dest === undefined) return cls
  // Claim before any await so concurrent recovery cannot replay the same turn.
  record.resumed = true
  if (room !== undefined) await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, ...(alreadyResumed ? { again: true } : {}) })
  if (alreadyResumed) {
    // A turn already picked up once and cut off again stays stopped: a restart loop must not run it forever.
    // Reset any goal/group task state so it does not stay stuck.
    if (room !== undefined) {
      rt.goalTaskReset?.(room.id, bot.id, 'Interrupted by restart twice')
      rt.blockTasks?.(room.id, bot.id, { cause: 'restarted' })
    }
    return cls
  }
  const text = resumeText(record)
  if (room !== undefined) {
    await rt.deliver({
      toId: bot.id,
      sessionId: room.sessions?.[bot.id] ?? sessionId,
      role: 'room',
      roomId: room.id,
      note: 'picking up after a restart',
      resumed: true,
      text,
      ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}),
      ...(record.trigger?.batchKey ? { batchKey: record.trigger.batchKey } : {}),
      ...(record.trigger?.resumedUpstream ? { resumedUpstream: true } : {}),
      ...(record.trigger?.resultRef ? { resultRef: record.trigger.resultRef } : {}),
    })
    return cls
  }
  // The turn ran in a part that is still one of the Bot's: it goes on there, not in the
  // foreground chat when that part is a background one.
  const ownPart = { sessionId: dest, address }
  const trigger = record.trigger
  if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
    // The sender still waits for this turn's answer, so it goes on under the same exchange.
    await rt.deliver({ fromId: trigger.senderSessionId, toId: bot.id, ...ownPart, ...(trigger.senderPart ? { fromPart: trigger.senderPart } : {}), role: trigger.role, ...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}), ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}), resumed: true, text })
    return cls
  }
  // A turn that went on with work another Bot asked for still owes that Bot its answer.
  await rt.deliver({ toId: bot.id, ...ownPart, role: trigger?.role === 'reply' && !trigger.work ? 'reply' : 'resume', resumed: true, text, ...(trigger?.replyTo ? { replyTo: trigger.replyTo } : {}), ...(trigger?.work ? { work: trigger.work } : {}) })
  return cls
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')
  const coord = rt.coordination

  // What the last run left; loaded from coordination.sqlite (importing legacy inflight.json if needed). Without
  // a coordination store, inflight.json is read as it is.
  let interrupted = coord?.loadInitialState?.() ?? { ...readNotes(file, rt), obligations: [] }
  // The turns the last run left, until they are picked up: a task whose Session is still to be recovered is not
  // settled as orphaned meanwhile.
  let recoveringTurns = interrupted.turns

  /** @type {Record<string, {botId:string, roomId?:string, turn?:number, since:number, trigger?:any, approval?:{tool:string, reason:string}, resumed?:boolean, unverified?:boolean, attempted?:boolean, rejected?:boolean, promptSubmitted?:boolean, producedOutput?:boolean}>} */
  let turns = {}
  // A new delivery can persist before recovery runs; it must keep the old queue.
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = interrupted.queued
  /** @type {Record<string, {message:any, ledger?:any}[]>} buffered silent notices awaiting idle flush */
  let silent = interrupted.silent
  let writing = Promise.resolve()
  let activeWrite = null
  let stopped = false
  let latest
  let due = false
  rt.flushInflight = () => activeWrite
  const persist = () => {
    // Only the host that saves the team runs its work again.
    if (stopped || rt.readOnly() !== undefined) return
    const gen = coord?.currentGen?.() ?? 0
    const mergedTurns = { ...recoveringTurns, ...turns }
    latest = JSON.stringify({
      version: NOTES_VERSION,
      ...(gen > 0 ? { _coordGen: gen } : {}),
      turns: mergedTurns,
      queued,
      ...(Object.keys(silent).length > 0 ? { silent } : {}),
    })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return
    due = true
    // Written to a temp file and put over the target (replaceFile retries where Windows refuses while something
    // reads the file), so the target holds either the old bytes or the complete new ones: a torn write would lose
    // the notes.
    const nextWrite = writing.then(async () => {
      due = false
      const snapshot = latest
      const temp = `${file}.${process.pid}.tmp`
      await mkdir(home, { recursive: true })
      try {
        await writeFile(temp, snapshot, 'utf8')
        await replaceFile(temp, file)
        coord?.noteMirrorWritten?.(snapshot)
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    }).catch(error => rt.warn('ds-bot: noting running turns failed: %s', error))
    writing = nextWrite
    activeWrite = nextWrite
    nextWrite.finally(() => {
      if (activeWrite === nextWrite) activeWrite = null
    })
  }
  const noteSilent = (sessionId, entries) => {
    if (stopped || rt.readOnly() !== undefined) return
    if (typeof sessionId !== 'string' || sessionId === '') return
    const next = { ...silent }
    if (!Array.isArray(entries) || entries.length === 0) {
      if (!(sessionId in next)) return
      delete next[sessionId]
    } else {
      next[sessionId] = entries.map(entry => ({ message: entry.message, ...(entry.ledger ? { ledger: entry.ledger } : {}) }))
    }
    silent = next
    coord?.replaceSessionSilent?.(sessionId, next[sessionId])
    persist()
  }
  rt.noteSilent = noteSilent
  const update = (id, change) => {
    if (stopped || rt.readOnly() !== undefined) return
    const next = change(turns[id])
    if (next === turns[id]) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    coord?.upsertTurn?.(id, next)
    persist()
  }
  const noteFailure = rt.noteFailure
  rt.noteFailure = function (failure) {
    if (failure?.source === 'prompt' && failure.sessionId !== undefined) {
      update(failure.sessionId, record => {
        if (record === undefined || record.promptSubmitted || record.producedOutput) return record
        return { ...record, attempted: true, rejected: true, promptSubmitted: false, producedOutput: false }
      })
    }
    return noteFailure?.call(this, failure)
  }

  const forgetQueued = (exchangeId) => {
    if (!stopped && rt.readOnly() === undefined) coord?.removeDelivery?.(exchangeId)
    for (const [sessionId, list] of Object.entries(queued)) {
      const at = list.findIndex(item => item.args.exchangeId === exchangeId)
      if (at === -1) continue
      const rest = list.toSpliced(at, 1)
      queued = { ...queued }
      if (rest.length === 0) delete queued[sessionId]
      else queued[sessionId] = rest
      persist()
      return
    }
  }
  const forgetTaskStartDeliveries = (taskId) => {
    if (typeof taskId !== 'string' || taskId === '') return
    if (!stopped && rt.readOnly() === undefined) coord?.removeTaskStartDeliveries?.(taskId)
    let changed = false
    const next = { ...queued }
    for (const [sessionId, list] of Object.entries(next)) {
      const kept = list.filter(item => !(item.args?.taskId === taskId && item.args?.role === 'task'))
      if (kept.length === list.length) continue
      changed = true
      if (kept.length === 0) delete next[sessionId]
      else next[sessionId] = kept
    }
    if (changed) {
      queued = next
      persist()
    }
  }
  // Everything still noted for a work: the work is gone (stopped or dropped), so none of it is sent again.
  const forgetWorkDeliveries = (workId) => {
    if (typeof workId !== 'string' || workId === '') return
    if (!stopped && rt.readOnly() === undefined) coord?.removeWorkDeliveries?.(workId)
    let changed = false
    const next = { ...queued }
    for (const [sessionId, list] of Object.entries(next)) {
      const kept = list.filter(item => item.args?.exchangeId !== workId && item.args?.work !== workId)
      if (kept.length === list.length) continue
      changed = true
      if (kept.length === 0) delete next[sessionId]
      else next[sessionId] = kept
    }
    if (changed) {
      queued = next
      persist()
    }
  }

  const inferAddress = (args) => {
    if (args.address && typeof args.address === 'object') return args.address
    if ((args.role === 'task' || args.role === 'task-followup') && typeof args.taskId === 'string' && args.taskId !== '') {
      return { taskId: args.taskId }
    }
    if (args.role === 'room' && args.deferred !== true && typeof args.roomId === 'string' && args.roomId !== '' && rt.roomOf(args.roomId) !== undefined) {
      return { roomId: args.roomId }
    }
    return undefined
  }

  const deliver = rt.deliver
  // Deliveries on their way right now, by Session and exchangeId. A deferred delivery is
  // one request handed back for a turn of its own; the normal path and a restart
  // recovery can both reach it, and the later caller waits for the one already going.
  // A failed delivery leaves the note (the next start sends it again) but not this
  // entry, so a retry in this run really sends it.
  const sending = new Map()
  rt.deliver = async (args) => {
    const address = inferAddress(args)
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID(), transferId: args.transferId ?? randomUUID(), ...(address !== undefined ? { address } : {}) }
    // Non-waking silent notices do not open turns, so they never enter inflight `queued`
    // (that would inflate unread counts and resend them as work).
    if (noted.wake === false) return deliver(noted)
    let sessionId = address !== undefined
      ? addressedSession(rt, noted.toId, address)
      : (noted.sessionId ?? rt.chatOf(noted.toId))
    if (address !== undefined && sessionId === undefined && canFallbackReturnToForeground(noted.role)) {
      const fg = rt.chatOf(noted.toId)
      if (fg !== undefined) {
        if (address.roomId !== undefined) noted.imOrigin = undefined
        noted.address = { foreground: true }
        sessionId = fg
      }
    }
    if (address !== undefined && sessionId === undefined) {
      rt.noteFailure?.({
        level: 'warn',
        source: 'delivery',
        code: 'RETURN_UNRESOLVED',
        text: 'The delivery was not sent: its target task or group is no longer active.',
        bot: rt.botOf(noted.toId)?.name,
      })
      throw Object.assign(new Error('The delivery has no active recipient'), { code: 'bot/unresolved-return', delivered: false })
    }
    if (address !== undefined) noted.sessionId = sessionId
    const repeat = noted.deferred === true && noted.resent !== true
    const key = `${sessionId}\u0000${noted.exchangeId}`
    if (repeat) {
      const running = sending.get(key)
      if (running !== undefined) return running
    }
    // Committed synchronously to coordination.sqlite before it goes out so a turn
    // taking it up or a crash mid-send never loses track of the obligation.
    const at = Date.now()
    const waiting = queued[sessionId] ?? []
    const idx = waiting.findIndex(item => item.args?.exchangeId === noted.exchangeId)
    const note = { at, args: noted }
    queued = { ...queued, [sessionId]: idx === -1 ? [...waiting, note] : waiting.with(idx, note) }
    coord?.upsertDelivery?.(sessionId, noted, at)
    persist()
    const run = (async () => {
      try {
        const result = await deliver(noted)
        // A turn dispatched to a node leaves this host's Sessions: no local event will ever
        // take it up. Once the node has it (a failed dispatch answers `{ ok: false }` and stays
        // noted, so the next start sends it again), it is done with here.
        const remote = rt.botOf(noted.toId)
        if (remote !== undefined && (joinedShadow(remote) || (remote.type === 'remote-worker' && remote.origin !== 'joined'))
          && !(result !== null && typeof result === 'object' && result.ok === false)) forgetQueued(noted.exchangeId)
        return result
      } catch (error) {
        // Drop deliveries whose Bot is gone or whose target task/group closed permanently.
        if (rt.botOf(noted.toId) === undefined || error?.code === 'bot/unresolved-return') {
          forgetQueued(noted.exchangeId)
        }
        throw error
      }
    })()
    if (repeat) {
      sending.set(key, run)
      const done = () => { if (sending.get(key) === run) sending.delete(key) }
      run.then(done, done)
    }
    return run
  }

  // What a Session was sent and no turn has read yet.
  rt.unreadOf = sessionId => (queued[sessionId] ?? []).map(item => item.args)
  rt.forgetDelivery = forgetQueued
  rt.forgetTaskStartDeliveries = forgetTaskStartDeliveries
  rt.restoreDelivery = (sessionId, args) => {
    if (sessionId === undefined || args?.exchangeId === undefined) return
    const at = Date.now()
    const waiting = queued[sessionId] ?? []
    const idx = waiting.findIndex(item => item.args?.exchangeId === args.exchangeId)
    const note = { at, args }
    queued = { ...queued, [sessionId]: idx === -1 ? [...waiting, note] : waiting.with(idx, note) }
    coord?.upsertDelivery?.(sessionId, args, at)
    persist()
  }
  rt.forgetWorkDeliveries = forgetWorkDeliveries
  rt.hasPendingRecovery = sessionId => Object.hasOwn(recoveringTurns, sessionId) || Object.hasOwn(turns, sessionId)
    || (queued[sessionId]?.length ?? 0) > 0
  rt.hasPendingTaskReport = taskId => Object.values(queued).some(list => Array.isArray(list)
    && list.some(item => item?.args?.role === 'task-report' && item.args.taskId === taskId))
    || (!rt.isTaskSettling?.(taskId) && coord?.hasPendingObligation?.(`task-report:${taskId}`) === true)

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while DS Bot runs: the user stopped the Bot, or DS Bot moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ agent, message } = {}) => {
    if (rt.isMovingInboxMessage?.(message?.id) === true) return
    const source = message?.source
    if (source?.kind === SOURCE_KIND && source.exchangeId) forgetQueued(source.exchangeId)
    if (source?.kind === SOURCE_KIND && (source.role === 'post' || source.role === 'goal') && typeof source.roomId === 'string') {
      rt.roomRelayDiscarded?.(source, agent?.id ?? agent?.session?.id)
    }
  })
  // Exchanges a turn took up since this start, until the resends are done, so a resend
  // never repeats one.
  let taken = (Object.keys(interrupted.queued).length > 0 || coord?.hadInitialReadFailure?.() === true) ? new Set() : undefined
  // The first turn event of each Session since this start, until the noted turns are
  // picked up. A turn that ends, or still runs, before one starts here outlived the
  // last run: only DS Bot restarted (the plugin reloaded) and DSH went on.
  let firstTurn = (Object.keys(interrupted.turns).length > 0 || coord?.hadInitialReadFailure?.() === true) ? new Map() : undefined
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if ((event.type === 'turn/start' || event.type === 'turn/end') && firstTurn?.has(id) === false) {
      firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason })
    }
    // A message is done with once the Bot's own turn machinery takes it up: the relay message
    // itself, or the empty wake that follows a message the user is shown (delivery.js writes
    // that one with `kind: 'user'` first, so it must not clear the note: a restart before the
    // wake is taken still owes the Bot its turn).
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
      rt.workNoteTaken?.(session, event.data.source)
      taken?.add(event.data.source.exchangeId)
      forgetQueued(event.data.source.exchangeId)
    }
    if (event.type === 'turn/end') {
      // Only a turn cut by DSH shutdown is kept to pick up at the next start; a stopped task has already left the
      // active index, so this runs for every Session.
      const reason = event.data?.reason
      if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') return
      update(id, () => undefined)
      // The turn is over: its saved approval resume position goes with it (coalesced
      // save; the position only matters while the turn is unfinished).
      if (rt.readOnly() === undefined && rt.state?.resumeCursor !== null && typeof rt.state?.resumeCursor === 'object' && Object.hasOwn(rt.state.resumeCursor, id)) {
        rt.state.resumeCursor = { ...rt.state.resumeCursor }
        delete rt.state.resumeCursor[id]
        void rt.save?.({ immediate: false })?.catch?.(() => {})
      }
      return
    }
    if (!rt.isBotSession(id)) return
    switch (event.type) {
      case 'turn/start': {
        const owner = rt.groupOwners.get(id)
        const botId = owner?.botId ?? rt.chatOwners.get(id)
        // turns.js runs first and has already claimed or restored the trigger.
        const info = rt.live.get(id)?.info
        update(id, () => ({
          botId,
          ...(owner ? { roomId: owner.roomId } : {}),
          ...(typeof event.data?.turn === 'number' ? { turn: event.data.turn } : {}),
          since: event.time ?? Date.now(),
          ...(info !== undefined ? { trigger: triggerOf(info) } : {}),
        }))
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== SOURCE_KIND || event.data?.source?.silent === true) break
        // turns.js, installed earlier, has already claimed the turn's trigger.
        const info = rt.live.get(id)?.info
        update(id, record => (record === undefined || record.trigger !== undefined || info === undefined ? record
          : { ...record, trigger: triggerOf(info), ...(info.resumed ? { resumed: true } : {}) }))
        break
      }
      case 'tool/call':
        update(id, record => (record === undefined || record.promptSubmitted ? record : { ...record, promptSubmitted: true }))
        break
      case 'assistant/message':
        if (textOf(event.data?.message?.content) !== '') {
          update(id, record => (record === undefined || record.producedOutput ? record : { ...record, producedOutput: true }))
        }
        break
    }
  })

  // When the Session's unfinished turn started, for the approval resume position.
  rt.turnSince = sessionId => turns[sessionId]?.since
  // An approval the restart drops is named when the turn is picked up.
  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (({ approval: _, ...rest }) => rest)(record) : { ...record, approval }))

  // Whether this call took the turn up: `resumeTurn` (module level, shared with tests) answers
  // with its replay class; background-task reconciliation needs only 'was it picked up'.
  async function resumeTurnKept(sessionId, record) {
    const before = record.resumed === true
    const cls = await resumeTurn(rt, sessionId, record)
    return !before && record.resumed === true && cls === 'before-accept'
  }

  // Resolve the current DSH Session and effective logical address for a queued delivery or
  // obligation. A closed background task or removed group NEVER receives a redirected
  // task-start, task-followup, or room call. Completed peer replies and group reports whose
  // originating task/group closed fall back to `{ foreground: true }` so completed answers
  // are never stranded by delivery admission.
  const canFallbackReturnToForeground = role => role === 'reply' || role === 'report'
  const resolveReplayTarget = (sessionId, args) => {
    const bot = rt.botOf(args.toId)
    if (bot === undefined) return undefined
    let addr
    if (args.address && typeof args.address === 'object') {
      addr = args.address
    } else if (args.taskId && (args.role === 'task' || args.role === 'task-followup')) {
      addr = { taskId: args.taskId }
    } else if (args.role === 'report') {
      // Legacy group reports carry the SOURCE group in `args.roomId`; infer the recipient
      // conversation solely from the saved session id (current or past group part, task, or DM).
      const destRoomId = sessionRoomId(rt.state, args.toId, sessionId)
      addr = returnAddress(bot, sessionId, destRoomId)
    } else {
      const destRoomId = sessionRoomId(rt.state, args.toId, sessionId) ?? (args.role === 'room' ? args.roomId : undefined)
      addr = returnAddress(bot, sessionId, destRoomId)
    }
    const resolved = addressedSession(rt, args.toId, addr)
    if (resolved !== undefined) return { sessionId: resolved, address: addr }
    if (canFallbackReturnToForeground(args.role)) {
      const fg = rt.chatOf(args.toId)
      if (fg !== undefined) return { sessionId: fg, address: { foreground: true }, fellBackFromRoom: Boolean(addr.roomId) }
    }
    return undefined
  }

  // A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
  // cancelled is sent again. Before replaying any queued delivery, verify both the live
  // inbox and durable DSH session history so already-consumed messages are never sent twice,
  // and fail closed when cold history cannot be read.
  async function resendQueued(sessionId, list) {
    const active = new Set()
    const fresh = []
    for (const item of list) {
      const args = item?.args
      if (args === undefined || rt.botOf(args.toId) === undefined || taken?.has(args.exchangeId) === true) {
        if (args?.exchangeId !== undefined) forgetQueued(args.exchangeId)
        continue
      }
      const target = resolveReplayTarget(sessionId, args)
      if (target === undefined) {
        forgetQueued(args.exchangeId)
        rt.noteFailure?.({
          level: 'warn',
          source: 'delivery',
          code: 'RECIPIENT_CLOSED',
          text: 'The delivery was not redirected: its original task or group has closed.',
          sessionId,
        })
        continue
      }
      fresh.push(item)
    }
    if (fresh.length === 0) return active
    const agents = new Map()
    const evidenceCache = new Map()
    const readEvidence = async (sid) => {
      if (!evidenceCache.has(sid)) {
        const res = await rt.readSessionEvidence(sid, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
        evidenceCache.set(sid, res)
      }
      return evidenceCache.get(sid)
    }
    for (const { args } of fresh) {
      const target = resolveReplayTarget(sessionId, args)
      if (target === undefined) {
        forgetQueued(args.exchangeId)
        continue
      }
      const dest = target.sessionId
      if (!agents.has(dest)) agents.set(dest, await rt.resolveAgent(dest))
      const agent = agents.get(dest)
      const inInbox = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].some(m =>
        m?.source?.exchangeId === args.exchangeId
        && (m.source.role === undefined || receiptKeyOf(m.source) === receiptKeyOf(args)),
      )
      if (inInbox) {
        active.add(dest)
        continue
      }
      // A non-waking notice is never sent again as work.
      if (taken?.has(args.exchangeId) === true || args.wake === false || ['note', 'cancelled'].includes(args.role)) {
        forgetQueued(args.exchangeId)
        continue
      }
      const destEvidence = await readEvidence(dest)
      const origEvidence = dest === sessionId ? destEvidence : await readEvidence(sessionId)
      const alreadyConsumed = (destEvidence.status === 'ok' && destEvidence.events.some(ev => eventMatchesReceipt(ev, args)))
        || (origEvidence.status === 'ok' && origEvidence.events.some(ev => eventMatchesReceipt(ev, args)))
      if (alreadyConsumed) {
        forgetQueued(args.exchangeId)
        continue
      }
      if (destEvidence.status === 'error' || origEvidence.status === 'error') {
        active.add(dest)
        rt.noteFailure?.({
          level: 'warn',
          source: 'delivery',
          code: 'CONSUMPTION_UNVERIFIED',
          text: 'Could not verify whether the recipient read this message. The delivery is held, not repeated.',
          sessionId: dest,
        })
        continue
      }
      // A request that waited through a restart reaches its target late: the work
      // it is for is marked, so the answer that comes back says so.
      if (args.role === 'request' || args.role === 'stopped') rt.lateWork?.(args.exchangeId)
      const effectiveArgs = {
        ...args,
        sessionId: dest,
        address: target.address,
        ...(target.fellBackFromRoom ? { imOrigin: undefined } : {}),
        steer: false,
        resent: true,
      }
      const ok = await deliver(effectiveArgs)
        .then(() => true, (error) => { rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error); return false })
      if (ok) {
        active.add(dest)
      }
    }
    return active
  }

  // Applies committed SQLite terminal markers (`task`, `room_report`) to `state.json`
  // before obligation replay and orphan-task / room-report sweeps run. Closes the crash
  // window between committing SQLite WAL and persisting `state.json` so completed tasks
  // are never re-marked `interrupted` and settled group report watchers never fire twice.
  async function reconcileTerminalMarkers() {
    if (stopped || rt.readOnly?.() !== undefined || !coord) return
    coord.syncLegacyInflight?.()
    const markers = coord.listTerminalMarkers?.() ?? []
    if (markers.length === 0) return
    const applied = []
    const alreadySynced = []
    let dirty = false
    for (const marker of markers) {
      if (stopped || rt.readOnly?.() !== undefined) return
      const snap = marker.snapshot ?? {}
      if (marker.kind === 'task') {
        const bot = rt.botOf(snap.botId)
        const task = bot?.tasks?.find(item => item?.id === marker.ownerId)
        let changed = false
        if (task !== undefined && isActiveTask(task)) {
          task.status = snap.status ?? 'completed'
          if (typeof snap.updatedAt === 'number') task.updatedAt = snap.updatedAt
          if (typeof snap.endedAt === 'number') task.endedAt = snap.endedAt
          if (snap.error !== undefined) task.error = snap.error
          if (snap.summary !== undefined) task.summary = snap.summary
          if (snap.reportFile !== undefined) task.reportFile = snap.reportFile
          if (snap.workId !== undefined) {
            rt.closeWork?.(snap.workId, `task "${snap.workTitle ?? task.title}"`, snap.workResult ?? snap.summary ?? '(completed)')
          }
          changed = true
        }
        if (snap.handoffExchangeId !== undefined) {
          if (snap.handoffImOrigin !== undefined && rt.state.imReplyOrigins?.[snap.handoffExchangeId] === undefined) {
            rt.rememberImReplyOrigin?.(snap.handoffExchangeId, snap.handoffImOrigin)
            changed = true
          }
          const hadHandoff = rt.state.works?.[snap.handoffExchangeId] !== undefined
          const closedHandoff = rt.closeWork?.(
            snap.handoffExchangeId,
            snap.handoffBotName ?? bot?.name ?? 'The other Bot',
            snap.handoffResult ?? snap.summary ?? '',
          )
          if (hadHandoff || closedHandoff !== undefined) changed = true
        }
        if (changed) {
          dirty = true
          applied.push(marker)
        } else {
          alreadySynced.push(marker)
        }
      } else if (marker.kind === 'room_report') {
        let changed = false
        if (snap.sub !== undefined) {
          const hadSub = rt.state.works?.[snap.sub] !== undefined
          const closed = rt.closeWork?.(snap.sub, `Group "${snap.roomName ?? 'group'}"`, snap.workResult ?? '')
          if (hadSub || closed !== undefined) changed = true
        }
        if (snap.imReplyOrigin !== undefined && snap.reportKey !== undefined) {
          if (rt.state.imReplyOrigins?.[snap.reportKey] === undefined) {
            rt.rememberImReplyOrigin?.(snap.reportKey, snap.imReplyOrigin)
            changed = true
          }
        }
        if (rt.state.roomReports?.[marker.ownerId] !== undefined) {
          delete rt.state.roomReports[marker.ownerId]
          changed = true
        }
        if (changed) {
          dirty = true
          applied.push(marker)
        } else {
          alreadySynced.push(marker)
        }
      } else {
        alreadySynced.push(marker)
      }
    }
    for (const marker of alreadySynced) {
      coord.clearTerminalMarker?.(marker.kind, marker.ownerId)
    }
    if (dirty) {
      try {
        await rt.save()
        for (const marker of applied) {
          coord.clearTerminalMarker?.(marker.kind, marker.ownerId)
        }
      } catch (error) {
        rt.warn('ds-bot: saving reconciled terminal markers failed: %s', error)
      }
    }
  }

  // Replays durable pending obligations (`task_report`, `room_report`, `peer_result`)
  // committed in `coordination.sqlite` before a crash or restart. Verifies durable
  // session evidence and pair-ledger state first so every owed delivery lands once.
  async function recoverObligations(keepTaskSessions = new Set()) {
    if (stopped || rt.readOnly?.() !== undefined || !coord) return
    coord.syncLegacyInflight?.()
    const pending = coord.listPendingObligations()
    if (pending.length === 0) return
    for (const obl of pending) {
      if (stopped || rt.readOnly?.() !== undefined) return
      const payload = obl.payload
      if (!payload || typeof payload !== 'object' || !payload.toId) {
        coord.markObligation(obl.id, 'cancelled')
        continue
      }
      if (rt.botOf(payload.toId) === undefined) {
        coord.markObligation(obl.id, 'cancelled')
        continue
      }
      const target = resolveReplayTarget(payload.sessionId, { ...payload, address: obl.address })
      if (target === undefined) {
        coord.markObligation(obl.id, 'cancelled')
        rt.noteFailure?.({
          level: 'warn',
          source: 'delivery',
          code: 'RECIPIENT_CLOSED',
          text: 'The pending report or result was not redirected: its original task or group has closed.',
          bot: rt.botOf(payload.toId)?.name,
        })
        continue
      }
      const dest = target.sessionId
      const exchangeId = payload.exchangeId ?? obl.deliveryId ?? obl.id
      const deliverArgs = {
        ...payload,
        exchangeId,
        address: target.address,
        sessionId: dest,
        ...(target.fellBackFromRoom ? { imOrigin: undefined } : {}),
      }
      // If already queued in-memory/DB for resend or already in pair ledger, avoid duplicating.
      const alreadyQueued = Object.values(queued).some(items => Array.isArray(items) && items.some(item => item.args?.exchangeId === exchangeId))
      if (alreadyQueued) {
        coord.markObligation(obl.id, 'settled')
        continue
      }
      if (obl.kind === 'peer_result' && payload.replyTo && rt.wasReplyDelivered?.(payload.fromId, payload.toId, payload.replyTo) === true) {
        coord.markObligation(obl.id, 'settled')
        continue
      }
      const agent = await rt.resolveAgent(dest).catch(() => undefined)
      const inInbox = [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])].some(m =>
        m?.source?.exchangeId === exchangeId
        && (m.source.role === undefined || receiptKeyOf(m.source) === receiptKeyOf(deliverArgs)),
      )
      if (inInbox) {
        keepTaskSessions.add(dest)
        coord.markObligation(obl.id, 'settled')
        continue
      }
      const evidence = await rt.readSessionEvidence(dest, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
      const origEvidence = payload.sessionId && payload.sessionId !== dest
        ? await rt.readSessionEvidence(payload.sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
        : { status: 'not_found', events: [] }
      if (evidence.status === 'error' || origEvidence.status === 'error') {
        keepTaskSessions.add(dest)
        rt.noteFailure?.({
          level: 'warn',
          source: 'delivery',
          code: 'CONSUMPTION_UNVERIFIED',
          text: 'Could not verify whether a pending report was already read. It is held, not repeated.',
          sessionId: dest,
        })
        continue
      }
      if ((evidence.status === 'ok' && evidence.events.some(ev => eventMatchesReceipt(ev, deliverArgs)))
        || (origEvidence.status === 'ok' && origEvidence.events.some(ev => eventMatchesReceipt(ev, deliverArgs)))) {
        coord.markObligation(obl.id, 'settled')
        continue
      }
      const ok = await rt.deliver(deliverArgs).then(() => true, (error) => {
        rt.warn('ds-bot: replaying pending obligation %s failed: %s', obl.id, error)
        return false
      })
      if (ok) {
        keepTaskSessions.add(dest)
        coord.markObligation(obl.id, 'settled')
      }
    }
  }

  // A Session's durable log, as DSH keeps it: what happened there, and what it said.
  // Uses the shared cold-session evidence reader (`sessionQuery` / `sessionController`).
  async function logOf(sessionId) {
    const history = await rt.readSessionEvidence(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
    return history.status === 'ok' ? history.events : undefined
  }

  const isTerminalReason = reason => reason !== undefined && reason.kind !== 'interrupted'
    && !(reason.kind === 'aborted' && reason.reason?.kind === 'disposed')

  const whereFor = (asker) => {
    const sender = asker?.senderSessionId
    if (sender === undefined) return { sender: undefined, back: undefined, where: undefined }
    const back = rt.roomOf(asker.senderRoomId)?.sessions?.[sender]
    // The answer would have gone to the part of the asking Bot's chat the request came
    // from, which is not its foreground chat when that part is a background one.
    const where = back ?? (asker.senderPart === undefined ? undefined : threadCurrentOfPart(rt.botOf(sender), asker.senderPart)) ?? rt.chatOf(sender)
    return { sender, back, where }
  }

  async function deliveredAnswer(botId, sender, workId) {
    const delivered = rt.deliveredReplyOf?.(botId, sender, workId)
    if (delivered === undefined) {
      return { answered: rt.deliveredReplyOf === undefined && sender !== undefined && rt.wasReplyDelivered?.(botId, sender, workId) === true }
    }
    const file = delivered.files?.[0]
    const stored = file === undefined ? undefined : await rt.fileText(file, delivered.length)
    if (stored?.whole !== true) return { answered: true, text: delivered.text }
    // Delivery warnings are prepended to the preview and included in its declared length.
    const prefixLength = (delivered.length ?? stored.text.length) - stored.text.length
    const prefix = prefixLength > 0 ? delivered.text.slice(0, prefixLength) : ''
    return { answered: true, text: prefix + stored.text }
  }

  async function alreadyAnswered(botId, sender, where, back, roomId, workId) {
    const delivered = await deliveredAnswer(botId, sender, workId)
    if (delivered.answered) return delivered
    if (where === undefined) return { answered: false }
    const sent = await logOf(where)
    if (sent !== undefined && answeredIn(sent, workId)) return { answered: true }
    const segments = back === undefined
      ? (threadOfPart(rt.botOf(sender), where)?.segments ?? [])
      : (rt.roomOf(roomId)?.segments?.[sender] ?? [])
    for (const segment of [...segments].reverse()) {
      if (segment?.sessionId === undefined || segment.sessionId === where) continue
      const earlier = await logOf(segment.sessionId)
      if (earlier !== undefined && answeredIn(earlier, workId)) return { answered: true }
    }
    return { answered: false }
  }

  // A turn that ended while DS Bot was not watching it: its answer may exist and never
  // have gone to the Bot that waits for it. The Session's durable log says what it did;
  // the work it was for is settled once, the way a finished turn settles it.
  async function reconcileEnded(sessionId, record, ended, prefetchedEvents) {
    const trigger = record.trigger
    if (trigger === undefined) return
    const workId = rt.workOf(trigger)
    const ownsPrimary = rt.ownsWork(record.botId, workId)
    const hasOwnedWork = ownsPrimary || Object.values(rt.state?.works ?? {}).some(work => work.to === record.botId)
    if (!hasOwnedWork) return
    const exchangeId = trigger.exchangeId
    if (exchangeId === undefined) return
    const primaryAsker = ownsPrimary ? rt.workAsker(workId) : undefined
    const primarySender = primaryAsker?.senderSessionId
    const canSettlePrimary = ownsPrimary && primarySender !== undefined && rt.botOf(primarySender) !== undefined
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? rt.botOf(record.botId)?.name ?? 'The other Bot'
    // DSH stopped that turn as it shut down: it is picked up at the next start.
    if (ended.reason?.kind === 'aborted' && ended.reason.reason?.kind === 'disposed') {
      update(sessionId, () => record)
      return
    }
    const events = prefetchedEvents ?? await logOf(sessionId)
    if (events === undefined) {
      if (!canSettlePrimary) return
      const delivered = await deliveredAnswer(record.botId, primarySender, workId)
      if (delivered.answered) {
        rt.closeWork?.(workId, name, delivered.text || rt.answerText(workId, '', name))
        return
      }
      // The record of that work cannot be read: whether it answered cannot be
      // established. The sender is told that, and the work is not run again.
      const why = 'the record of that work could not be read'
      const text = `${name} could not answer your message: ${why}, so what it did is unknown (its session is ${sessionId}). It may have done part of the work. Tell the user if it matters; do not run the work again without asking.`
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        text: `the result of the work ${name} was given is unknown`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
      answerSender(rt, sessionId, primaryAsker, text)
      return
    }
    const turn = turnOf(events, exchangeId)
    // The request was never taken up: it is still waiting, and the delivery that is
    // waiting for it keeps what it had.
    if (turn === undefined) return
    const said = turn.texts.join('\n\n')
    let primarySettled = !canSettlePrimary
    if (canSettlePrimary) {
      // The answer went up in another run (even before a part switch): the work closes
      // with what it said, and nothing is sent twice.
      const { sender, back, where } = whereFor(primaryAsker)
      const answered = await alreadyAnswered(record.botId, sender, where, back, primaryAsker.senderRoomId, workId)
      if (answered.answered) {
        rt.closeWork?.(workId, name, answered.text || rt.answerText(workId, said, name))
        primarySettled = true
      }
    }
    const reason = turn.reason
    // A turn that went on to a fresh part goes on there; it is not settled here.
    if (reason?.kind === 'blocked') return
    // Check whether the interrupted turn can be replayed, as after a restart.
    if (reason === undefined || reason.kind === 'interrupted') {
      if (!primarySettled) await resumeTurn(rt, sessionId, record)
      return
    }
    const failure = reason.kind === 'error' ? turnFailure(reason.error) : undefined
    const dedupKey = failure !== undefined
      ? `reconcile:${sessionId}:${turn.turn ?? ''}:error:${failure.requestId ?? failure.code}`
      : reason.kind === 'aborted'
        ? `reconcile:${sessionId}:${turn.turn ?? ''}:aborted`
        : undefined
    const settleFailureOrAbort = (asker) => {
      if (failure !== undefined) {
        answerSender(rt, sessionId, asker, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`, undefined, { failure, dedupKey })
      } else {
        // The turn was stopped before it could answer: the sender is told, as it is told
        // when DS Bot watches the turn end.
        answerSender(rt, sessionId, asker, `${name} was stopped before it could answer your message.`, undefined, { dedupKey })
      }
    }
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      if (!primarySettled) settleFailureOrAbort(primaryAsker)
      // Steered requests that joined the same failed or aborted turn also owe their own
      // callers settlement, so distinct parent works cannot stall across a restart.
      const seen = new Set([workId, exchangeId])
      for (const took of turn.took) {
        if (took?.kind !== SOURCE_KIND || (took.role !== 'request' && took.role !== 'stopped') || took.audience === 'user') continue
        const joinedId = took.exchangeId
        if (typeof joinedId !== 'string' || joinedId === '' || seen.has(joinedId)) continue
        seen.add(joinedId)
        if (!rt.ownsWork(record.botId, joinedId)) continue
        const joinedAsker = rt.workAsker(joinedId)
        const { sender, back, where } = whereFor(joinedAsker)
        if (sender === undefined || rt.botOf(sender) === undefined) continue
        const answered = await alreadyAnswered(record.botId, sender, where, back, joinedAsker.senderRoomId, joinedId)
        if (answered.answered) {
          rt.closeWork?.(joinedId, name, answered.text || rt.answerText(joinedId, '', name))
          continue
        }
        settleFailureOrAbort(joinedAsker)
      }
      return
    }
    if (!primarySettled) {
      // A turn cut off at the output limit is not a finish: the answer says so, and the
      // diagnostics record it, with the route the Session's log holds for it.
      const cutOff = reason?.kind === 'max-tokens'
      const withoutText = cutOff && turn.texts.length === 0
      if (cutOff) {
        rt.noteCutOffTurn?.(sessionId, { withoutText })
        const context = events.findLast(event => event?.type === 'request/context')?.data
        const ref = context?.provider && context?.model ? `${context.provider}/${context.model}` : undefined
        const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
        rt.noteFailure?.({
          level: 'warn',
          source: 'turn',
          code: 'MAX_TOKENS',
          text: `${withoutText
            ? 'the turn was cut off at the output limit before it wrote anything'
            : 'the turn was cut off at the output limit, so its answer is not complete'}${ref ? ` (${ref})` : ''}`,
          bot: name,
          where: room === undefined ? 'own chat' : `group "${room.name}"`,
          sessionId,
        })
      }
      const answer = cutOff ? cutOffText(said) : said
      // The turn ended with what it said: the answer goes up the way a finished turn's
      // does, with the results that came back for it and the text it held. A work that
      // still waits for what it handed on keeps its part until that comes back.
      if (rt.waitsWork(workId)) rt.holdWork(workId, answer)
      else {
        const text = rt.answerText(workId, answer, name)
        const long = text.length > MESSAGE_INLINE_MAX ? await rt.attachLong(text, `Answer from ${name}.txt`) : undefined
        answerSender(rt, sessionId, primaryAsker, text, long)
      }
    }
    // A request that steered into this turn is answered in a turn of its own; a crash
    // after the completed turn/end but before that delivery left it open.
    await recoverJoinedRequests(sessionId, record, turn, events, name)
  }

  // Requests the turn read as steering are handed back to the Bot in a turn of their
  // own when the turn ends. A crash between a successful turn/end reaching disk and
  // that delivery leaves them open, and the caller or parent waits forever. The durable
  // log still holds them, so each is delivered again in the same conversation — with
  // the attachments and the work it came with — unless it was already handed back, taken
  // up, or answered before the crash.
  async function recoverJoinedRequests(sessionId, record, turn, events, name) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return
    const seen = new Set([rt.workOf?.(record.trigger), record.trigger?.exchangeId])
    for (const source of turn.took) {
      if (source?.kind !== SOURCE_KIND) continue
      if (source.role !== 'request' && source.role !== 'stopped') continue
      if (source.audience === 'user') continue
      const exchangeId = source.exchangeId
      if (typeof exchangeId !== 'string' || exchangeId === '' || seen.has(exchangeId)) continue
      seen.add(exchangeId)
      // A request whose work is gone was closed, or answered, in another run.
      if (source.role === 'request' && !rt.ownsWork(record.botId, exchangeId)) continue
      const sender = source.senderSessionId
      if (sender === undefined || rt.botOf(sender) === undefined) continue
      // Handed back after this turn ended: it is already in the Session's log, and the
      // restart resend or its own inbox moves it; an earlier or later turn took it up.
      if (turn.end !== undefined && events.some(event => event.seq !== undefined && event.seq > turn.end
        && event.type === 'user/message'
        && (event.data?.source?.exchangeId === exchangeId
          || event.data?.source?.joined?.some(item => item?.info?.exchangeId === exchangeId)))) continue
      if (rt.unreadOf?.(sessionId)?.some(args => args.exchangeId === exchangeId)) continue
      // The reply went out in another run: the work closes with what it said, and the
      // Bot is not asked again.
      if (source.role === 'request') {
        const asker = rt.workAsker(exchangeId)
        if (asker !== undefined) {
          const { back, where } = whereFor(asker)
          const answered = await alreadyAnswered(record.botId, sender, where, back, asker.senderRoomId, exchangeId)
          if (answered.answered) {
            rt.closeWork?.(exchangeId, name, answered.text || rt.answerText(exchangeId, '', name))
            continue
          }
        }
      }
      const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
      const saved = turn.messages?.[exchangeId]
      const content = Array.isArray(saved?.content) ? saved.content : []
      const text = typeof saved?.text === 'string'
        ? saved.text
        : textOf(content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')
      const images = content.filter(block => block?.type === 'image' && block.attachment !== undefined).map(block => block.attachment)
      const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
      // The checks above awaited, so the normal path may have committed this exchange,
      // started a live turn for it, or closed its work in the meantime. Check once more
      // with nothing awaited between here and the delivery: a queued note, an inbox
      // entry, or a live turn holding the same exchange means it was already handed back,
      // and a closed work has nothing left to answer.
      const liveEntry = rt.live?.get(sessionId)
      const liveHeld = [
        liveEntry?.info,
        liveEntry?.pending,
        liveEntry?.carry?.info,
        ...(liveEntry?.joined ?? []).map(joined => joined?.info),
        ...(liveEntry?.pending?.joined ?? []).map(joined => joined?.info),
        ...(liveEntry?.carry?.joined ?? []).map(joined => joined?.info),
      ]
      const alreadyHandedBack = rt.unreadOf?.(sessionId)?.some(args => args.exchangeId === exchangeId) === true
        || [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])]
          .some(message => message?.source?.exchangeId === exchangeId
            || message?.source?.joined?.some(item => item?.info?.exchangeId === exchangeId))
        || liveHeld.some(item => item?.exchangeId === exchangeId)
      const workOpen = source.role !== 'request'
        || (rt.ownsWork(record.botId, exchangeId) && rt.workAsker(exchangeId) !== undefined)
      if (alreadyHandedBack || !workOpen) continue
      try {
        await rt.deliver({
          fromId: sender,
          toId: record.botId,
          sessionId,
          text,
          role: source.role,
          exchangeId,
          deferred: true,
          ...(source.senderPart ? { fromPart: source.senderPart } : {}),
          ...(source.senderRoomId ? { fromRoomId: source.senderRoomId } : {}),
          ...(source.roomId ? { roomId: source.roomId } : {}),
          ...(source.askedBy ? { askedBy: source.askedBy } : {}),
          ...(source.batchKey ? { batchKey: source.batchKey } : {}),
          ...(source.resumedUpstream ? { resumedUpstream: true } : {}),
          ...(source.resultRef ? { resultRef: source.resultRef } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { files } : {}),
        })
      } catch (error) {
        rt.warn('ds-bot: handing a steered request back to %s failed: %s', name, error)
      }
    }
  }

  // Checks whether the work or reply-expecting trigger a stale inflight turn names has
  // already been answered in the pair ledger or the asker's session log. For a
  // continuation turn (`role: 'reply' | 'report' | 'resume'`), the owed answer is the
  // upstream work and its asker, never the child reply that triggered the turn.
  async function settleDeliveredTrigger(record, trigger) {
    const workId = rt.workOf(trigger)
    if (workId !== undefined) {
      const owns = rt.ownsWork(record.botId, workId)
      const asker = owns ? rt.workAsker(workId) : undefined
      const sender = asker?.senderSessionId
        ?? (trigger.role === 'request' && trigger.audience !== 'user' ? trigger.senderSessionId : undefined)
      const name = rt.botOf(record.botId)?.name ?? 'The other Bot'
      if (owns && asker !== undefined && sender !== undefined && rt.botOf(sender) !== undefined) {
        const { back, where } = whereFor(asker)
        const answered = await alreadyAnswered(record.botId, sender, where, back, asker.senderRoomId, workId)
        if (answered.answered) {
          rt.closeWork?.(workId, name, answered.text || rt.answerText(workId, '', name))
          return true
        }
        return false
      }
      const delivered = await deliveredAnswer(record.botId, sender, workId)
      if (delivered.answered) {
        if (owns) rt.closeWork?.(workId, name, delivered.text || rt.answerText(workId, '', name))
        return true
      }
      return false
    }
    if (trigger.role === 'stopped' && trigger.exchangeId !== undefined && trigger.senderSessionId !== undefined) {
      return rt.wasReplyDelivered?.(record.botId, trigger.senderSessionId, trigger.exchangeId) === true
    }
    return false
  }

  // Reconciles a group member turn that finished or failed while DS Bot was offline,
  // posting its unseen reply/failure once via `lateRoomReply`/`lateRoomFailure` and
  // recovering any deferred messages steered into that turn.
  async function reconcileEndedGroupTurn(sessionId, record, ended, prefetchedEvents) {
    if (ended.reason?.kind === 'aborted' && ended.reason.reason?.kind === 'disposed') {
      update(sessionId, () => record)
      return
    }
    const room = rt.roomOf(record.roomId)
    const bot = rt.botOf(record.botId)
    if (room === undefined || bot === undefined || !room.members.includes(bot.id)) return
    const events = prefetchedEvents ?? await logOf(sessionId)
    if (events === undefined) return
    const turn = findRecordedTurn(events, record)
    if (turn === undefined) return
    const reason = turn.reason ?? ended.reason
    if (reason?.kind === 'blocked') return
    if (reason === undefined || reason.kind === 'interrupted') {
      await resumeTurn(rt, sessionId, record)
      return
    }
    const since = record.since ?? 0
    const roomLines = [
      ...(rt.ledger?.records?.(`group-${room.id}`) ?? []),
      ...(Array.isArray(room.log) ? room.log : []),
    ]
    const roomSessionId = rt.sessionOfRoom?.(room) ?? room.sessionId ?? room.id
    const roomAgent = await rt.resolveAgent(roomSessionId).catch(() => undefined)
    const queuedPosts = [...(roomAgent?.inbox?.nextStep ?? []), ...(roomAgent?.inbox?.nextTurn ?? [])]
      .filter(msg => msg?.source?.kind === SOURCE_KIND && msg.source.role === 'post' && msg.source.senderSessionId === bot.id)
    const info = record.trigger ?? { role: 'room', roomId: room.id }
    const isMemberFailureLine = (line, botId) => (line?.about === botId || line?.botId === botId)
      && ((line?.kind === 'notice' && line?.reason === 'failed') || line?.kind === 'failed' || line?.failed !== undefined)
    if (reason.kind === 'error') {
      const alreadyPostedFailure = roomLines.some(line => isMemberFailureLine(line, bot.id) && (line.time ?? 0) >= since)
        || queuedPosts.some(msg => msg.source?.failed !== undefined)
      if (!alreadyPostedFailure) {
        await rt.lateRoomFailure?.(sessionId, info, turnFailure(reason.error))
      }
      return
    }
    if (reason.kind !== 'aborted') {
      const said = turn.texts.join('\n\n').trim()
      const reply = reason.kind === 'max-tokens' ? cutOffText(said) : said
      const trimmed = stripOwnName(bot.name, reply).trim()
      const alreadyPosted = trimmed !== '' && (
        roomLines.some(line => line?.botId === bot.id && !line.progress && line.kind !== 'resumed'
          && (line.time ?? 0) >= since && typeof line.text === 'string' && stripOwnName(bot.name, line.text).trim() === trimmed)
        || queuedPosts.some(msg => stripOwnName(bot.name, textOf(msg.content).replace(/^\[Group post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')).trim() === trimmed)
      )
      if (!alreadyPosted) {
        await rt.lateRoomReply?.(sessionId, info, reply, { toolCount: turn.toolCount ?? 0, ...(turn.turn !== undefined ? { turn: turn.turn } : {}) })
      }
    }
  }

  async function settleEnded(sessionId, record, ended, events) {
    if (record.roomId !== undefined) {
      await reconcileEndedGroupTurn(sessionId, record, ended, events).catch(error => rt.warn('ds-bot: settling the group turn of %s failed: %s', sessionId, error))
      return
    }
    const task = rt.taskOwners?.has(sessionId)
    if (!task || isTerminalReason(ended.reason)) {
      await reconcileEnded(sessionId, record, ended, events).catch(error => rt.warn('ds-bot: settling the work of %s failed: %s', sessionId, error))
    }
    if (task) {
      await rt.reconcileEndedTask?.(sessionId, ended).catch(error => rt.warn('ds-bot: settling task %s failed: %s', sessionId, error))
    }
  }

  const mergeRecoveredSnapshot = (reloaded) => {
    if (reloaded === undefined) return false
    // Post-lock SQLite (after hot-journal rollback + syncLegacyInflight) is the single
    // pre-restart baseline. Exclude turns started in this runtime so live work is never
    // misclassified as interrupted, and merge recovered queued/silent entries with any
    // deliveries buffered during the startup window rather than overwriting either side.
    const preRestartTurns = {}
    for (const [sid, rec] of Object.entries(reloaded.turns ?? {})) {
      if (!(sid in turns)) preRestartTurns[sid] = rec
    }
    const recoveredQueued = reloaded.queued ?? {}
    const recoveredSilent = reloaded.silent ?? {}
    interrupted = {
      turns: preRestartTurns,
      queued: recoveredQueued,
      silent: recoveredSilent,
      obligations: reloaded.obligations ?? [],
      terminalMarkers: reloaded.terminalMarkers ?? [],
    }
    const mergedQueued = { ...queued }
    const existingQueuedIds = new Set(Object.values(mergedQueued).flat().map(item => item?.args?.exchangeId).filter(Boolean))
    for (const [sid, list] of Object.entries(recoveredQueued)) {
      if (!Array.isArray(list)) continue
      const additions = list.filter(item => item?.args?.exchangeId && !existingQueuedIds.has(item.args.exchangeId))
      if (additions.length === 0) continue
      for (const item of additions) existingQueuedIds.add(item.args.exchangeId)
      mergedQueued[sid] = [...additions, ...(mergedQueued[sid] ?? [])]
    }
    queued = mergedQueued
    const mergedSilent = { ...silent }
    for (const [sid, list] of Object.entries(recoveredSilent)) {
      if (!Array.isArray(list) || list.length === 0) continue
      const current = mergedSilent[sid] ?? []
      const currentIds = new Set(current.map(entry => entry?.message?.source?.exchangeId).filter(Boolean))
      const additions = list.filter((entry) => {
        const exId = entry?.message?.source?.exchangeId
        return !exId || !currentIds.has(exId)
      })
      if (additions.length > 0) mergedSilent[sid] = [...additions, ...current]
    }
    silent = mergedSilent
    recoveringTurns = preRestartTurns
    return Object.keys(preRestartTurns).length > 0
      || Object.keys(recoveredQueued).length > 0
      || Object.keys(recoveredSilent).length > 0
  }

  let recoveredSnapshotPending = false
  const ensureRecoveredBeforeReplay = () => {
    if (stopped || rt.readOnly?.() !== undefined || !rt.hasLoaded?.()) return
    if (coord?.recoverAfterLock?.() === true) {
      coord?.syncLegacyInflight?.()
      if (mergeRecoveredSnapshot(coord.loadInitialState?.())) recoveredSnapshotPending = true
    } else {
      coord?.syncLegacyInflight?.()
    }
  }
  const peekStartupSilent = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    ensureRecoveredBeforeReplay()
    const list = interrupted.silent?.[sessionId]
    return Array.isArray(list) ? list : []
  }
  const clearStartupSilent = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (interrupted.silent !== undefined && Object.hasOwn(interrupted.silent, sessionId)) {
      const next = { ...interrupted.silent }
      delete next[sessionId]
      interrupted = { ...interrupted, silent: next }
    }
  }
  rt.peekStartupSilent = peekStartupSilent
  rt.clearStartupSilent = clearStartupSilent

  async function resumeAll() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    ensureRecoveredBeforeReplay()
    recoveredSnapshotPending = false
    if ((coord?.listTerminalMarkers?.().length ?? 0) > 0) {
      await reconcileTerminalMarkers().catch(error => rt.warn('ds-bot: reconciling terminal markers failed: %s', error))
    }
    const { turns: noted, queued: dropped, silent: droppedSilent } = interrupted
    interrupted = { turns: {}, queued: {}, silent: {} }
    // What the last run still had on the way is noted again first, under the
    // Session it would go to now: nothing is cleared before it is handed over.
    // A Bot that is gone takes its notes with it; what a turn already read here
    // is done with.
    const pending = queued
    const now = Date.now()
    const stale = new Set()
    queued = {}
    for (const [oldId, list] of Object.entries(pending)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (Number.isFinite(item?.at) && now - item.at > QUEUED_TTL_MS) {
          stale.add(item)
          continue
        }
        if (item?.args?.exchangeId === undefined || taken?.has(item.args.exchangeId) === true || rt.botOf(item.args.toId) === undefined) continue
        const target = resolveReplayTarget(oldId, item.args)
        if (target === undefined) {
          rt.noteFailure?.({
            level: 'warn',
            source: 'delivery',
            code: 'RECIPIENT_CLOSED',
            text: 'The delivery was not redirected: its original task or group has closed.',
            sessionId: oldId,
          })
          continue
        }
        const updatedArgs = { ...item.args, address: target.address }
        queued = { ...queued, [target.sessionId]: [...(queued[target.sessionId] ?? []), { ...item, args: updatedArgs }] }
      }
    }
    coord?.replaceAllDeliveries?.(queued)
    persist()
    if (stale.size > 0) rt.warn?.('ds-bot: dropped %d stale queued notes older than 30 minutes', stale.size)
    // Silent notices the last run buffered go back before anything wakes a Session, keeping their order, without
    // waking an idle recipient (or wiping notes buffered during the startup window).
    await rt.restoreSilentNotes?.(droppedSilent).catch(error => rt.warn('ds-bot: restoring silent notes failed: %s', error))
    persist()
    // Agents and inboxes are read before anything wakes their Sessions.
    const cut = []
    const keepTaskSessions = new Set()
    const unverified = {}
    for (const [sessionId, record] of Object.entries(noted)) {
      const first = firstTurn?.get(sessionId)
      if (first?.type === 'turn/end') {
        // The turn ended while DS Bot was not watching it: what it did is settled from
        // the Session's durable log.
        await settleEnded(sessionId, record, first)
        continue
      }
      // Still running: noted again, as if it had started here.
      if (first === undefined && (await rt.resolveAgent(sessionId).catch(() => undefined))?.status === 'running') {
        update(sessionId, () => record)
        keepTaskSessions.add(sessionId)
        continue
      }
      // A noted turn (Bot work, the user's, a group member's) is read from the durable log before it is settled,
      // held or resumed: a turn already ended there is settled once (upstream #2144: a group turn's unseen reply or
      // failure is posted to its group), and one whose log cannot be read is neither settled nor run again.
      let inspectedEvents
      let inspectedTurn
      if (first === undefined) {
        const history = await rt.readSessionEvidence(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
        inspectedEvents = history.status === 'ok' ? history.events : undefined
        inspectedTurn = inspectedEvents === undefined ? undefined : findRecordedTurn(inspectedEvents, record)
        const unknownTool = !isTerminalReason(inspectedTurn?.reason)
          && record.approval === undefined
          && (inspectedTurn?.unconfirmedCalls?.size ?? 0) > 0
        if (history.status === 'error' || unknownTool) {
          unverified[sessionId] = { ...record, unverified: true }
          keepTaskSessions.add(sessionId)
          rt.noteFailure?.({
            level: 'warn',
            source: 'delivery',
            code: 'TURN_UNVERIFIED',
            text: unknownTool
              ? 'A tool started before restart but has no saved result. Verify its effect before continuing; it was not run again.'
              : 'Could not verify whether this turn finished. Its commands were not restarted.',
            sessionId,
          })
          continue
        }
        if (isTerminalReason(inspectedTurn?.reason)) {
          await settleEnded(sessionId, record, { reason: inspectedTurn.reason }, inspectedEvents)
          continue
        }
        if (record.roomId === undefined && record.trigger !== undefined && await settleDeliveredTrigger(record, record.trigger)) {
          if (inspectedTurn !== undefined) {
            const name = rt.botOf(record.botId)?.name ?? 'The other Bot'
            await recoverJoinedRequests(sessionId, record, inspectedTurn, inspectedEvents, name)
          }
          continue
        }
      }
      cut.push([sessionId, record, inspectedEvents, inspectedTurn])
    }
    firstTurn = undefined
    for (const [sessionId, list] of Object.entries(dropped)) {
      if (!Array.isArray(list)) continue
      // Resends read the original notes, which still include the expired items.
      const active = await resendQueued(sessionId, list.filter(item => !stale.has(item))).catch((error) => {
        rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error)
        return new Set()
      })
      for (const dest of active ?? []) keepTaskSessions.add(dest)
    }
    taken = undefined
    for (const [sessionId, record, events, turn] of cut) {
      const resumed = await resumeTurnKept(sessionId, record).catch((error) => {
        rt.warn('ds-bot: picking up the turn of %s failed: %s', sessionId, error)
        return false
      })
      if (resumed === true) keepTaskSessions.add(sessionId)
      // Requests that steered into the cut turn are handed back in turns of their own, so they are not dropped
      // when only the trigger is picked up.
      if (turn !== undefined && turn.took.length > 0) {
        const name = rt.botOf(record.botId)?.name ?? 'The other Bot'
        await recoverJoinedRequests(sessionId, record, turn, events, name).catch(error => rt.warn('ds-bot: handing back steered requests of %s failed: %s', sessionId, error))
      }
    }
    // Reconcile orphaned background tasks before settling room batches so a zombie
    // group task does not keep `hasRoomTasks` true and mask a stuck batch.
    recoveringTurns = unverified
    coord?.replaceAllTurns?.({ ...recoveringTurns, ...turns })
    persist()
    await recoverObligations(keepTaskSessions).catch(error => rt.warn('ds-bot: replaying pending obligations failed: %s', error))
    await rt.reconcileTasksAfterRestart?.(keepTaskSessions).catch(error => rt.warn('ds-bot: reconciling background tasks failed: %s', error))
    // What a group's members were asked for and will not pick up is settled now.
    await rt.settleRoomBatches?.()
    await rt.settleRoomReports?.(undefined, { startup: true })
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0
      || Object.keys(interrupted.queued).length > 0
      || Object.keys(interrupted.silent ?? {}).length > 0
      || (interrupted.obligations?.length ?? 0) > 0
      || (interrupted.terminalMarkers?.length ?? 0) > 0
    // With nothing to pick up, orphaned tasks and group batches a restart left are settled at once.
    const timer = pending
      ? setTimeout(() => void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)), RESUME_DELAY_MS)
      : setTimeout(() => {
        void rt.load()
          .then(() => {
            if (rt.readOnly() === undefined) {
              ensureRecoveredBeforeReplay()
              if (recoveredSnapshotPending) {
                recoveredSnapshotPending = false
                return resumeAll()
              }
            }
            firstTurn = undefined
            taken = undefined
            const hasWork = (coord?.listTerminalMarkers?.().length ?? 0) > 0
              || (coord?.listPendingObligations?.().length ?? 0) > 0
            return hasWork
              ? reconcileTerminalMarkers().then(() => recoverObligations()).then(() => rt.reconcileTasksAfterRestart?.(new Set()))
              : rt.reconcileTasksAfterRestart?.(new Set())
          })
          .then(() => rt.settleRoomBatches?.())
          .then(() => rt.settleRoomReports?.(undefined, { startup: true }))
          .catch(error => rt.warn('ds-bot: settling group batches failed: %s', error))
      }, 0)
    timer?.unref?.()
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      return writing
    }
  }, 'ds-bot: resume interrupted turns')
}
