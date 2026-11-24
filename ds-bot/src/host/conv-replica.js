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
import { ensureMirrorSession } from './mirror.js'
import { turnEnd } from './turn-end.js'

const HUB = 'hub'
// What a page shows of a turn; everything else of a Session (requests, inbox splices, catalogs…) stays home.
export const REPLICATED = new Set(['turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end'])
const STRING_MAX = 16_000
const FRAME_MAX = 200_000
const SURFACED = new Set(['user/message', 'assistant/message'])

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
    // The Bot's own chat only: not its background tasks or work threads, not its group Sessions.
    const botId = rt.chatOwners?.get(sessionId)
    if (botId === undefined || rt.taskOwners?.has(sessionId) || rt.groupOwners?.has(sessionId)) return
    const network = serviceOf(rt, 'remote-agent:bot-network')
    if (typeof network?.post !== 'function') return
    const own = ownNodeId(rt)
    if (own === undefined || own === HUB) return
    const bot = rt.botOf(botId)
    if (bot === undefined || isRemoteBot(bot)) return
    const ref = refOf(rt, bot)
    if (ref === undefined) return
    try {
      network.post('team/conv', { bot: ref, sid: sessionId, seq: event.seq, type: event.type, data: sanitize(event.data ?? {}) })
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
  const session = holdPage(rt, await ensureMirrorSession(rt, bot))
  const replicas = (rt.state.replicas ??= {})
  const mine = (replicas[bot.id] ??= { sessions: {} })
  const from = (mine.sessions[data.sid] ??= { seq: -1, turns: {} })
  if (data.seq <= from.seq) return
  from.seq = data.seq
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
        noteRunning(rt, bot, true)
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
        noteRunning(rt, bot, true)
      }
      const copy = turn === undefined ? event : { ...event, turn }
      if (data.type === 'user/message') {
        // The page's own message comes back with the id of the page's request, so the composer retires its echo.
        const rpcId = copy.source?.rpcId
        const requestId = typeof rpcId === 'string' ? rt.joinedRequestOf?.(rpcId) : undefined
        if (requestId !== undefined) copy.source = { ...copy.source, rpcId: requestId }
      }
      session.append(data.type, copy, SURFACED.has(data.type) ? { surfaceOp: 'append' } : undefined)
      if (data.type === 'turn/end') {
        if (Number.isInteger(nodeTurn)) delete from.turns[nodeTurn]
        noteRunning(rt, bot, false)
      }
    })
  } catch (error) {
    // One event the page cannot take does not stop the rest (the order holds; nothing is sent again for it).
    rt.warn?.('ds-bot: the copy of a %s event of %s was not written: %s', data.type, bot.name, error?.message ?? error)
  }
  await rt.ctx?.sessions?.flush?.(session).catch?.(() => {})
  void rt.save?.().catch(() => {})
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
