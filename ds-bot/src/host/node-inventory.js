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

// ── install ──────────────────────────────────────────────────────────────────

export function install(rt) {
  nodeInventoryState(rt)
  // The node side: dsh-remote-agent reads this provider from the same process.
  try {
    rt.ctx?.provide?.('remote-agent:node-bots', {
      enabled: () => nodeInventoryOn(rt),
      list: () => listLocalBots(rt),
    })
  } catch { /* a host without provide (an old runtime) cannot report; the hub side works anyway */ }
}
