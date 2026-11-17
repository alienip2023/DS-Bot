import { randomUUID } from 'node:crypto'
import { classify } from './msg-classes.js'
// The hub publishes destinations; nodes keep the directory in remote-agent memory.
const DIRECTORY_DELAY_MS = 1_000
const REFRESH_MS = 60_000
const asks = new WeakMap()
export const HUB_NODE = 'hub'
const HUB_ID = 'hub'
// Only the directory listener installed below holds this; a caller without it is not the hub.
const HUB_FRAME = Symbol('hub bot/directory')
const STALE_MS = 3 * REFRESH_MS
const peerAt = new WeakMap()

export const peerRowId = (hubId, nodeId, id) => `peer:${encodeURIComponent(hubId)}:${encodeURIComponent(nodeId)}:${encodeURIComponent(id)}`
const isSessionPeer = bot => bot?.origin === 'peer' && typeof bot.homeNodeId === 'string' && typeof bot.hubId === 'string'

// Turns the hub's directory into read-only, memory-only peer rows and reaps the rest.
// Returns the rows now present, or null when the frame was not the hub's.
export function applyDirectory(rt, bots, source) {
  if (source !== HUB_FRAME) return null
  const own = serviceOf(rt, 'remote-agent:bot-network')?.nodeId
  const next = {}
  for (const entry of Array.isArray(bots) ? bots : []) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.nodeId !== 'string' || entry.nodeId === '') continue
    if (entry.nodeId === own) continue
    const id = peerRowId(HUB_ID, entry.nodeId, entry.id)
    next[id] = {
      id, name: String(entry.name || entry.id).slice(0, 40), role: String(entry.role ?? '').slice(0, 24),
      type: 'remote-worker', origin: 'peer', readonly: true, homeNodeId: entry.nodeId, hubId: HUB_ID,
      remoteBotId: entry.id, capabilities: [], createdAt: rt.state.bots[id]?.createdAt ?? Date.now(),
      worker: { home: 'hub', hubId: HUB_ID, botId: entry.id, nodeId: entry.nodeId, online: true },
    }
  }
  for (const [id, bot] of Object.entries(rt.state.bots)) if (isSessionPeer(bot)) delete rt.state.bots[id]
  Object.assign(rt.state.bots, next)
  peerAt.set(rt, Date.now())
  return Object.values(next)
}

export function reapStalePeers(rt, now = Date.now()) {
  const at = peerAt.get(rt)
  if (at !== undefined && now - at < STALE_MS) return false
  let removed = false
  for (const [id, bot] of Object.entries(rt.state.bots)) if (isSessionPeer(bot)) { delete rt.state.bots[id]; removed = true }
  return removed
}

// A node bot's message to a peer row: one bot/message frame to the hub, never queued, never retried.
export function sendToPeer(rt, { fromId, toId, text, exchangeId = randomUUID(), depth = 0, kind = 'ask' }) {
  const peer = rt.state.bots[toId]
  const sender = rt.botOf?.(fromId) ?? rt.state.bots[fromId]
  const network = rt.botNetwork
  if (!isSessionPeer(peer) || !sender) return { ok: false, error: 'E_PEER_UNKNOWN' }
  if (typeof network?.send !== 'function' || typeof network.nodeId !== 'string') return { ok: false, error: 'E_HUB_OFFLINE' }
  let sent = false
  try {
    sent = network.send({
      from: { id: sender.id, name: sender.name || sender.id, nodeId: network.nodeId },
      to: { id: peer.remoteBotId, name: peer.name, nodeId: peer.homeNodeId },
      exchangeId, kind, text, depth,
    }) === true
  } catch { sent = false }
  return sent ? { ok: true, exchangeId, to: peer.name } : { ok: false, error: 'E_HUB_OFFLINE' }
}

function serviceOf(rt, name) {
  try { return rt.ctx?.get?.(name) } catch { return undefined }
}

export function directoryOf(rt) {
  return Object.values(rt.state.bots ?? {}).filter(bot => bot && bot.origin !== 'peer' && bot.private !== true).map(bot => ({
    id: bot.id,
    name: bot.name || bot.id,
    role: bot.role ?? '',
    nodeId: bot.origin === 'joined' ? bot.worker?.nodeId ?? HUB_NODE : HUB_NODE,
  }))
}

export async function publishDirectory(rt) {
  const registry = serviceOf(rt, 'remote-agent:registry')
  if (typeof registry?.send !== 'function' || typeof registry.onlineNodes !== 'function') return
  await rt.load?.()
  const payload = { bots: directoryOf(rt), at: Date.now() }
  for (const { nodeId } of registry.onlineNodes()) {
    try { registry.send(nodeId, 'bot/directory', payload) } catch (error) {
      rt.warn?.('ds-bot: Bot directory send to %s failed: %s', nodeId, error)
    }
  }
}

function pruneAsks(rt) {
  const seen = asks.get(rt)
  if (!seen) return
  const now = Date.now()
  for (const [id, at] of seen) if (now - at >= REFRESH_MS) seen.delete(id)
}

export async function handleNodeMessage(rt, payload) {
  if (!payload || !['ask', 'reply'].includes(payload.kind) || payload.depth >= 3) return
  await rt.load?.()
  const to = Object.hasOwn(rt.state.bots, payload.to?.id) ? rt.state.bots[payload.to.id] : undefined
  if (!to || to.origin === 'peer' || to.private === true) {
    rt.warn?.('ds-bot: Bot network destination unavailable: %s', payload.to?.id)
    return
  }
  if (payload.kind === 'ask') {
    pruneAsks(rt)
    let seen = asks.get(rt)
    if (!seen) { seen = new Map(); asks.set(rt, seen) }
    if (seen.has(payload.exchangeId)) return
    seen.set(payload.exchangeId, Date.now())
  }
  const message = {
    fromId: payload.from.id, toId: to.id, text: payload.text,
    role: 'default', exchangeId: payload.exchangeId,
  }
  if (to.origin === 'joined') return rt.handleJoinedTurn({
    ...message, senderName: payload.from.name, senderBotId: payload.from.id, defer: classify(message.role) === 'control',
  })
  return rt.deliver({ ...message, fromName: payload.from.name })
}

export function install(rt) {
  const { ctx } = rt
  let stopped = false
  let attached
  let dirtyTimer
  let lastDirectory = JSON.stringify(directoryOf(rt))
  const publish = () => {
    if (stopped) return
    void publishDirectory(rt).catch(error => rt.warn?.('ds-bot: Bot directory publish failed: %s', error))
  }
  const dirty = () => {
    if (stopped || dirtyTimer !== undefined) return
    dirtyTimer = setTimeout(() => { dirtyTimer = undefined; publish() }, DIRECTORY_DELAY_MS)
    dirtyTimer.unref?.()
  }
  const detach = () => {
    attached?.off?.('nodeOnline', publish)
    attached?.off?.('roster', dirty)
  }
  const attach = () => {
    const registry = serviceOf(rt, 'remote-agent:registry')
    if (registry === attached) return
    detach()
    attached = registry
    attached?.on?.('nodeOnline', publish)
    attached?.on?.('roster', dirty)
  }
  const offSaved = rt.onSaved?.(() => {
    const next = JSON.stringify(directoryOf(rt))
    if (next === lastDirectory) return
    lastDirectory = next
    dirty()
  })
  const receive = payload => stopped ? undefined : handleNodeMessage(rt, payload)
  const previous = serviceOf(rt, 'remote-agent:bot-message')
  let offReceiver
  if (previous === undefined) offReceiver = ctx?.provide?.('remote-agent:bot-message', receive)
  else if (typeof ctx?.set === 'function') ctx.set('remote-agent:bot-message', receive)

  rt.botNetwork = serviceOf(rt, 'remote-agent:bot-network')
  const offMessage = typeof rt.botNetwork?.onMessage === 'function'
    ? rt.botNetwork.onMessage(async payload => {
    if (stopped || payload.kind !== 'ask') return null
    await rt.load?.()
    const bot = Object.hasOwn(rt.state.bots, payload.to?.id) ? rt.state.bots[payload.to.id] : undefined
    if (!bot || bot.origin === 'joined' || bot.origin === 'peer' || bot.private === true) {
      rt.warn?.('ds-bot: Bot network local destination unavailable: %s', payload.to?.id)
      return null
    }
    await rt.sendUser({
      sessionId: rt.chatOf(bot.id),
      content: [{ type: 'text', text: `[Message from ${payload.from.name}]\n${payload.text}` }],
      requestId: payload.exchangeId,
    })
    return null
  })
    : undefined
  const offDirectory = typeof rt.botNetwork?.on === 'function' ? (() => {
    const onDirectory = bots => { if (!stopped) applyDirectory(rt, bots, HUB_FRAME) }
    rt.botNetwork.on('directory', onDirectory)
    return () => rt.botNetwork?.off?.('directory', onDirectory)
  })() : undefined
  attach()
  publish()
  const timer = setInterval(() => { attach(); pruneAsks(rt); reapStalePeers(rt); publish() }, REFRESH_MS)
  timer.unref?.()
  ctx?.effect?.(() => () => {
    stopped = true
    clearTimeout(dirtyTimer)
    clearInterval(timer)
    detach()
    offSaved?.()
    offMessage?.()
    offDirectory?.()
    reapStalePeers(rt, Infinity)
    offReceiver?.()
    if (previous !== undefined && typeof ctx.set === 'function' && serviceOf(rt, 'remote-agent:bot-message') === receive) ctx.set('remote-agent:bot-message', previous)
    asks.delete(rt)
    rt.botNetwork = undefined
  }, 'ds-bot: Bot network')
}
