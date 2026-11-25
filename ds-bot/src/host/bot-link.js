// Work across machines (work model W3, docs/plans/2026-11-24-work-model.md).
//
// A Bot handing work to a Bot of another machine opens a child work here, as it does for a Bot of this machine, and
// sends one `work/handoff` frame. The other machine puts the request into the work thread of the pair (W2) and,
// when its turn has answered it, sends `work/result` back; here the result is written into the work and the asker
// is resumed once everything it handed on is back (W1). Results are never delivered as messages, never steered.
//
// The frames go over AC's reliable link (dsh-ai-cluster docs/reliable-link.md): each is handled exactly once, kept
// while the other machine is away (no clock runs). Node-to-node frames go over a direct link between the two nodes when
// there is one (AC 0.4.40), else the hub stores and forwards them; the two ways keep no common order.
// Who sent a frame is the link's fact (`msg.from`), never what the frame says.
import { randomUUID } from 'node:crypto'
import { LATE_ANSWER, WORK_DEPTH_MAX } from './constants.js'
import { joinedShadow, shadowId } from './roster-join.js'
import { threadCurrentOfPart } from './threads.js'

const HUB = 'hub'
const TEXT_MAX = 65_536
const IDENTITY_ID = /^[0-9a-f]{16}$/
const ATTACH_MS = 5_000
const OUTCOMES = new Set(['done', 'failed', 'stopped'])
const CHAIN_MAX = 16
const sameRef = (a, b) => a?.id === b?.id && a?.nodeId === b?.nodeId

/** The Bots waiting above work `parent`, root first, as team refs (fork.125): what came from another machine, then
 *  each asker here, then `sender`. Sent with `work/handoff` so the other machine can refuse loops and depth. */
export function chainFor(rt, parent, sender) {
  const { local = [], remote = [] } = parent === undefined ? {} : rt.chainOf?.(parent) ?? {}
  const refs = [...remote.filter(ref => ref && typeof ref.id === 'string' && typeof ref.nodeId === 'string').map(ref => ({ id: ref.id, nodeId: ref.nodeId }))]
  for (const botId of [...local, sender.id]) {
    const bot = rt.botOf(botId)
    const ref = bot === undefined ? undefined : refOf(rt, bot)
    if (ref !== undefined && !refs.some(other => sameRef(other, ref))) refs.push({ id: ref.id, nodeId: ref.nodeId })
  }
  return refs.slice(-CHAIN_MAX)
}

function serviceOf(rt, name) {
  try { return rt.ctx?.get?.(name) } catch { return undefined }
}
const networkOf = rt => serviceOf(rt, 'remote-agent:bot-network')
// Only the hub has AC's node registry.
const isHub = rt => {
  const registry = serviceOf(rt, 'remote-agent:registry')
  return typeof registry?.send === 'function' || typeof registry?.onlineNodes === 'function'
}

/** This machine's node id in the team: 'hub' on the hub, the node's id on a node. */
export function ownNodeId(rt) {
  if (isHub(rt)) return HUB
  const id = networkOf(rt)?.nodeId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** A Bot that lives on another machine: a node's peer row, or the hub's joined shadow. */
export const isRemoteBot = bot => bot?.origin === 'peer' || joinedShadow(bot)

/** The machine a remote Bot lives on. */
export const machineOf = bot => (bot?.origin === 'peer' ? bot.homeNodeId : bot?.worker?.nodeId)

/** The team-wide reference of a Bot (`{ id, name, nodeId, identityId? }`), as every machine can resolve it. */
export function refOf(rt, bot) {
  const name = String(bot.name || bot.id).slice(0, 80)
  let ref
  if (bot.origin === 'peer') ref = { id: bot.remoteBotId, name, nodeId: bot.homeNodeId }
  else if (joinedShadow(bot)) ref = { id: bot.id, name, nodeId: bot.worker.nodeId }
  else {
    const own = ownNodeId(rt)
    if (own === undefined) return undefined
    ref = own === HUB ? { id: bot.id, name, nodeId: HUB } : { id: shadowId(own, bot.id), name, nodeId: own }
  }
  const identityId = bot.identityId ?? bot.worker?.identityId
  if (typeof identityId === 'string' && IDENTITY_ID.test(identityId)) ref.identityId = identityId
  return typeof ref.id === 'string' && ref.id !== '' && typeof ref.nodeId === 'string' && ref.nodeId !== '' ? ref : undefined
}

/** The Bot (local) or stand-in (remote) a team-wide reference names on this machine. */
export function botOfRef(rt, ref) {
  if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string') return undefined
  const bots = rt.state.bots ?? {}
  const own = ownNodeId(rt)
  let found
  if (ref.nodeId === own) {
    const prefix = own === HUB ? undefined : `joined:${encodeURIComponent(own)}:`
    const local = prefix === undefined ? ref.id : ref.id.startsWith(prefix) ? decodeURIComponent(ref.id.slice(prefix.length)) : undefined
    const bot = local === undefined || !Object.hasOwn(bots, local) ? undefined : bots[local]
    found = bot !== undefined && !isRemoteBot(bot) ? bot : undefined
  } else if (own === HUB) {
    const bot = Object.hasOwn(bots, ref.id) ? bots[ref.id] : undefined
    found = joinedShadow(bot) && bot.worker.nodeId === ref.nodeId ? bot : undefined
  } else {
    found = Object.values(bots).find(bot => bot?.origin === 'peer' && bot.homeNodeId === ref.nodeId && bot.remoteBotId === ref.id)
  }
  if (found !== undefined || typeof ref.identityId !== 'string' || !IDENTITY_ID.test(ref.identityId)) return found
  return Object.values(bots).find(bot => (bot.identityId ?? bot.worker?.identityId) === ref.identityId)
}

// One frame to the machine `nodeId` over AC's reliable link. False when this machine has no link at all.
function post(rt, nodeId, type, data) {
  const network = networkOf(rt)
  if (typeof network?.post !== 'function' || typeof nodeId !== 'string' || nodeId === '') return false
  if (ownNodeId(rt) === HUB) network.post(nodeId, type, data)
  else network.post(type, data, nodeId === HUB ? {} : { to: nodeId })
  return true
}
// What two Bots of two nodes say to each other is also kept on the hub, where the user sees the whole team.
function copyToHub(rt, nodeId, pair) {
  const own = ownNodeId(rt)
  if (own === undefined || own === HUB || nodeId === HUB) return
  try { post(rt, HUB, 'team/pair', pair) } catch (error) { rt.warn?.('ds-bot: the hub copy of a message was not sent: %s', error?.message ?? error) }
}
const notePair = async (rt, { from, to, id, role, text, replyTo }) => {
  await rt.recordPairMessage?.({ from, to, id, role, text, ...(replyTo ? { replyTo } : {}) })
}

/**
 * Hand work to a Bot of another machine. Opens the child work under `parent` and sends `work/handoff`.
 * Returns `{ ok: true, id, away }`, or `{ ok: false, error }` when it cannot be addressed or there is no link.
 */
export async function handoff(rt, { sender, target, text, parent, fromPart }) {
  const fromRef = refOf(rt, sender)
  const toRef = refOf(rt, target)
  const machine = machineOf(target)
  if (fromRef === undefined || toRef === undefined || typeof machine !== 'string') return { ok: false, error: 'E_PEER_UNKNOWN' }
  if (typeof networkOf(rt)?.post !== 'function') return { ok: false, error: 'cross-machine work is not available on this machine' }
  const id = randomUUID()
  rt.openWork(id, { from: sender.id, to: target.id, ...(parent ? { parent } : {}), ...(fromPart ? { fromPart } : {}) })
  rt.state.works[id].remote = { nodeId: machine }
  await rt.save?.({ immediate: true })
  const body = String(text ?? '').slice(0, TEXT_MAX)
  // The asker's conversation, by a name the other machine keeps one work thread for.
  const part = `${fromRef.nodeId}:${rt.partKeyOf?.(fromPart) ?? fromPart ?? 'main'}`
  const chain = chainFor(rt, parent, sender)
  try {
    post(rt, machine, 'work/handoff', { id, from: fromRef, to: toRef, part, text: body, chain })
  } catch (error) {
    rt.dropWork(id)
    return { ok: false, error: String(error?.message ?? error) }
  }
  await notePair(rt, { from: sender.id, to: target.id, id, role: 'request', text: body })
  copyToHub(rt, machine, { from: fromRef, to: toRef, id, role: 'request', text: body })
  const away = target.worker?.online === false
  return { ok: true, id, away }
}

/** Is work `id` one a Bot of another machine handed here (its answer goes back as `work/result`)? */
export const owes = (rt, id) => typeof id === 'string' && rt.state.works?.[id]?.link !== undefined

/** The answer to work a Bot of another machine handed here: closes it here, and sends it home. */
export async function answer(rt, { id, text, outcome = 'done' }) {
  const work = rt.state.works?.[id]
  const link = work?.link
  if (link === undefined) return false
  const name = rt.botOf(work.to)?.name ?? 'the other Bot'
  const body = String(text ?? '').slice(0, TEXT_MAX)
  rt.closeWork(id, name, body)
  post(rt, link.nodeId, 'work/result', { id, outcome: OUTCOMES.has(outcome) ? outcome : 'done', text: body })
  const replyId = randomUUID()
  await notePair(rt, { from: work.to, to: work.from, id: replyId, role: 'reply', text: body, replyTo: id })
  await rt.markPairDelivered?.(work.to, work.from, replyId)
  const me = rt.botOf(work.to)
  if (me !== undefined && link.from !== undefined) copyToHub(rt, link.nodeId, { from: refOf(rt, me), to: link.from, id: replyId, role: 'reply', text: body, replyTo: id })
  return true
}

/** The user gave up waiting for work handed to another machine: it stops there, and answers no more. */
export function cancel(rt, id) {
  const work = rt.state.works?.[id]
  if (work?.remote?.nodeId === undefined) return false
  try { post(rt, work.remote.nodeId, 'work/cancel', { id }) } catch (error) { rt.warn?.('ds-bot: cancelling %s was not sent: %s', id, error?.message ?? error) }
  return true
}

// ── Frames from the other machines ──

async function onHandoff(rt, msg) {
  const data = msg.data ?? {}
  // The link names the machine the frame came from; a frame that claims another is dropped (acked, not handled).
  if (typeof data.id !== 'string' || data.from?.nodeId !== msg.from) {
    rt.warn?.('ds-bot: work/handoff from %s claims to be from %s; dropped', msg.from, data.from?.nodeId)
    return
  }
  await rt.load?.()
  if (rt.state.works?.[data.id] !== undefined) return
  // Its stop came first (the two took different ways, AC 0.4.40 direct links): it is not taken, and the asker hears so.
  if (takeCancelAhead(rt, data.id, msg.from)) {
    post(rt, msg.from, 'work/result', { id: data.id, outcome: 'stopped', text: 'Stopped before it started.' })
    await rt.save?.()
    return
  }
  const to = botOfRef(rt, data.to)
  if (to === undefined || isRemoteBot(to)) {
    post(rt, msg.from, 'work/result', { id: data.id, outcome: 'failed', text: `${data.to?.name ?? 'That Bot'} is not on ${ownNodeId(rt) ?? 'this machine'} any more.` })
    return
  }
  // Its stand-in may not be here yet (the team directory comes after the link): not handled, so not acked; the
  // link sends it again.
  const asker = botOfRef(rt, data.from)
  if (asker === undefined || !isRemoteBot(asker)) throw new Error(`no stand-in here yet for ${data.from?.name ?? data.from?.id} on ${msg.from}`)
  // The Bots waiting above it (fork.125): work that would come back round to one of them, or pass through more hands
  // than the team allows, is refused here too, whatever the other machine checked.
  const chain = (Array.isArray(data.chain) ? data.chain : []).filter(ref => ref && typeof ref.id === 'string' && typeof ref.nodeId === 'string').slice(-CHAIN_MAX).map(ref => ({ id: ref.id, nodeId: ref.nodeId }))
  const own = refOf(rt, to)
  if (own !== undefined && chain.some(ref => sameRef(ref, own))) {
    post(rt, msg.from, 'work/result', { id: data.id, outcome: 'failed', text: `Not taken: ${to.name} is already waiting for the result of this work, further up. It gets that answer by itself once the work is done; do not send the work back round.` })
    return
  }
  if (chain.length > WORK_DEPTH_MAX) {
    post(rt, msg.from, 'work/result', { id: data.id, outcome: 'failed', text: `Not taken: this work has already passed through ${chain.length} Bots, more than the ${WORK_DEPTH_MAX} the team allows. Do it yourself, or give the user what you have.` })
    return
  }
  rt.openWork(data.id, { from: asker.id, to: to.id })
  rt.state.works[data.id].link = { nodeId: msg.from, from: data.from }
  if (chain.length > 0) rt.state.works[data.id].chain = chain
  const thread = await rt.workThreadFor(to, asker, `remote:${typeof data.part === 'string' ? data.part.slice(0, 200) : msg.from}`)
  await rt.workThreadTakes(thread.task, data.id)
  await rt.deliver({ fromId: asker.id, toId: to.id, sessionId: thread.sessionId, text: String(data.text ?? ''), role: 'request', exchangeId: data.id })
  post(rt, msg.from, 'work/status', { id: data.id, status: 'queued' })
}

async function onStatus(rt, msg) {
  const data = msg.data ?? {}
  const work = rt.state.works?.[data.id]
  if (work?.remote?.nodeId !== msg.from) return
  if (data.status === 'queued') await rt.markPairDelivered?.(work.from, work.to, data.id)
  work.remoteStatus = String(data.status ?? '').slice(0, 20)
  await rt.save?.()
}

async function onResult(rt, msg) {
  const data = msg.data ?? {}
  const text = String(data.text ?? '')
  await rt.load?.()
  const work = rt.state.works?.[data.id]
  if (work === undefined) {
    // The wait was given up: the answer still reaches the Bot that waited, marked late, and settles nothing.
    const late = rt.abandonedWork?.(data.id)
    const waiting = late?.waiting ?? late?.from
    if (late === undefined || waiting === undefined || rt.botOf(waiting) === undefined || text === '') return
    await rt.deliver({ fromName: late.name ?? 'the other Bot', toId: waiting, text: LATE_ANSWER + text, role: 'reply', exchangeId: randomUUID(), recordExchange: false })
    return
  }
  if (work.remote?.nodeId !== msg.from) {
    rt.warn?.('ds-bot: work/result for %s came from %s, not from where it was handed; dropped', data.id, msg.from)
    return
  }
  const name = rt.botOf(work.to)?.name ?? 'the other Bot'
  const replyId = randomUUID()
  await notePair(rt, { from: work.to, to: work.from, id: replyId, role: 'reply', text, replyTo: data.id })
  await rt.markPairDelivered?.(work.to, work.from, replyId)
  const failed = data.outcome === 'failed' || data.outcome === 'stopped'
  const parent = work.parent !== undefined && rt.state.works[work.parent] !== undefined ? work.parent : undefined
  if (parent !== undefined) {
    // One result among what its work waits for (W1): written into it; the asker goes on once all is back.
    rt.closeWork(data.id, name, text, { resume: true, ...(failed ? { outcome: data.outcome } : {}) })
    rt.resumeWork(parent)
    return
  }
  // Nothing waits under a work for it (the asker was not in a turn of its own): it reaches the asker once.
  const asker = rt.botOf(work.from)
  rt.closeWork(data.id, name, text)
  if (asker === undefined) return
  const sessionId = work.fromPart === undefined ? undefined : threadCurrentOfPart(asker, work.fromPart) ?? (rt.chatOwners?.has(work.fromPart) ? work.fromPart : undefined)
  await rt.deliver({ fromId: work.to, toId: asker.id, ...(sessionId ? { sessionId } : {}), text, role: 'reply', replyTo: data.id, exchangeId: replyId, recordExchange: false })
}

// A stop for work that has not arrived yet, kept a day by the machine that sent it: its work/handoff may still be on the
// other way (direct links and the hub's store-and-forward do not keep one order between them).
const CANCEL_AHEAD_MS = 24 * 60 * 60 * 1000
function noteCancelAhead(rt, id, nodeId) {
  const now = Date.now()
  const ahead = Object.fromEntries(Object.entries(rt.state.cancelledAhead ?? {}).filter(([, mark]) => now - (mark?.at ?? 0) < CANCEL_AHEAD_MS))
  ahead[id] = { nodeId, at: now }
  rt.state.cancelledAhead = ahead
}
function takeCancelAhead(rt, id, nodeId) {
  const mark = rt.state.cancelledAhead?.[id]
  if (mark?.nodeId !== nodeId || Date.now() - (mark.at ?? 0) >= CANCEL_AHEAD_MS) return false
  delete rt.state.cancelledAhead[id]
  return true
}

async function onCancel(rt, msg) {
  const id = msg.data?.id
  await rt.load?.()
  const work = rt.state.works?.[id]
  if (work === undefined && typeof id === 'string' && id !== '' && !rt.isStoppedWork?.(id)) {
    noteCancelAhead(rt, id, msg.from)
    await rt.save?.()
    return
  }
  if (work?.link?.nodeId !== msg.from) return
  // Answers nothing any more; what it handed on stops too (fork.125), and a turn doing it right now is stopped.
  rt.stopHandedOn?.(id)
  ;(rt.state.stoppedWorks ??= {})[id] = Date.now()
  rt.dropWork(id)
  for (const [sessionId, entry] of rt.live ?? []) {
    if (entry?.turn === undefined || entry.info?.exchangeId !== id) continue
    entry.info = undefined
    const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
    agent?.cancel?.({ kind: 'hook', reason: 'ds-bot/cancelled' })
  }
}

// On the hub: a copy of what two Bots of two nodes said to each other, for their pair's book here.
async function onPair(rt, msg) {
  if (ownNodeId(rt) !== HUB) return
  const data = msg.data ?? {}
  if (data.from?.nodeId !== msg.from) return
  const from = botOfRef(rt, data.from)
  const to = botOfRef(rt, data.to)
  if (from === undefined || to === undefined || typeof data.id !== 'string') return
  await rt.recordPairMessage?.({ from: from.id, to: to.id, id: data.id, role: data.role === 'reply' ? 'reply' : 'request', text: String(data.text ?? ''), ...(typeof data.replyTo === 'string' ? { replyTo: data.replyTo } : {}) })
  await rt.markPairDelivered?.(from.id, to.id, data.id)
}

const HANDLERS = { 'work/handoff': onHandoff, 'work/status': onStatus, 'work/result': onResult, 'work/cancel': onCancel, 'team/pair': onPair }

export function install(rt) {
  const { ctx } = rt
  let stopped = false
  let attached
  let off = []
  // AC may load after ds-bot: attach whenever its bot-network shows up (or changes). Until a handler is here AC
  // keeps the frames (unacked) and sends them again.
  const attach = () => {
    const network = networkOf(rt)
    if (network === attached) return
    for (const undo of off) undo?.()
    off = []
    attached = network
    if (typeof network?.onReliable !== 'function') return
    for (const [type, handler] of Object.entries(HANDLERS)) {
      off.push(network.onReliable(type, async (msg) => {
        if (stopped) throw new Error('ds-bot is unloading')
        await handler(rt, msg)
      }))
    }
  }
  attach()
  const timer = setInterval(attach, ATTACH_MS)
  timer.unref?.()
  rt.link = {
    handoff: args => handoff(rt, args),
    owes: id => owes(rt, id),
    answer: args => answer(rt, args),
    cancel: id => cancel(rt, id),
    botOfRef: ref => botOfRef(rt, ref),
    available: () => typeof networkOf(rt)?.post === 'function',
  }
  ctx?.effect?.(() => () => {
    stopped = true
    clearInterval(timer)
    for (const undo of off) undo?.()
    off = []
    rt.link = undefined
  }, 'ds-bot: work across machines')
}
