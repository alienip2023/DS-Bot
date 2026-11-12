// Peer roster: a read-only shadow list of another machine's Bots.
//
// One DS Bot is the hub, the other machines run dsh-remote-agent. A node's
// remote-agent reads its local team and reports it upward as `node/roster`; the
// registry forwards that as the `roster` event, and this module mirrors those Bots
// here as read-only rows (`origin: 'peer'`). Nothing about a peer row may look like
// a local Bot: no Main Thread, no Session, no model selection, no execution.
//
// Likewise, the hub pushes its own roster down the other way as `peer/roster`, so a
// node can show the hub's Bots read-only (see lib/protocol.js on the node side).
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'

export const PEER_LEVELS = Object.freeze(['off', 'roster', 'dispatch', 'groups'])
const LEVEL_RANK = new Map(PEER_LEVELS.map((level, index) => [level, index]))
const HUB_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const PEER_PREFIX = 'peer:'
// A report is sent every ~5s. A row missing from twelve reports in a row (~60s) is
// gone; a single lost frame must not make a live Bot flicker out of the list.
export const MISSING_FRAMES = 12
export const SEEN_TTL = 24 * 60 * 60 * 1000
const PEER_CAP = 'peer/v1'
const DEBOUNCE_MS = 1000

const timers = new WeakMap()
const subscribed = new WeakSet()

export function emptyFederation() {
  return {
    version: 1,
    hubId: null,
    peersAt: 0,
    inbox: {},
    outbox: {},
    seen: {},
    seq: 0,
    allowPeerToMain: false,
    lastError: null,
  }
}

export const peerId = (hubId, botId) => `${PEER_PREFIX}${encodeURIComponent(hubId)}:${encodeURIComponent(botId)}`

export const isPeerBot = (bot) => bot !== null && typeof bot === 'object' && bot.origin === 'peer'

// Same limits as the node-side validator: the two ends must agree on what a roster is.
export function sanitizePeerRoster(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'peer-roster-invalid' }
  const hubId = typeof input.hubId === 'string' ? input.hubId.trim() : ''
  if (hubId === '') return { ok: false, error: 'peer-roster-hub-missing' }
  if (hubId.length > 64 || !HUB_ID_PATTERN.test(hubId)) return { ok: false, error: 'peer-roster-hub-invalid' }
  if (!PEER_LEVELS.includes(input.level)) return { ok: false, error: 'peer-roster-level-invalid' }
  const rawBots = input.bots === undefined ? [] : input.bots
  if (!Array.isArray(rawBots)) return { ok: false, error: 'peer-roster-bots-invalid' }
  if (rawBots.length > 64) return { ok: false, error: 'peer-roster-bots-too-many' }
  const bots = []
  const seen = new Set()
  for (const raw of rawBots) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'peer-roster-bot-invalid' }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') return { ok: false, error: 'peer-roster-bot-id-missing' }
    if (id.length > 80) return { ok: false, error: 'peer-roster-bot-id-invalid' }
    if (typeof raw.name !== 'string' || raw.name.trim() === '') return { ok: false, error: 'peer-roster-bot-invalid' }
    if (typeof raw.role !== 'string') return { ok: false, error: 'peer-roster-bot-invalid' }
    // The first row for an id wins: a duplicate cannot silently replace a name.
    if (seen.has(id)) continue
    seen.add(id)
    bots.push({
      id,
      name: raw.name.trim().slice(0, 40),
      role: raw.role.trim().slice(0, 24),
      ...(raw.main === true ? { main: true } : {}),
      ...(typeof raw.model === 'string' && raw.model !== '' ? { model: raw.model.slice(0, 120) } : {}),
    })
  }
  return {
    ok: true,
    value: {
      hubId,
      level: input.level,
      hostname: typeof input.hostname === 'string' ? input.hostname.trim().slice(0, 80) : '',
      bots,
    },
  }
}

// Fill in anything a state file from before federation lacks. Returns whether it wrote.
export function ensureFederationState(state) {
  let changed = false
  if (state.prefs === null || typeof state.prefs !== 'object' || Array.isArray(state.prefs)) {
    state.prefs = {}
    changed = true
  }
  if (!PEER_LEVELS.includes(state.prefs.federation)) {
    state.prefs.federation = 'off'
    changed = true
  }
  const fed = state.federation
  if (fed === null || typeof fed !== 'object' || Array.isArray(fed)) {
    state.federation = emptyFederation()
    return true
  }
  const defaults = emptyFederation()
  for (const key of Object.keys(defaults)) {
    if (!(key in fed)) {
      fed[key] = defaults[key]
      changed = true
    }
  }
  if (fed.version !== 1) {
    fed.version = 1
    changed = true
  }
  if (fed.hubId !== null && (typeof fed.hubId !== 'string' || fed.hubId === '' || fed.hubId.length > 64 || !HUB_ID_PATTERN.test(fed.hubId))) {
    fed.hubId = null
    changed = true
  }
  for (const key of ['inbox', 'outbox', 'seen']) {
    if (fed[key] === null || typeof fed[key] !== 'object' || Array.isArray(fed[key])) {
      fed[key] = {}
      changed = true
    }
  }
  if (!Number.isFinite(fed.peersAt)) {
    fed.peersAt = 0
    changed = true
  }
  if (!Number.isInteger(fed.seq) || fed.seq < 0) {
    fed.seq = 0
    changed = true
  }
  if (typeof fed.allowPeerToMain !== 'boolean') {
    fed.allowPeerToMain = false
    changed = true
  }
  if (fed.lastError !== null && (typeof fed.lastError !== 'object' || Array.isArray(fed.lastError))) {
    fed.lastError = null
    changed = true
  }
  return changed
}

// A peer row survives a restart only if it says which hub it came from. A half-written
// row (an older shape, a hand edit) is dropped rather than mirrored as a local Bot.
export function migrateFederation(state) {
  let changed = false
  for (const [id, bot] of Object.entries(state.bots ?? {})) {
    if (!isPeerBot(bot)) continue
    const worker = bot.worker
    if (worker === null || typeof worker !== 'object' || worker.home !== 'hub'
      || typeof worker.hubId !== 'string' || worker.hubId === ''
      || typeof worker.botId !== 'string' || worker.botId === '') {
      delete state.bots[id]
      changed = true
    }
  }
  return changed
}

function peerLevelOf(state) {
  const level = state.prefs?.federation
  return PEER_LEVELS.includes(level) ? level : 'off'
}

const effectiveLevel = (local, remote) => (LEVEL_RANK.get(local) <= LEVEL_RANK.get(remote) ? local : remote)

// What this hub tells the other machines about itself: never a private Bot, never a
// joined shadow, never another machine's shadow, never a remote worker.
export function localBotsForPeer(rt) {
  const state = rt.state ?? {}
  const bots = []
  for (const bot of Object.values(state.bots ?? {})) {
    if (bot === null || typeof bot !== 'object') continue
    if (bot.origin === 'joined' || bot.origin === 'peer') continue
    if (bot.type === 'remote-worker') continue
    if (bot.private === true) continue
    if (typeof bot.id !== 'string' || bot.id === '') continue
    const name = typeof bot.name === 'string' ? bot.name.slice(0, 40) : ''
    const role = typeof bot.role === 'string' ? bot.role.slice(0, 24) : ''
    const model = typeof bot.model === 'string' && bot.model !== '' ? bot.model : undefined
    bots.push({
      id: bot.id,
      name,
      role,
      ...(typeof rt.isMain === 'function' && rt.isMain(bot.id) ? { main: true } : {}),
      ...(model === undefined ? {} : { model: model.slice(0, 120) }),
    })
  }
  return bots
}

function registryOf(rt) {
  try {
    return rt.ctx?.get?.('remote-agent:registry')
  } catch {
    return undefined
  }
}

function capsOf(registry, nodeId) {
  const node = typeof registry.getNode === 'function' ? registry.getNode(nodeId) : undefined
  const caps = node?.hello?.caps ?? node?.caps
  return Array.isArray(caps) ? caps : []
}

const speaksPeer = (registry, nodeId) => capsOf(registry, nodeId).includes(PEER_CAP)

function onlinePeerNodes(rt) {
  const registry = registryOf(rt)
  if (!registry || typeof registry.onlineNodes !== 'function') return []
  try {
    return registry.onlineNodes().filter((node) => Array.isArray(node?.hello?.caps) && node.hello.caps.includes(PEER_CAP)).map((node) => node.nodeId)
  } catch {
    return []
  }
}

export function ensureRegistrySubscription(rt) {
  const registry = registryOf(rt)
  if (!registry || typeof registry.on !== 'function' || subscribed.has(registry)) return registry
  subscribed.add(registry)
  try {
    registry.on('roster', (info) => {
      // The node has new local Bots: answer with ours, once, after the burst settles.
      if (peerLevelOf(rt.state) !== 'off') markPeerRosterDirty(rt, info?.nodeId)
    })
  } catch {
    /* a registry without events can still be pushed to directly */
  }
  return registry
}

function ensureHubId(rt) {
  const state = rt.state
  const fed = state.federation ?? (state.federation = emptyFederation())
  if (typeof fed.hubId === 'string' && fed.hubId !== '') return fed.hubId
  fed.hubId = `hub-${randomBytes(4).toString('hex')}`
  return fed.hubId
}

export async function pushPeerRoster(rt, nodeId) {
  if (typeof nodeId !== 'string' || nodeId === '') return false
  const state = rt.state
  const fed = state.federation ?? (state.federation = emptyFederation())
  const level = peerLevelOf(state)
  const registry = registryOf(rt)
  if (!registry || typeof registry.send !== 'function') return false
  if (!speaksPeer(registry, nodeId)) return false
  ensureRegistrySubscription(rt)
  const hubId = ensureHubId(rt)
  const payload = {
    hubId,
    level,
    hostname: osHostname().slice(0, 80),
    bots: level === 'off' ? [] : localBotsForPeer(rt),
  }
  let sent = false
  try {
    sent = registry.send(nodeId, 'peer/roster', payload) === true
  } catch (error) {
    fed.lastError = { code: 'send-threw', at: Date.now(), message: String(error?.message ?? error) }
    return false
  }
  if (!sent) {
    // Kept in memory only: the next roster event or local change retries.
    fed.lastError = { code: 'send-failed', at: Date.now(), nodeId }
    return false
  }
  fed.lastError = null
  fed.peersAt = Date.now()
  fed.seq += 1
  return true
}

// Local Bots changed: push once after the burst, to the node that reported, or to every
// node that announced peer/v1 when the change is local.
export function markPeerRosterDirty(rt, nodeId) {
  if (peerLevelOf(rt.state) === 'off') return
  let map = timers.get(rt)
  if (map === undefined) {
    map = new Map()
    timers.set(rt, map)
  }
  const key = typeof nodeId === 'string' && nodeId !== '' ? nodeId : '*'
  if (map.has(key)) return
  const delay = Number.isFinite(rt.peerRosterDelayMs) ? rt.peerRosterDelayMs : DEBOUNCE_MS
  map.set(key, setTimeout(() => {
    map.delete(key)
    const targets = typeof nodeId === 'string' && nodeId !== '' ? [nodeId] : onlinePeerNodes(rt)
    for (const target of targets) void pushPeerRoster(rt, target)
  }, delay))
}

function pruneSeen(fed, now = Date.now()) {
  for (const [key, at] of Object.entries(fed.seen)) {
    if (!Number.isFinite(at) || now - at > SEEN_TTL) delete fed.seen[key]
  }
}

function clearPeerState(state) {
  for (const [id, bot] of Object.entries(state.bots ?? {})) {
    if (isPeerBot(bot)) delete state.bots[id]
  }
  const fed = state.federation ?? (state.federation = emptyFederation())
  fed.inbox = {}
  fed.outbox = {}
  pruneSeen(fed)
}

function backupOnce(rt) {
  const statePath = rt.statePath
  if (typeof statePath !== 'string' || statePath === '') return false
  const backup = `${statePath}.federation.bak`
  if (!existsSync(statePath) || existsSync(backup)) return false
  try {
    copyFileSync(statePath, backup)
    return true
  } catch (error) {
    rt.warn?.('ds-bot: federation backup failed: %s', error?.message ?? String(error))
    return false
  }
}

export async function setFederationLevel(rt, level) {
  if (!PEER_LEVELS.includes(level)) throw Object.assign(new Error('Unknown federation level'), { code: 'bot/invalid' })
  const state = rt.state
  ensureFederationState(state)
  const before = peerLevelOf(state)
  if (before === level) return { level, allowPeerToMain: state.federation.allowPeerToMain === true }
  // The file before the first switch into sharing is kept once, beside the state.
  if (before === 'off' && level !== 'off') backupOnce(rt)
  state.prefs.federation = level
  if (level === 'off') clearPeerState(state)
  await rt.save()
  const targets = onlinePeerNodes(rt)
  for (const nodeId of targets) await pushPeerRoster(rt, nodeId)
  return { level, allowPeerToMain: state.federation.allowPeerToMain === true }
}

// One node's report. A Bot the report stopped naming is marked offline at once and
// deleted after MISSING_FRAMES reports; a Bot that comes back keeps its createdAt.
export async function applyPeerRoster(rt, payload) {
  const state = rt.state
  ensureFederationState(state)
  const fed = state.federation
  const now = Date.now()
  const hubId = payload.hubId
  const hostname = typeof payload.hostname === 'string' ? payload.hostname : ''
  const snapshot = JSON.parse(JSON.stringify(state.bots ?? {}))
  const next = {}
  const incoming = new Set()
  for (const item of payload.bots ?? []) {
    const id = peerId(hubId, item.id)
    incoming.add(id)
    const existing = state.bots[id]
    next[id] = {
      ...existing,
      id,
      name: item.name,
      role: item.role,
      type: 'remote-worker',
      origin: 'peer',
      readonly: true,
      capabilities: Array.isArray(existing?.capabilities) ? existing.capabilities : [],
      createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
      ...(item.main === true ? { main: true } : {}),
      worker: {
        home: 'hub',
        hubId,
        botId: item.id,
        hostname,
        online: true,
        lastSeen: now,
        missingFromReport: false,
        missingFrames: 0,
        ...(typeof item.model === 'string' ? { model: item.model } : {}),
      },
    }
  }
  const removals = []
  for (const bot of Object.values(state.bots ?? {})) {
    if (!isPeerBot(bot) || bot.worker?.hubId !== hubId) continue
    if (incoming.has(bot.id)) continue
    const missing = (Number.isInteger(bot.worker?.missingFrames) ? bot.worker.missingFrames : 0) + 1
    if (missing >= MISSING_FRAMES) {
      removals.push(bot.id)
      continue
    }
    next[bot.id] = {
      ...bot,
      worker: { ...bot.worker, online: false, missingFromReport: true, missingFrames: missing },
    }
  }
  for (const [id, row] of Object.entries(next)) state.bots[id] = row
  for (const id of removals) delete state.bots[id]
  fed.peersAt = now
  fed.seq += 1
  try {
    await rt.save()
    fed.lastError = null
    return true
  } catch (error) {
    // Half a roster is worse than none: put every row back, keep the reason.
    state.bots = snapshot
    fed.lastError = { code: 'save-failed', at: now, message: String(error?.message ?? error) }
    return false
  }
}

async function clearPeerShadows(rt) {
  const state = rt.state
  const snapshot = JSON.parse(JSON.stringify(state.bots ?? {}))
  clearPeerState(state)
  try {
    await rt.save()
    state.federation.lastError = null
    return true
  } catch (error) {
    state.bots = snapshot
    state.federation.lastError = { code: 'save-failed', at: Date.now(), message: String(error?.message ?? error) }
    return false
  }
}

export async function handlePeerRoster(rt, data) {
  const checked = sanitizePeerRoster(data)
  if (!checked.ok) return false
  ensureFederationState(rt.state)
  const local = peerLevelOf(rt.state)
  const level = effectiveLevel(local, checked.value.level)
  if (level === 'off') return clearPeerShadows(rt)
  return applyPeerRoster(rt, { ...checked.value, level })
}

export function federationView(rt) {
  const state = rt.state
  const fed = state.federation ?? {}
  return {
    level: peerLevelOf(state),
    allowPeerToMain: fed.allowPeerToMain === true,
    hubId: fed.hubId ?? null,
    peersAt: Number.isFinite(fed.peersAt) ? fed.peersAt : 0,
    lastError: fed.lastError ?? null,
  }
}

export function install(rt) {
  ensureRegistrySubscription(rt)
  try {
    rt.ctx?.provide?.('remote-agent:peer-roster', {
      onRoster: (data) => {
        void handlePeerRoster(rt, data).catch((error) => rt.warn?.('ds-bot: peer roster not applied: %s', error?.message ?? String(error)))
      },
    })
  } catch {
    /* a host without provide (an old runtime) still pushes; it just cannot receive */
  }
  rt.markPeerRosterDirty = (nodeId) => markPeerRosterDirty(rt, nodeId)
  rt.setFederationLevel = (level) => setFederationLevel(rt, level)
  rt.federationView = () => federationView(rt)
  rt.peerBots = () => Object.values(rt.state.bots ?? {}).filter(isPeerBot)
}
