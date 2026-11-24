import { hostname as osHostname } from 'node:os'
import { joinedShadow } from './roster-join.js'
import { ensureMirrorSession, mirrorStateOf } from './mirror.js'
import { writeNodeReport, repliedAlready } from './executor.js'
// The hub publishes destinations; nodes keep the directory in remote-agent memory.
const DIRECTORY_DELAY_MS = 1_000
const REFRESH_MS = 60_000
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
export function applyDirectory(rt, payload, source) {
  if (source !== HUB_FRAME) return null
  const bots = Array.isArray(payload) ? payload : payload?.bots
  const rooms = Array.isArray(payload) ? [] : payload?.rooms
  rt.hubRooms = (Array.isArray(rooms) ? rooms : [])
    .filter(room => room && typeof room.id === 'string' && room.id.trim() !== '' && typeof room.name === 'string' && Number.isInteger(room.members) && room.members >= 0)
    .slice(0, 100)
    .map(room => {
      const entry = {
        id: room.id,
        name: room.name.trim().slice(0, 40),
        members: room.members,
      }
      // memberList carries {id, name} pairs so @Name routing works on node bots.
      // Only stored when non-empty so deep-equality checks against bare {id,name,members} still pass.
      if (Array.isArray(room.memberList)) {
        const list = room.memberList.filter(e => e && typeof e.id === 'string' && typeof e.name === 'string').slice(0, 64)
        if (list.length > 0) entry.memberList = list
      }
      return entry
    })
  const own = serviceOf(rt, 'remote-agent:bot-network')?.nodeId
  const next = {}
  for (const entry of Array.isArray(bots) ? bots : []) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.nodeId !== 'string' || entry.nodeId === '') continue
    if (entry.nodeId === own) continue
    const id = peerRowId(HUB_ID, entry.nodeId, entry.id)
    const online = entry.online !== false
    next[id] = {
      id, name: String(entry.name || entry.id).slice(0, 40), role: String(entry.role ?? '').slice(0, 24),
      type: 'remote-worker', origin: 'peer', readonly: true, homeNodeId: entry.nodeId, hubId: HUB_ID,
      remoteBotId: entry.id, capabilities: [], createdAt: rt.state.bots[id]?.createdAt ?? Date.now(),
      ...(typeof entry.identityId === 'string' ? { identityId: entry.identityId } : {}),
      worker: {
        home: 'hub', hubId: HUB_ID, botId: entry.id, nodeId: entry.nodeId, online,
        ...(typeof entry.hostname === 'string' ? { hostname: entry.hostname } : {}),
        ...(typeof entry.state === 'string' ? { state: entry.state } : {}),
        ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
        ...(typeof entry.identityId === 'string' ? { identityId: entry.identityId } : {}),
      },
    }
  }
  // The team's machines, as the hub sees them (memory only, like the rows).
  if (!Array.isArray(payload) && Array.isArray(payload?.machines)) {
    rt.hubMachines = payload.machines
      .filter(machine => machine && typeof machine.nodeId === 'string' && machine.nodeId !== '')
      .slice(0, 64)
      .map(machine => ({ ...machine, self: machine.nodeId === own }))
  }
  for (const [id, bot] of Object.entries(rt.state.bots)) if (isSessionPeer(bot)) delete rt.state.bots[id]
  Object.assign(rt.state.bots, next)
  peerAt.set(rt, Date.now())
  return Object.values(next)
}

export function reapStalePeers(rt, now = Date.now()) {
  const at = peerAt.get(rt)
  if (at !== undefined && now - at < STALE_MS) return false
  peerAt.delete(rt)
  rt.hubRooms = []
  rt.hubMachines = []
  let removed = false
  for (const [id, bot] of Object.entries(rt.state.bots)) if (isSessionPeer(bot)) { delete rt.state.bots[id]; removed = true }
  return removed
}

function serviceOf(rt, name) {
  try { return rt.ctx?.get?.(name) } catch { return undefined }
}

const IDENTITY_ID = /^[0-9a-f]{16}$/

// One word for what a Bot is doing, from the same status line the team tools show:
// available · working · waiting (for the user) · offline (its machine is not connected).
export function botStateOf(rt, bot) {
  if (bot.origin === 'joined' && bot.worker?.online === false) return 'offline'
  if (rt.joinedInFlight?.has?.(bot.id)) return 'working'
  let line = ''
  try { line = String(rt.statusOf?.(bot.id) ?? '') } catch { line = '' }
  if (/waiting for the user|waited for the user's answer/.test(line)) return 'waiting'
  if (/^(working|moving on|waiting for|about to go on)/.test(line)) return 'working'
  return 'available'
}

// The Bot's portable id: a node Bot reports its own (roster), a hub Bot gets one from AC's
// hub identity book. Undefined while neither is there (an old AC, a Bot never reported).
function identityIdOf(rt, bot) {
  if (bot.origin === 'joined') {
    const reported = bot.identityId ?? bot.worker?.identityId
    return IDENTITY_ID.test(reported ?? '') ? reported : undefined
  }
  if (IDENTITY_ID.test(bot.identityId ?? '')) return bot.identityId
  let id
  try { id = serviceOf(rt, 'remote-agent:bot-identity')?.identityOf?.(bot.id, { name: bot.name ?? '', role: bot.role ?? '' }) } catch { id = undefined }
  return IDENTITY_ID.test(id ?? '') ? id : undefined
}

export function directoryOf(rt) {
  const hosts = new Map((machinesOf(rt) ?? []).map(machine => [machine.nodeId, machine.hostname]))
  return Object.values(rt.state.bots ?? {}).filter(bot => bot && bot.origin !== 'peer' && bot.private !== true).map(bot => {
    const nodeId = bot.origin === 'joined' ? bot.worker?.nodeId ?? HUB_NODE : HUB_NODE
    const entry = { id: bot.id, name: bot.name || bot.id, role: bot.role ?? '', nodeId }
    const identityId = identityIdOf(rt, bot)
    if (identityId !== undefined) entry.identityId = identityId
    const host = bot.origin === 'joined' ? (bot.worker?.hostname || hosts.get(nodeId)) : hosts.get(HUB_NODE)
    if (typeof host === 'string' && host !== '') entry.hostname = host
    entry.online = !(bot.origin === 'joined' && bot.worker?.online === false)
    entry.state = botStateOf(rt, bot)
    const model = bot.appliedModel ?? bot.model ?? bot.worker?.model
    if (typeof model === 'string' && model !== '') entry.model = model
    return entry
  })
}

// Every machine in the team: this hub first, then each node the registry knows (online or not).
// Null when this is not a hub (no registry).
export function machinesOf(rt) {
  const registry = serviceOf(rt, 'remote-agent:registry')
  if (typeof registry?.list !== 'function') return null
  let nodes = []
  try { nodes = registry.list() } catch { nodes = [] }
  const hub = { nodeId: HUB_NODE, hostname: osHostname(), os: process.platform, online: true, role: 'hub' }
  return [hub, ...nodes.filter(node => node && typeof node.nodeId === 'string' && node.nodeId !== HUB_NODE).map(node => ({
    nodeId: node.nodeId,
    hostname: node.hostname || node.nodeId,
    os: node.os,
    online: node.online === true,
    role: 'worker',
    ...(typeof node.acVersion === 'string' ? { acVersion: node.acVersion } : {}),
    ...(Number.isFinite(node.lastSeen) ? { lastSeen: node.lastSeen } : {}),
  }))]
}

export function roomsOf(rt) {
  // Hub view: bare {id, name, members} — members is the count of the room's
  // member array. No bot filtering here so a room with member ids that aren't
  // Bots (or a test with no bots defined) still reports the right count.
  return Object.values(rt.state.rooms ?? {})
    .filter(room => room.private !== true)
    .slice(0, 100)
    .map(room => ({ id: room.id, name: room.name, members: (room.members ?? []).length }))
}

function roomListsOf(rt, bots = directoryOf(rt)) {
  const nodeOf = new Map(bots.map(bot => [bot.id, bot.nodeId]))
  const lists = new Map([[HUB_NODE, []]])
  for (const room of Object.values(rt.state.rooms ?? {})) {
    if (room.private === true) continue
    const members = room.members ?? []
    // Send member ids + names per node so @Name routing works across nodes.
    // A member is visible to a node if it has a bot on that node or on the hub.
    const memberEntries = members
      .map(id => {
        const bot = rt.state.bots?.[id]
        if (!bot || bot.private === true) return null
        return { id: bot.id, name: bot.name || bot.id, nodeId: nodeOf.get(id) ?? HUB_NODE }
      })
      .filter(Boolean)
    const nodes = new Set([HUB_NODE])
    for (const { nodeId } of memberEntries) if (nodeId !== undefined) nodes.add(nodeId)
    for (const nodeId of nodes) {
      if (!lists.has(nodeId)) lists.set(nodeId, [])
      const rooms = lists.get(nodeId)
      // Published payload is bare {id, name, members}; member names are available
      // via the peer roster, so @Name routing uses roster lookup, not this frame.
      if (rooms.length < 100) rooms.push({ id: room.id, name: room.name, members: memberEntries.length })
    }
  }
  return lists
}

export async function publishDirectory(rt) {
  const registry = serviceOf(rt, 'remote-agent:registry')
  if (typeof registry?.send !== 'function' || typeof registry.onlineNodes !== 'function') return
  await rt.load?.()
  const payload = { bots: directoryOf(rt), machines: machinesOf(rt) ?? [], at: Date.now() }
  const rooms = roomListsOf(rt, payload.bots)
  for (const { nodeId } of registry.onlineNodes()) {
    try { registry.send(nodeId, 'bot/directory', { ...payload, rooms: rooms.get(nodeId) ?? [] }) } catch (error) {
      rt.warn?.('ds-bot: Bot directory send to %s failed: %s', nodeId, error)
    }
  }
}


// A node Bot reporting a result to the hub (its background task finished): the message names the
// Bot as both sender and recipient, on the hub's side of the link, at the depth cap. An older hub
// drops it at the depth check, so it never reaches a Bot as a turn.
const isNodeReport = payload => payload?.kind === 'reply' && payload.depth >= 3
  && payload.to?.nodeId === HUB_NODE && payload.to.id === payload.from?.id && typeof payload.text === 'string' && payload.text.trim() !== ''
const reports = new WeakMap()

export async function handleNodeReport(rt, payload) {
  await rt.load?.()
  const bot = Object.values(rt.state.bots ?? {}).find(item => joinedShadow(item)
    && item.worker?.nodeId === payload.from.nodeId && item.worker?.remoteBotId === payload.from.id)
  if (!bot) { rt.warn?.('ds-bot: a node report for an unknown Bot %s was dropped', payload.from.id); return }
  let seen = reports.get(rt)
  if (!seen) { seen = new Set(); reports.set(rt, seen) }
  if (seen.has(payload.exchangeId)) return
  seen.add(payload.exchangeId)
  if (repliedAlready(rt, bot.id, payload.text)) return   // the answer a turn just delivered: already on the page
  if (seen.size > 512) seen.delete(seen.values().next().value)
  const session = await ensureMirrorSession(rt, bot)
  const continuation = typeof payload.exchangeId === 'string' && payload.exchangeId.startsWith('cont:')
  writeNodeReport({ rt, bot, session, state: mirrorStateOf(rt, bot.id, session), text: payload.text, ...(continuation ? { mark: '' } : {}) })
}

// Node reports (a node Bot's background work, for the hub page that asked) still come as depth-3 replies; Bot-to-Bot
// messages no longer come this way (bot/message is gone: work across machines is bot-link.js, work model W3).
export async function handleNodeMessage(rt, payload) {
  if (isNodeReport(payload)) return handleNodeReport(rt, payload)
}

export function install(rt) {
  const { ctx } = rt
  let stopped = false
  let attached
  let dirtyTimer
  const snapshot = () => JSON.stringify({ bots: directoryOf(rt), rooms: [...roomListsOf(rt)] })
  let lastDirectory = snapshot()
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
    const next = snapshot()
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
  // remote-agent exposes no link state: allow the first directory a stale window,
  // then use directory receipt (including empty frames) as the liveness lease.
  if (typeof rt.botNetwork?.send === 'function') peerAt.set(rt, Date.now())
  rt.hubOnline = () => !stopped && typeof rt.botNetwork?.send === 'function'
    && peerAt.has(rt) && Date.now() - peerAt.get(rt) < STALE_MS
  const offDirectory = typeof rt.botNetwork?.on === 'function' ? (() => {
    const onDirectory = payload => { if (!stopped) applyDirectory(rt, payload, HUB_FRAME) }
    rt.botNetwork.on('directory', onDirectory)
    return () => rt.botNetwork?.off?.('directory', onDirectory)
  })() : undefined
  attach()
  publish()
  const timer = setInterval(() => { attach(); reapStalePeers(rt); publish() }, REFRESH_MS)
  timer.unref?.()
  ctx?.effect?.(() => () => {
    stopped = true
    clearTimeout(dirtyTimer)
    clearInterval(timer)
    detach()
    offSaved?.()
    offDirectory?.()
    reapStalePeers(rt, Infinity)
    offReceiver?.()
    if (previous !== undefined && typeof ctx.set === 'function' && serviceOf(rt, 'remote-agent:bot-message') === receive) ctx.set('remote-agent:bot-message', previous)
    rt.botNetwork = undefined
    rt.hubOnline = undefined
  }, 'ds-bot: Bot network')
}
