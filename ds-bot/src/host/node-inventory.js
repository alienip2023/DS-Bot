// M2: the Bots that live on a node machine.
//
// A node's dsh-remote-agent reports its local Bot list as `bot/inventory`; the
// registry forwards that as the `botInventory` event, and this module mirrors those
// Bots here as read-only, dispatchable rows (`origin: 'node'`). Nothing about a node
// row may look like a local Bot: no Session, no Thread, no Main role, no model pick.
// A row that came from `bot/create` is a joined row (origin 'joined') and keeps
// priority: the inventory only refreshes its online state.
//
// The node side of the same feature is the `remote-agent:node-bots` provider that
// dsh-remote-agent reads. Both halves run in the same dsh process on a node, which
// is why the provider is a ctx service rather than a file.

export const NODE_TURN_TIMEOUT_MS = 600_000
// A report arrives about every 5s; a row missing from twelve of them (~60s) is gone.
export const MISSING_FRAMES = 12
const MAX_BOTS = 64
const ID_LIMIT = 128
const NAME_LIMIT = 40
const ROLE_LIMIT = 24
const MODEL_LIMIT = 120

export const NODE_PREFIX = 'node:'
export const isNodeBot = (bot) => bot !== null && typeof bot === 'object' && bot.origin === 'node'
export const nodeBotId = (nodeId, remoteBotId) => `${NODE_PREFIX}${encodeURIComponent(nodeId)}:${encodeURIComponent(remoteBotId)}`

const text = (value, limit) => String(value ?? '').trim().slice(0, limit)

function registryOf(rt) {
  try {
    return rt.ctx?.get?.('remote-agent:registry')
  } catch {
    return undefined
  }
}

function nodeInventoryState(rt) {
  const state = rt.state
  state.prefs ??= {}
  if (typeof state.prefs.nodeInventory !== 'boolean') state.prefs.nodeInventory = false
  state.nodeInventory ??= { lastError: null, appliedAt: 0 }
  return state.nodeInventory
}

export function nodeInventoryOn(rt) {
  return rt.state?.prefs?.nodeInventory === true
}

// ── node side: what ds-bot tells dsh-remote-agent ────────────────────────────

/**
 * The local Bots this machine owns. A joined row belongs to another machine and a
 * peer row is another machine's list; neither may be reported back as ours.
 */
export function listLocalBots(rt) {
  const bots = []
  for (const bot of Object.values(rt.state?.bots ?? {})) {
    if (bot === null || typeof bot !== 'object') continue
    if (bot.origin === 'joined' || bot.origin === 'peer' || bot.origin === 'node') continue
    if (bot.type === 'remote-worker') continue
    if (bot.private === true) continue
    const id = text(bot.id, ID_LIMIT)
    if (id === '') continue
    const row = { id, name: text(bot.name, NAME_LIMIT) || id, role: text(bot.role, ROLE_LIMIT) }
    const model = text(bot.appliedModel ?? bot.model, MODEL_LIMIT)
    if (model !== '') row.model = model
    if (rt.isMain?.(bot.id) === true || bot.main === true) row.main = true
    if (Number.isFinite(bot.createdAt)) row.createdAt = bot.createdAt
    bots.push(row)
  }
  return bots
}

// ── hub side: merging an inventory ───────────────────────────────────────────

function cleanBots(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const bots = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const id = text(item.id, ID_LIMIT)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const row = { id, name: text(item.name, NAME_LIMIT) || id, role: text(item.role, ROLE_LIMIT) }
    const model = text(item.model, MODEL_LIMIT)
    if (model !== '') row.model = model
    if (item.main === true) row.main = true
    if (Number.isFinite(item.createdAt)) row.createdAt = item.createdAt
    bots.push(row)
    if (bots.length >= MAX_BOTS) break
  }
  return bots
}

function nodeRowsOf(rt, nodeId) {
  return Object.values(rt.state.bots ?? {}).filter(bot => isNodeBot(bot) && bot.worker?.nodeId === nodeId)
}

function dropRows(rt, rows) {
  for (const row of rows) {
    if (rt.state.bots?.[row.id] === row) delete rt.state.bots[row.id]
  }
}

/**
 * Merge one `bot/inventory` frame. One rt.save() per frame, and a failed save restores
 * the rows exactly as they were, so a half roster never stays on disk.
 */
export async function applyInventory(rt, inventory) {
  await rt.load()
  const state = rt.state
  const meta = nodeInventoryState(rt)
  const nodeId = text(inventory?.nodeId, 64)
  if (nodeId === '') return { ok: false, error: 'node-inventory-node-missing' }
  const hostname = text(inventory?.hostname, 80) || nodeId
  const at = Number.isFinite(inventory?.at) ? inventory.at : Date.now()
  const enabled = inventory?.enabled !== false
  const truncated = inventory?.truncated === true

  const mine = nodeRowsOf(rt, nodeId)
  const snapshot = new Map(mine.map(row => [row.id, JSON.parse(JSON.stringify(row))]))
  let applied = 0
  let outcome = { ok: true }
  try {
    if (!enabled) {
      dropRows(rt, mine)
      applied = 0
    } else if (!nodeInventoryOn(rt)) {
      // The switch is off here: accept the frame so the node stops resending, but keep
      // no rows. Turning it on later waits for the next report.
      dropRows(rt, mine)
      applied = 0
    } else {
      const present = new Set()
      for (const bot of cleanBots(inventory?.bots)) {
        present.add(bot.id)
        // A joined row for the same remote Bot wins: it carries the user's own create
        // and model choice, and the inventory only knows online state.
        const joined = Object.values(state.bots ?? {}).find(row => row?.origin === 'joined'
          && row.worker?.nodeId === nodeId
          && row.worker?.remoteBotId === bot.id)
        if (joined !== undefined) {
          joined.worker.online = true
          joined.worker.lastSeen = at
          joined.worker.hostname = hostname
          joined.worker.discovered = true
          continue
        }
        const id = nodeBotId(nodeId, bot.id)
        const existing = state.bots?.[id]
        if (isNodeBot(existing)) {
          existing.name = bot.name
          existing.role = bot.role
          if (bot.model === undefined) delete existing.model
          else existing.model = bot.model
          existing.worker.hostname = hostname
          existing.worker.online = true
          existing.worker.lastSeen = at
          existing.worker.missingFrames = 0
        } else {
          state.bots ??= {}
          state.bots[id] = {
            id,
            name: bot.name,
            role: bot.role,
            ...(bot.model === undefined ? {} : { model: bot.model }),
            origin: 'node',
            type: 'remote-worker',
            managedBy: 'node',
            readonly: true,
            dispatchable: true,
            worker: {
              home: 'node',
              nodeId,
              remoteBotId: bot.id,
              hostname,
              online: true,
              lastSeen: at,
              firstSeenAt: at,
              missingFrames: 0,
              discovered: true,
            },
            ...(bot.createdAt === undefined ? {} : { createdAt: bot.createdAt }),
          }
        }
        applied += 1
      }
      // A truncated frame is a partial list: its absences mean "not sent", not "gone".
      if (!truncated) {
        for (const row of mine) {
          if (present.has(row.worker?.remoteBotId)) continue
          row.worker.missingFrames = (Number.isFinite(row.worker.missingFrames) ? row.worker.missingFrames : 0) + 1
          if (row.worker.missingFrames >= MISSING_FRAMES) delete state.bots[row.id]
        }
      }
    }
    meta.appliedAt = at
    meta.lastError = null
    await rt.save()
  } catch (error) {
    // Restore only this node's rows; other nodes' reports are untouched.
    for (const row of nodeRowsOf(rt, nodeId)) {
      if (!snapshot.has(row.id) && state.bots?.[row.id] === row) delete state.bots[row.id]
    }
    for (const [id, row] of snapshot) state.bots[id] = row
    meta.lastError = { code: 'save-failed', at: Date.now(), message: String(error?.message ?? error) }
    outcome = { ok: false, error: 'save-failed' }
  }
  await sendAck(rt, nodeId, outcome.ok, applied, outcome.error)
  return outcome
}

async function sendAck(rt, nodeId, ok, applied, error) {
  const registry = registryOf(rt)
  if (!registry || typeof registry.send !== 'function') return
  try {
    registry.send(nodeId, 'bot/inventory-ack', {
      nodeId,
      ok,
      applied,
      at: Date.now(),
      ...(error === undefined ? {} : { error }),
    })
  } catch { /* an ack is best effort; the node resends on the next keepalive */ }
}

/** Remove one node's rows (switch off) or every node's rows (no nodeId). */
export async function clearNodeInventory(rt, nodeId) {
  await rt.load()
  const rows = Object.values(rt.state.bots ?? {}).filter(bot => isNodeBot(bot)
    && (nodeId === undefined || bot.worker?.nodeId === nodeId))
  if (rows.length === 0) return 0
  for (const row of rows) delete rt.state.bots[row.id]
  await rt.save()
  return rows.length
}

/** A node went offline: grey its rows out, keep them so the next replay can fill in. */
export async function markNodeOffline(rt, nodeId) {
  await rt.load()
  let changed = 0
  for (const row of nodeRowsOf(rt, nodeId)) {
    if (row.worker.online === false) continue
    row.worker.online = false
    changed += 1
  }
  if (changed > 0) await rt.save()
  return changed
}

// ── install ──────────────────────────────────────────────────────────────────

const subscribed = new WeakSet()

export function ensureRegistrySubscription(rt) {
  const registry = registryOf(rt)
  if (registry === undefined || typeof registry.on !== 'function' || subscribed.has(registry)) return registry
  subscribed.add(registry)
  try {
    registry.on('botInventory', (inventory) => {
      void applyInventory(rt, inventory).catch(error => rt.warn?.('ds-bot: node inventory not applied: %s', error?.message ?? String(error)))
    })
    registry.on('nodeOffline', (payload) => {
      if (typeof payload?.nodeId !== 'string' || payload.nodeId === '') return
      void markNodeOffline(rt, payload.nodeId).catch(error => rt.warn?.('ds-bot: node inventory offline mark failed: %s', error?.message ?? String(error)))
    })
  } catch { /* a registry without events can still be pushed to directly */ }
  return registry
}

export function install(rt) {
  nodeInventoryState(rt)
  ensureRegistrySubscription(rt)
  // The node side: dsh-remote-agent reads this provider from the same process.
  try {
    rt.ctx?.provide?.('remote-agent:node-bots', {
      enabled: () => nodeInventoryOn(rt),
      list: () => listLocalBots(rt),
    })
  } catch { /* a host without provide (an old runtime) cannot report; the hub side still works */ }
  rt.applyNodeInventory = (inventory) => applyInventory(rt, inventory)
  rt.clearNodeInventory = (nodeId) => clearNodeInventory(rt, nodeId)
  rt.nodeBots = () => Object.values(rt.state?.bots ?? {}).filter(isNodeBot)
}
