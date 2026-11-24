// team-directory.js — Team Directory (Phase 1).
//
// The hub maintains the single authoritative directory. Every machine caches
// a read-only snapshot. replaces the dual peer-row generation paths:
//   1. bot-network.js (peer rows from federation snapshots)
//   2. joined-turn.js / roster-join.js (joined shadow rows from roster reports)
//
// Directory schema:
//   machines:  machineId → { name, os, hostname, endpoints[], caps, acVersion, online, lastSeen, resources }
//   bots:      identityId → { name, role, home{machineId,epoch,leaseUntil}, status, model, private }
//
// The snapshot is sent as 'directory/snapshot' + incremental 'directory/delta' (Phase 2).
// In Phase 1 the directory is derived from the existing team state and node roster reports;
// it does not yet replace the wire protocol but provides the authoritative in-memory lookup.

/** Regex for a valid identityId (16 hex chars). */
export const IDENTITY_ID_RE = /^[0-9a-f]{16}$/

/** Initialise an empty directory on the team state if not present. */
export function ensureDirectory(state) {
  if (!state.directory || typeof state.directory !== 'object') {
    state.directory = { machines: {}, bots: {} }
  }
  if (!state.directory.machines) state.directory.machines = {}
  if (!state.directory.bots) state.directory.bots = {}
  return state.directory
}

/**
 * Update the machine record from a node hello / heartbeat.
 * Returns true when the directory entry changed.
 */
export function applyMachineHello(state, hello, { now = Date.now() } = {}) {
  const dir = ensureDirectory(state)
  const { nodeId: machineId, hostname, os, caps = [], acVersion = '', online = true } = hello ?? {}
  if (typeof machineId !== 'string' || machineId === '') return false
  const existing = dir.machines[machineId] ?? {}
  const next = {
    ...existing,
    machineId,
    name: hostname || machineId,
    os: os || existing.os || 'unknown',
    hostname: hostname || machineId,
    caps: Array.isArray(caps) ? caps : existing.caps ?? [],
    acVersion,
    online,
    lastSeen: now,
  }
  if (JSON.stringify(next) === JSON.stringify(existing)) return false
  dir.machines[machineId] = next
  return true
}

/** Mark a machine as offline. */
export function markMachineOffline(state, machineId, { now = Date.now() } = {}) {
  const dir = ensureDirectory(state)
  const rec = dir.machines[machineId]
  if (!rec) return false
  if (rec.online === false) return false
  rec.online = false
  rec.lastSeen = now
  return true
}

/**
 * Upsert a Bot in the directory from a roster report entry.
 * Called from applyRosterReport after the shadow row is built.
 */
export function applyBotIdentity(state, { identityId, name, role, model, machineId, epoch, leaseUntil }, { now = Date.now() } = {}) {
  if (!IDENTITY_ID_RE.test(identityId ?? '')) return false
  const dir = ensureDirectory(state)
  const existing = dir.bots[identityId] ?? {}
  const next = {
    ...existing,
    identityId,
    name: (typeof name === 'string' ? name : existing.name) ?? '',
    role: (typeof role === 'string' ? role : existing.role) ?? '',
    ...(typeof model === 'string' && model !== '' ? { model } : {}),
    home: {
      machineId: machineId ?? existing.home?.machineId ?? null,
      epoch: typeof epoch === 'number' ? epoch : (existing.home?.epoch ?? 1),
      leaseUntil: typeof leaseUntil === 'number' ? leaseUntil : (existing.home?.leaseUntil ?? 0),
    },
    status: existing.status ?? 'online',
    updatedAt: now,
  }
  if (JSON.stringify(next) === JSON.stringify(existing)) return false
  dir.bots[identityId] = next
  return true
}

/** Remove a Bot from the directory. */
export function removeBotFromDirectory(state, identityId) {
  const dir = ensureDirectory(state)
  if (!dir.bots[identityId]) return false
  delete dir.bots[identityId]
  return true
}

/** Look up a Bot by identityId. */
export function botByIdentityId(state, identityId) {
  return state.directory?.bots?.[identityId]
}

/** All machines in the directory. */
export function allMachines(state) {
  return Object.values(state.directory?.machines ?? {})
}

/** All Bots in the directory. */
export function allDirectoryBots(state) {
  return Object.values(state.directory?.bots ?? {})
}

/**
 * Find the shadow row in state.bots that matches a given identityId.
 * Falls back to scanning worker.identityId when top-level identityId is absent
 * (pre-Phase-1 rows).
 */
export function shadowByIdentityId(state, identityId) {
  if (!IDENTITY_ID_RE.test(identityId ?? '')) return undefined
  for (const bot of Object.values(state.bots ?? {})) {
    if (bot?.identityId === identityId) return bot
    if (bot?.worker?.identityId === identityId) return bot
  }
  return undefined
}
