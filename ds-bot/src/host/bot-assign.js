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
import { threadCurrentOfPart } from './threads.js'
import { ensureMirrorSession, mirrorRelayEvent } from './mirror.js'
import { deferMirrorWrite } from './joined-mirror-writer.js'

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
// Requests this machine took in over bot/assign (exchangeId → { at, pair, q }): only their answers go back
// over it, and each answered one is remembered as a round of that pair's conversation.
const inbound = rt => (rt.state.assignInbound ??= {})
// The last rounds of each cross-machine conversation, kept on the side that answers (pair key →
// [{ q, a, at }]): each request runs in a fresh background task, which reads them first.
const rounds = rt => (rt.state.assignRounds ??= {})
export const ROUNDS_KEPT = 3
const ROUND_TEXT = 1500
const pairKey = (remoteId, localId) => `${remoteId}\u0000${localId}`
const clip = text => { const t = String(text ?? '').trim(); return t.length > ROUND_TEXT ? `${t.slice(0, ROUND_TEXT)}…` : t }

/** What a fresh task needs to carry the conversation on: the last rounds with this Bot. */
export function earlierRounds(rt, remote, local) {
  const kept = rounds(rt)[pairKey(remote.id, local.id)] ?? []
  if (kept.length === 0) return ''
  const where = remote.worker?.hostname || remote.homeNodeId || remote.worker?.nodeId
  return [
    `[Earlier in your conversation with ${remote.name}${where ? ` (on ${where})` : ''}, oldest first:`,
    ...kept.flatMap(round => [`- ${remote.name}: ${round.q}`, `- You: ${round.a}`]),
    ']',
  ].join('\n')
}

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
  // An answer goes back to where its request came from, even when this machine's stand-in row for the asker is
  // not there right now (rows from the team directory are memory-only and come back with the next directory).
  const request = role === 'reply' && typeof replyTo === 'string' ? inbound(rt)[replyTo] : undefined
  const knownAsker = to === undefined && request !== null && typeof request === 'object' ? request.remote : undefined
  if (from === undefined || isRemoteBot(from) || (knownAsker === undefined && (to === undefined || !isRemoteBot(to)))) return { ok: false, error: 'E_PEER_UNKNOWN' }
  const fromRef = refOf(rt, from)
  const toRef = knownAsker ?? refOf(rt, to)
  if (fromRef === undefined || toRef === undefined) return { ok: false, error: 'E_PEER_UNKNOWN' }
  const frame = {
    op: 'deliver', frameId: randomUUID(), from: fromRef, to: toRef,
    role: ROLES.has(role) ? role : 'request', exchangeId, text: String(text ?? '').slice(0, TEXT_MAX), at: Date.now(),
    ...(typeof replyTo === 'string' && replyTo !== '' ? { replyTo } : {}),
  }
  const entry = { frame, at: Date.now(), tries: 0, away: false }
  outbox(rt)[frame.frameId] = entry
  // An answer to a request that came in over bot/assign closes one round of that conversation.
  const asked = frame.role === 'reply' ? inbound(rt)[frame.replyTo] : undefined
  if (asked !== undefined && typeof asked === 'object' && typeof asked.pair === 'string') {
    const list = [...(rounds(rt)[asked.pair] ?? []), { q: asked.q, a: clip(frame.text), at: Date.now() }]
    rounds(rt)[asked.pair] = list.slice(-ROUNDS_KEPT)
    delete inbound(rt)[frame.replyTo]
  }
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
    const entry = outbox(rt)[frame.frameId]
    if (entry === undefined) return 'acked'
    delete outbox(rt)[frame.frameId]
    await rt.save?.()
    const local = botOfRef(rt, entry.frame.from)
    const remote = botOfRef(rt, entry.frame.to)
    if (local !== undefined && remote !== undefined) await rt.markPairDelivered?.(local.id, remote.id, entry.frame.exchangeId)
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
    inbound(rt)[frame.exchangeId] = { at: Date.now(), pair: pairKey(from.id, to.id), q: clip(frame.text), remote: frame.from }
    const earlier = earlierRounds(rt, from, to)
    const text = earlier === '' ? frame.text : `${earlier}\n\n${frame.text}`
    // Not in the Bot's own chat (the user's window): a background task of its own, forked from that
    // chat so it knows what the Bot knows, opens the work and answers it (rewrite R3).
    if (typeof rt.spawnBotHandoffTask === 'function') {
      await rt.spawnBotHandoffTask(to, rt.chatOf(to.id), { fromBot: from, text, exchangeId: frame.exchangeId })
    } else {
      rt.openWork?.(frame.exchangeId, { from: from.id, to: to.id })
      await rt.deliver({ fromId: from.id, toId: to.id, text, role: 'request', exchangeId: frame.exchangeId })
    }
  } else {
    await answerHere(rt, { asker: to, remote: from, exchangeId: frame.replyTo ?? frame.exchangeId, text: frame.text })
  }
  seen(rt)[frame.frameId] = Date.now()
  await rt.save?.()
  ack(rt, frame)
  return 'applied'
}

// The answer to a request a Bot of this machine sent, brought to it the way a local teammate's answer is
// (turns.js answerSender): to the part of its chat it asked from (a background task, say), going on with the
// work it asked for. Without that, a Bot that asked from a task got the answer in its own chat, cut off from
// the work, and a chain like Chief → node011 → node010 stopped after one way.
async function answerHere(rt, { asker, remote, exchangeId, text }) {
  const pending = rt.state.works?.[exchangeId]
  const part = typeof pending?.fromPart === 'string' ? pending.fromPart : undefined
  const sessionId = part === undefined ? undefined : (threadCurrentOfPart(asker, part) ?? undefined)
  const work = rt.closeWork?.(exchangeId, remote.name, text)
  await rt.deliver({
    fromId: remote.id, toId: asker.id, text, role: 'reply', replyTo: exchangeId,
    ...(sessionId ? { sessionId } : {}), ...(part ? { fromPart: part } : {}), ...(work ? { work } : {}),
  })
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
  for (const [id, entry] of Object.entries(inbound(rt))) {
    const at = typeof entry === 'object' && entry !== null ? entry.at : entry
    if (!(now - at <= OUTBOX_TTL_MS)) { delete inbound(rt)[id]; changed = true }
  }
  if (changed) await rt.save?.().catch(() => {})
}

// On the hub: frames it carries between two nodes go into those two Bots' pair book here, and an ack marks
// the message delivered — the hub, where the user works, shows what node Bots say to each other.
const relayedFrames = new WeakMap()
export async function noteRelayed(rt, { frame, outcome }) {
  if (ownNodeId(rt) !== HUB || frame?.from?.nodeId === HUB || frame?.to?.nodeId === HUB) return
  let seenFrames = relayedFrames.get(rt)
  if (seenFrames === undefined) { seenFrames = new Map(); relayedFrames.set(rt, seenFrames) }
  if (frame.op === 'deliver' && (outcome === 'forwarded' || outcome === 'target-offline')) {
    const from = botOfRef(rt, frame.from)
    const to = botOfRef(rt, frame.to)
    if (from === undefined || to === undefined) return
    seenFrames.set(frame.frameId, { from: from.id, to: to.id, id: frame.exchangeId })
    if (seenFrames.size > 2000) seenFrames.delete(seenFrames.keys().next().value)
    await rt.recordPairMessage?.({ from: from.id, to: to.id, id: frame.exchangeId, role: frame.role, text: frame.text, replyTo: frame.replyTo })
    // The recipient's page here gets a line for it: one line per message, as many as there are.
    if (outcome === 'forwarded' && joinedShadow(to)) {
      try {
        const session = await ensureMirrorSession(rt, to)
        deferMirrorWrite(rt, to.id, () => {
          try { mirrorRelayEvent(session, { role: frame.role === 'request' ? 'request' : 'reply', fromId: from.id, fromName: from.name, exchangeId: frame.exchangeId, text: frame.text }) } catch (error) {
            rt.warn?.('ds-bot: the line for a message to %s was not written: %s', to.name, error?.message ?? error)
          }
        })
      } catch (error) {
        rt.warn?.('ds-bot: the page of %s is not available for a relayed message: %s', to.name, error?.message ?? error)
      }
    }
  } else if (frame.op === 'ack') {
    const sent = seenFrames.get(frame.frameId)
    if (sent === undefined) return
    seenFrames.delete(frame.frameId)
    await rt.markPairDelivered?.(sent.from, sent.to, sent.id)
  }
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
    const onRelayed = event => { if (!stopped) void noteRelayed(rt, event).catch(error => rt.warn?.('ds-bot: relayed bot/assign not recorded: %s', error?.message ?? error)) }
    if (typeof registry?.on === 'function') {
      registry.on('nodeOnline', onOnline)
      registry.on('botAssignRelayed', onRelayed)
      offOnline = () => { registry.off?.('nodeOnline', onOnline); registry.off?.('botAssignRelayed', onRelayed) }
    }
    else if (typeof network?.on === 'function') { network.on('directory', onOnline); offOnline = () => network.off?.('directory', onOnline) }
    else offOnline = undefined
  }
  attach()
  const timer = setInterval(() => { attach(); flush(false) }, RETRY_MS)
  timer.unref?.()
  rt.assign = {
    send: args => sendAssign(rt, args),
    owes: exchangeId => owesAnswer(rt, exchangeId),
    // The asker of a request that came in over bot/assign, by address (its stand-in may be gone).
    askerOf: exchangeId => { const entry = rt.state.assignInbound?.[exchangeId]; return entry !== null && typeof entry === 'object' ? entry.remote : undefined },
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
