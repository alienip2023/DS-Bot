// conv-replica.js — the hub's page of a node Bot is a copy of that Bot's own chat (work model W4,
// docs/plans/2026-11-24-work-model.md).
//
// NODE: every event of a local Bot's own chat that a page shows (a turn's start and end, its steps, the user's
// message, the answer with its thinking and tool calls, the tool results) goes to the hub as one `team/conv` frame
// over AC's reliable link, in order, exactly once.
//
// HUB: those frames are the ONLY writes to the node Bot's page Session. Its `append` is held: nothing else of this
// plugin (page turns, steer turns, late replies, trace steps, stream previews, task reports, history import) can
// write there any more, so the page can no longer disagree with what happened on the node. Turn numbers are the
// page's own (a node's chat counts its turns per Session from 1); the mapping is kept in state.replicas, and a
// frame already applied (same node Session and seq) is skipped.
import { botOfRef, isRemoteBot, ownNodeId, refOf } from './bot-link.js'
import { joinedShadow } from './roster-join.js'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { ensureMirrorSession } from './mirror.js'
import { turnEnd } from './turn-end.js'

const HUB = 'hub'
// What a page shows of a turn; everything else of a Session (requests, inbox splices, catalogs…) stays home.
export const REPLICATED = new Set(['turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end'])
const STRING_MAX = 16_000
const FRAME_MAX = 200_000
// DSH's surface events: each is written with a surface marker (and only these may carry one).
const SURFACED = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const TITLE_MAX = 120

function serviceOf(rt, name) {
  try { return rt.ctx?.get?.(name) } catch { return undefined }
}

// A text past `max` keeps its start and says how much was cut.
const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}\n[… ${text.length - max} more characters on the node]`)

/** What of an event goes over the wire: no attachment of the node, no stream chunks, no text past the caps. */
export function sanitize(data, max = STRING_MAX) {
  const walk = (value, key) => {
    if (typeof value === 'string') return cut(value, max)
    if (Array.isArray(value)) {
      if (key === 'stream') return []
      return value.map(item => {
        if (item && typeof item === 'object' && (item.type === 'image' || item.type === 'file')) {
          const name = item.attachment?.name ?? item.name
          return { type: 'text', text: item.type === 'image' ? `[图片${name ? ` ${name}` : ''}]` : `[文件${name ? ` ${name}` : ''}]` }
        }
        return walk(item)
      })
    }
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        if (k === 'attachment') continue
        out[k] = walk(v, k)
      }
      return out
    }
    return value
  }
  const once = walk(data)
  return JSON.stringify(once).length <= FRAME_MAX || max <= 2_000 ? once : sanitize(data, Math.floor(max / 4))
}

// ── NODE ──

function publishFrom(rt) {
  return (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || !REPLICATED.has(event?.type) || !Number.isInteger(event.seq)) return
    // The Bot's own chat, and its own background tasks and work threads (read-only on the hub); not its group Sessions.
    if (rt.groupOwners?.has(sessionId)) return
    const owner = rt.taskOwners?.get(sessionId)
    if (owner !== undefined && owner.roomId !== undefined) return
    const botId = owner?.botId ?? rt.chatOwners?.get(sessionId)
    if (botId === undefined) return
    const network = serviceOf(rt, 'remote-agent:bot-network')
    if (typeof network?.post !== 'function') return
    const own = ownNodeId(rt)
    if (own === undefined || own === HUB) return
    const bot = rt.botOf(botId)
    if (bot === undefined || isRemoteBot(bot)) return
    const ref = refOf(rt, bot)
    if (ref === undefined) return
    let task
    if (owner !== undefined) {
      const row = (bot.tasks ?? []).find(item => item?.id === owner.taskId)
      task = { id: String(owner.taskId).slice(0, 64), title: String(row?.title ?? '').slice(0, TITLE_MAX), ...(typeof row?.origin === 'string' ? { origin: row.origin.slice(0, 32) } : {}) }
    }
    try {
      network.post('team/conv', { bot: ref, sid: sessionId, seq: event.seq, type: event.type, data: sanitize(event.data ?? {}), ...(task ? { task } : {}) })
    } catch (error) {
      rt.warn?.('ds-bot: an event of %s did not go to the hub: %s', bot.name, error?.message ?? error)
    }
  }
}

// ── HUB ──

const HELD = Symbol('ds-bot replica page')
const WRITING = Symbol('ds-bot replica writing')

/** Hold a node Bot's page Session: from now on only the replica writes it. Returns the Session. */
export function holdPage(rt, session) {
  if (!session || typeof session.append !== 'function' || session[HELD] !== undefined) return session
  const append = session.append
  session[HELD] = append
  let told = false
  session.append = function (type, data, options) {
    if (session[WRITING] === true) return append.call(this, type, data, options)
    if (!told) { told = true; rt.warn?.('ds-bot: the page of a node Bot is a copy of its chat; a write of %s was not made', type) }
    return undefined
  }
  return session
}
const writeAs = (session, fn) => {
  session[WRITING] = true
  try { return fn() } finally { session[WRITING] = false }
}

// The turn the page is in: the last turn/start without its turn/end.
const openTurnOf = (session) => {
  let open
  for (const event of Array.isArray(session.log) ? session.log : []) {
    if (event?.type === 'turn/start') open = event.data?.turn
    else if (event?.type === 'turn/end' && event.data?.turn === open) open = undefined
  }
  return open
}
const lastTurnOf = (session) => {
  let last = 0
  for (const event of Array.isArray(session.log) ? session.log : []) {
    if (event?.type === 'turn/start' && Number.isInteger(event.data?.turn)) last = Math.max(last, event.data.turn)
  }
  return last
}

async function onConv(rt, msg) {
  const data = msg.data ?? {}
  if (ownNodeId(rt) !== HUB || data.bot?.nodeId !== msg.from || !REPLICATED.has(data.type) || typeof data.sid !== 'string' || !Number.isInteger(data.seq)) return
  await rt.load?.()
  const bot = botOfRef(rt, data.bot)
  // Not known here yet (the node's roster comes after the link): not handled, so the link sends it again.
  if (!joinedShadow(bot)) throw new Error(`no page here yet for ${data.bot?.name ?? data.bot?.id} on ${msg.from}`)
  const replicas = (rt.state.replicas ??= {})
  const mine = (replicas[bot.id] ??= { sessions: {} })
  const task = taskOf(data.task)
  const copy = task === undefined ? undefined : await taskCopyOf(rt, bot, mine, task)
  const session = copy === undefined ? holdPage(rt, await ensureMirrorSession(rt, bot)) : copy.session
  const book = copy === undefined ? mine.sessions : (copy.entry.sessions ??= {})
  const from = (book[data.sid] ??= { seq: -1, turns: {} })
  if (data.seq <= from.seq) return
  from.seq = data.seq
  const running = copy === undefined ? on => noteRunning(rt, bot, on) : (on) => { copy.entry.running = on; copy.entry.at = Date.now() }
  const event = structuredClone(data.data ?? {})
  const nodeTurn = event.turn
  try {
    writeAs(session, () => {
      if (data.type === 'turn/start') {
        // A turn the page still holds open (a node turn whose end never came) is closed first.
        const open = openTurnOf(session)
        if (open !== undefined) session.append('turn/end', { turn: open, reason: turnEnd.interrupted() })
        const turn = lastTurnOf(session) + 1
        if (Number.isInteger(nodeTurn)) from.turns[nodeTurn] = turn
        session.append('turn/start', { ...event, turn })
        running(true)
        return
      }
      let turn = Number.isInteger(nodeTurn) ? from.turns[nodeTurn] : openTurnOf(session)
      if (turn === undefined && Number.isInteger(nodeTurn)) {
        // A step of a turn whose start was before the copy began: open it here, so the step has a turn to be in.
        turn = lastTurnOf(session) + 1
        from.turns[nodeTurn] = turn
        const open = openTurnOf(session)
        if (open !== undefined) session.append('turn/end', { turn: open, reason: turnEnd.interrupted() })
        session.append('turn/start', { turn })
        running(true)
      }
      const written = turn === undefined ? event : { ...event, turn }
      if (data.type === 'user/message' && copy === undefined) {
        // The page's own message comes back with the id of the page's request, so the composer retires its echo.
        const rpcId = written.source?.rpcId
        const requestId = typeof rpcId === 'string' ? rt.joinedRequestOf?.(rpcId) : undefined
        if (requestId !== undefined) written.source = { ...written.source, rpcId: requestId }
      }
      session.append(data.type, written, SURFACED.has(data.type) ? { surfaceOp: 'append' } : undefined)
      if (data.type === 'turn/end') {
        if (Number.isInteger(nodeTurn)) delete from.turns[nodeTurn]
        running(false)
      }
    })
  } catch (error) {
    // One event the page cannot take does not stop the rest (the order holds; nothing is sent again for it).
    rt.warn?.('ds-bot: the copy of a %s event of %s was not written: %s', data.type, bot.name, error?.message ?? error)
  }
  await rt.ctx?.sessions?.flush?.(session).catch?.(() => {})
  void rt.save?.().catch(() => {})
}

// The task a frame is from, as the node names it, or undefined for the Bot's own chat.
function taskOf(task) {
  if (!task || typeof task !== 'object' || typeof task.id !== 'string' || task.id === '' || task.id.length > 64) return undefined
  return { id: task.id, title: typeof task.title === 'string' ? task.title.slice(0, TITLE_MAX) : '', ...(typeof task.origin === 'string' ? { origin: task.origin.slice(0, 32) } : {}) }
}

const taskCopies = new WeakMap()
/**
 * The hub's read-only copy of a node Bot's background task or work thread: a Session of its own, written only by the
 * copy, kept in `state.replicas[bot].tasks[taskId]` (the hub's task list shows it, and its reader pages it).
 */
async function taskCopyOf(rt, bot, mine, task) {
  const tasks = (mine.tasks ??= {})
  const entry = (tasks[task.id] ??= { title: task.title, startedAt: Date.now(), at: Date.now() })
  if (task.title !== '') entry.title = task.title
  if (task.origin !== undefined) entry.origin = task.origin
  let pending = taskCopies.get(rt)
  if (!pending) { pending = new Map(); taskCopies.set(rt, pending) }
  const key = `${bot.id}\u0000${task.id}`
  if (!pending.has(key)) pending.set(key, openTaskCopy(rt, bot, entry).finally(() => pending.delete(key)))
  return { entry, session: holdPage(rt, await pending.get(key)) }
}
async function openTaskCopy(rt, bot, entry) {
  if (typeof entry.sessionId === 'string' && entry.sessionId !== '') {
    const agent = await rt.resolveAgent(entry.sessionId).catch(() => undefined)
    if (agent?.session) return agent.session
  }
  const sessionId = await rt.createSession(`${bot.id} task (copy)`)
  const session = (await rt.resolveAgent(sessionId)).session
  if (!session) throw new Error('the copy of a node task has no Session')
  try { session.append('system/message', createSystemMessage(`[copy: ${bot.name} · ${entry.title || 'task'}]`), { protected: true, surfaceOp: 'append' }) } catch {
    try { session.append('system/message', createSystemMessage(`[copy: ${bot.name} · ${entry.title || 'task'}]`), { protected: true }) } catch { /* the copy goes on without a head */ }
  }
  entry.sessionId = sessionId
  await rt.save?.()
  return session
}

/** The hub's copy of a node Bot's task, if the node has sent any of it. */
export function taskCopyEntry(rt, botId, taskId) {
  const entry = rt.state?.replicas?.[botId]?.tasks?.[taskId]
  return typeof entry?.sessionId === 'string' && entry.sessionId !== '' ? entry : undefined
}

function noteRunning(rt, bot, running) {
  if (running) (rt.replicaOpen ??= new Set()).add(bot.id)
  else rt.replicaOpen?.delete(bot.id)
  rt.joinedRunning?.(bot, running)
}

const ATTACH_MS = 5_000

export function install(rt) {
  const { ctx } = rt
  let stopped = false
  let attached
  let off
  rt.holdReplicaPage = session => holdPage(rt, session)
  const attach = () => {
    const network = serviceOf(rt, 'remote-agent:bot-network')
    if (network === attached) return
    off?.()
    off = undefined
    attached = network
    if (typeof network?.onReliable !== 'function') return
    off = network.onReliable('team/conv', async (msg) => {
      if (stopped) throw new Error('ds-bot is unloading')
      await onConv(rt, msg)
    })
  }
  attach()
  const timer = setInterval(attach, ATTACH_MS)
  timer.unref?.()
  ctx?.on?.('session/event', publishFrom(rt))
  ctx?.effect?.(() => () => {
    stopped = true
    clearInterval(timer)
    off?.()
    rt.holdReplicaPage = undefined
  }, 'ds-bot: node Bot pages as copies')
}
