// Bot-to-Bot delivery across machines (rewrite R2, docs/plans/2026-11-24-bot-assign.md).
//
// Every machine keeps a row for each Bot that lives elsewhere: a node has peer rows (from the team
// directory), the hub has joined shadows. A message delivered to such a stand-in leaves as one
// `bot/assign` frame instead of reaching a Session here; the Bot's own machine delivers it locally,
// as if the stand-in of the sender had sent it, so all of the local machinery applies there: the
// request opens work, the recipient's turn answers it, and its reply goes back to the stand-in of the
// sender, which sends it home the same way. At home the reply closes the sender's work and wakes it
// (replyToSender), exactly as the reply of a node Bot does.
//
// Reliability: a frame stays in the outbox (state.assignOutbox, on disk) until the other machine acks
// it; it is resent every RETRY_MS while that machine is reachable and at once when it comes back. A
// machine that is not connected (the hub bounces the frame, or the hub link is down) only marks the
// entry away: no clock runs while away. Each machine remembers the frames it applied
// (state.assignSeen), so a resend is acked again and never applied twice.
import { randomUUID } from 'node:crypto'
import { joinedShadow, shadowId } from './roster-join.js'
import { replyToSender } from './joined-turn.js'

export const RETRY_MS = 30_000
export const OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const HUB = 'hub'
const ROLES = new Set(['request', 'reply', 'stopped'])
const TEXT_MAX = 65_536
const IDENTITY_ID = /^[0-9a-f]{16}$/

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
  if (!ref || typeof ref !== 'object') return undefined
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

const outbox = rt => (rt.state.assignOutbox ??= {})
const seen = rt => (rt.state.assignSeen ??= {})
// Requests this machine took in over bot/assign (exchangeId → when): only their answers go back over it.
const inbound = rt => (rt.state.assignInbound ??= {})

/** Is `exchangeId` a request a Bot on another machine sent here over bot/assign? */
export const owesAnswer = (rt, exchangeId) => typeof exchangeId === 'string' && Object.hasOwn(rt.state.assignInbound ?? {}, exchangeId)

function transmit(rt, entry, now = Date.now()) {
  entry.tries = (entry.tries ?? 0) + 1
  entry.lastTry = now
  let sent = false
  try { sent = networkOf(rt)?.sendAssign?.(entry.frame) === true } catch (error) {
    rt.warn?.('ds-bot: bot/assign %s not sent: %s', entry.frame.frameId, error?.message ?? error)
    sent = false
  }
  // Not handed to a link (hub link down, or the target node is not connected): away until it is back.
  entry.away = !sent
  return sent
}

/**
 * Send one Bot-to-Bot message to a Bot on another machine. Kept until acked.
 * Returns `{ ok: true, away }` (away: the other machine is not reachable now; it goes when it is back),
 * or `{ ok: false, error }` when it cannot be addressed at all.
 */
export async function sendAssign(rt, { fromId, toId, role, text, exchangeId = randomUUID(), replyTo }) {
  const from = rt.botOf?.(fromId)
  const to = rt.botOf?.(toId)
  if (from === undefined || to === undefined || !isRemoteBot(to) || isRemoteBot(from)) return { ok: false, error: 'E_PEER_UNKNOWN' }
  const fromRef = refOf(rt, from)
  const toRef = refOf(rt, to)
  if (fromRef === undefined || toRef === undefined) return { ok: false, error: 'E_PEER_UNKNOWN' }
  const frame = {
    op: 'deliver', frameId: randomUUID(), from: fromRef, to: toRef,
    role: ROLES.has(role) ? role : 'request', exchangeId, text: String(text ?? '').slice(0, TEXT_MAX), at: Date.now(),
    ...(typeof replyTo === 'string' && replyTo !== '' ? { replyTo } : {}),
  }
  const entry = { frame, at: Date.now(), tries: 0, away: false }
  outbox(rt)[frame.frameId] = entry
  await rt.save?.({ immediate: true })
  transmit(rt, entry)
  return { ok: true, exchangeId, frameId: frame.frameId, away: entry.away }
}

function ack(rt, frame) {
  try {
    networkOf(rt)?.sendAssign?.({ op: 'ack', frameId: frame.frameId, from: frame.to, to: frame.from, at: Date.now() })
  } catch (error) {
    rt.warn?.('ds-bot: bot/assign ack %s not sent: %s', frame.frameId, error?.message ?? error)
  }
}

/** One bot/assign frame addressed to this machine. */
export async function receiveAssign(rt, frame) {
  await rt.load?.()
  if (frame?.op === 'ack') {
    if (Object.hasOwn(outbox(rt), frame.frameId)) { delete outbox(rt)[frame.frameId]; await rt.save?.() }
    return 'acked'
  }
  if (frame?.op === 'bounce') {
    const entry = outbox(rt)[frame.frameId]
    if (entry !== undefined) { entry.away = true; entry.bouncedAt = Date.now(); await rt.save?.() }
    return 'away'
  }
  if (frame?.op !== 'deliver') return 'ignored'
  if (Object.hasOwn(seen(rt), frame.frameId)) { ack(rt, frame); return 'duplicate' }
  const to = botOfRef(rt, frame.to)
  const from = botOfRef(rt, frame.from)
  // Not acked: the sender keeps it and sends again (the directory that names the sender may not be here yet).
  if (to === undefined || isRemoteBot(to)) { rt.warn?.('ds-bot: bot/assign for %s: no such Bot here', frame.to?.id); return 'unknown-target' }
  if (from === undefined || !isRemoteBot(from)) { rt.warn?.('ds-bot: bot/assign from %s on %s: no stand-in here yet', frame.from?.id, frame.from?.nodeId); return 'unknown-sender' }
  if (frame.role === 'request') {
    inbound(rt)[frame.exchangeId] = Date.now()
    rt.openWork?.(frame.exchangeId, { from: from.id, to: to.id })
    await rt.deliver({ fromId: from.id, toId: to.id, text: frame.text, role: 'request', exchangeId: frame.exchangeId })
  } else {
    // The answer to a request this machine's Bot sent: close its work and bring the answer to it.
    await replyToSender(rt, { fromId: to.id, toId: from.id, exchangeId: frame.replyTo ?? frame.exchangeId, text: frame.text, answered: frame.role === 'reply' })
  }
  seen(rt)[frame.frameId] = Date.now()
  await rt.save?.()
  ack(rt, frame)
  return 'applied'
}

/** Resend what is due; give up on what waited past OUTBOX_TTL_MS. `force`: resend the away entries now. */
export async function flushOutbox(rt, { now = Date.now(), force = false } = {}) {
  const entries = Object.values(outbox(rt))
  let changed = false
  for (const entry of entries) {
    if (now - entry.at > OUTBOX_TTL_MS) {
      delete outbox(rt)[entry.frame.frameId]
      changed = true
      if (entry.frame.role === 'request') {
        const local = botOfRef(rt, entry.frame.from)
        const remote = botOfRef(rt, entry.frame.to)
        if (local !== undefined && remote !== undefined) {
          await replyToSender(rt, { fromId: local.id, toId: remote.id, exchangeId: entry.frame.exchangeId, text: `[${entry.frame.to.name} could not be reached for 30 days; the message was not delivered.]`, answered: false }).catch(() => {})
        }
      }
      continue
    }
    // `force` (the other machine may be back) only hurries what was away; the rest keeps its pace.
    if (!(force && entry.away === true) && now - (entry.lastTry ?? 0) < RETRY_MS) continue
    transmit(rt, entry, now)
    changed = true
  }
  for (const [id, at] of Object.entries(seen(rt))) if (now - at > SEEN_TTL_MS) { delete seen(rt)[id]; changed = true }
  for (const [id, at] of Object.entries(inbound(rt))) if (now - at > OUTBOX_TTL_MS) { delete inbound(rt)[id]; changed = true }
  if (changed) await rt.save?.().catch(() => {})
}

export function install(rt) {
  const { ctx } = rt
  let stopped = false
  let attached
  let offAssign
  let offOnline
  const receive = frame => {
    if (stopped) return
    void receiveAssign(rt, frame).catch(error => rt.warn?.('ds-bot: bot/assign not applied: %s', error?.message ?? error))
  }
  const flush = force => { if (!stopped) void flushOutbox(rt, { force }).catch(error => rt.warn?.('ds-bot: bot/assign outbox: %s', error?.message ?? error)) }
  // AC may load after ds-bot: attach whenever its bot-network shows up (or changes).
  const attach = () => {
    const network = networkOf(rt)
    if (network === attached) return
    offAssign?.()
    offOnline?.()
    attached = network
    offAssign = typeof network?.onAssign === 'function' ? network.onAssign(receive) : undefined
    // A machine coming back: send what waited for it at once.
    const registry = serviceOf(rt, 'remote-agent:registry')
    const onOnline = () => flush(true)
    if (typeof registry?.on === 'function') { registry.on('nodeOnline', onOnline); offOnline = () => registry.off?.('nodeOnline', onOnline) }
    else if (typeof network?.on === 'function') { network.on('directory', onOnline); offOnline = () => network.off?.('directory', onOnline) }
    else offOnline = undefined
  }
  attach()
  const timer = setInterval(() => { attach(); flush(false) }, RETRY_MS)
  timer.unref?.()
  rt.assign = {
    send: args => sendAssign(rt, args),
    owes: exchangeId => owesAnswer(rt, exchangeId),
    receive: frame => receiveAssign(rt, frame),
    flush: options => flushOutbox(rt, options),
    pending: () => Object.values(outbox(rt)).map(entry => ({ frameId: entry.frame.frameId, to: entry.frame.to.name, role: entry.frame.role, away: entry.away === true, at: entry.at })),
  }
  ctx?.effect?.(() => () => {
    stopped = true
    clearInterval(timer)
    offAssign?.()
    offOnline?.()
    rt.assign = undefined
  }, 'ds-bot: Bot assign')
}
