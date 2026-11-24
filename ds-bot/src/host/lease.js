// lease.js — execution lease for remote Bots (Phase 1).
//
// The hub is the sole grantor of execution leases. A lease says:
//   "Bot <identityId> runs on <machineId> with epoch <epoch> until <leaseUntil>."
//
// Before executing any turn for a joined Bot, the station checks:
//   1. It holds a valid lease for the Bot (leaseUntil > now).
//   2. The epoch in the lease matches the Bot's current epoch in the directory.
//
// Migration: epoch +1 means the old machine's lease will be rejected on its next
// heartbeat; it stops accepting new turns and the new machine picks up.
//
// Storage: leases live in the team state under state.leases[identityId].
// The hub populates them; nodes receive them in directory snapshots.

export const LEASE_RENEWAL_MS = 15_000   // station renews every 15 s via heartbeat
export const LEASE_DURATION_MS = 60_000  // hub grants a 60-second lease

/** An empty lease (Bot not yet granted an execution home). */
export const noLease = () => ({ machineId: null, epoch: 0, leaseUntil: 0 })

/** Create a new lease for identityId on machineId. */
export function grantLease(state, identityId, machineId, { now = Date.now(), epoch } = {}) {
  if (!state.leases || typeof state.leases !== 'object') state.leases = {}
  const existing = state.leases[identityId]
  const nextEpoch = epoch ?? (existing ? existing.epoch : 1)
  const lease = { machineId, epoch: nextEpoch, leaseUntil: now + LEASE_DURATION_MS }
  state.leases[identityId] = lease
  return lease
}

/** Renew an existing valid lease — same machine + epoch, extended leaseUntil. */
export function renewLease(state, identityId, machineId, { now = Date.now() } = {}) {
  const existing = state.leases?.[identityId]
  if (!existing || existing.machineId !== machineId) return undefined
  existing.leaseUntil = now + LEASE_DURATION_MS
  return existing
}

/** Is the lease for identityId currently valid for machineId with the given epoch? */
export function hasValidLease(state, identityId, machineId, { now = Date.now() } = {}) {
  const lease = state.leases?.[identityId]
  if (!lease) return false
  return lease.machineId === machineId && lease.leaseUntil > now
}

/** Bump epoch on migration: old machine's lease will be rejected on next heartbeat. */
export function migrateLease(state, identityId, toMachineId, { now = Date.now() } = {}) {
  const existing = state.leases?.[identityId] ?? noLease()
  return grantLease(state, identityId, toMachineId, { now, epoch: existing.epoch + 1 })
}

/** Revoke a Bot's lease (Bot deleted or moved away). */
export function revokeLease(state, identityId) {
  if (state.leases) delete state.leases[identityId]
}

/** Current lease for a Bot, or undefined. */
export function leaseOf(state, identityId) {
  return state.leases?.[identityId]
}
