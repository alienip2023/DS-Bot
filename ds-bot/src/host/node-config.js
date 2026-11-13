/**
 * Per-node task concurrency (how many tasks one remote node runs at once).
 *
 * The node's TaskEngine defaults to 8; the main can raise or lower it per node
 * (1–64). Saving sends `node/config` over the existing registry channel; the node
 * applies it to the live engine and pumps its queue, so no DSH restart is needed.
 *
 * An old node does not know the frame: it ignores it and never answers. We wait
 * for the receipt and then say "the node does not support this" — the node keeps
 * running its old default of 4, and the panel shows that instead of pretending the
 * value took effect.
 */
import { randomUUID } from 'node:crypto'

export const NODE_CONCURRENCY_MIN = 1
export const NODE_CONCURRENCY_MAX = 64
/** What a node runs without any configuration (current remote-agent). */
export const NODE_CONCURRENCY_DEFAULT = 8
/** What a node runs when it is too old to know node/config. */
export const NODE_CONCURRENCY_LEGACY = 4
export const NODE_CONCURRENCY_ACK_MS = 5_000
/** Waits between attempts when the node answers with a refusal. */
export const NODE_CONCURRENCY_RETRY_MS = [5_000, 15_000]

function registryOf(rt) {
  try { return rt.ctx?.get?.('remote-agent:registry') } catch { return undefined }
}

function limitsOf(rt) {
  const state = rt.state ?? {}
  if (state.nodeLimits === null || typeof state.nodeLimits !== 'object' || Array.isArray(state.nodeLimits)) state.nodeLimits = {}
  return state.nodeLimits
}

/** The same rule the node applies: an integer in 1–64, or undefined (never clipped). */
export function validConcurrency(value) {
  return Number.isInteger(value) && value >= NODE_CONCURRENCY_MIN && value <= NODE_CONCURRENCY_MAX ? value : undefined
}

function entryOf(rt, nodeId) {
  const limits = limitsOf(rt)
  const entry = limits[nodeId] ?? (limits[nodeId] = {})
  return entry
}

/**
 * What a node's entry says when nothing was ever pushed: it runs its own default,
 * and whether we know that default depends on whether it could answer us.
 */
function viewOf(entry) {
  const applied = Number.isInteger(entry.appliedMaxConcurrent) ? entry.appliedMaxConcurrent : null
  return {
    maxConcurrent: Number.isInteger(entry.maxConcurrent) ? entry.maxConcurrent : null,
    appliedMaxConcurrent: applied,
    // applied = the node confirmed this value; pending = sent, no answer yet.
    status: typeof entry.status === 'string' ? entry.status : 'unknown',
    lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
  }
}

/** Every online node with its limit and queue health, for the settings panel. */
export async function nodeConcurrencyView(rt) {
  await rt.load?.()
  const nodes = []
  let online = []
  try {
    const registry = registryOf(rt)
    if (registry && typeof registry.onlineNodes === 'function') online = registry.onlineNodes()
  } catch { /* registry plugin absent: an empty list is the truthful answer */ }
  for (const rec of online) {
    const nodeId = String(rec?.nodeId ?? '')
    if (nodeId === '') continue
    const entry = limitsOf(rt)[nodeId] ?? {}
    nodes.push({
      nodeId,
      hostname: rec?.hello?.hostname ?? rec?.hostname ?? nodeId,
      online: true,
      ...viewOf(entry),
      // Queue snapshot the node reports with its telemetry; null = too old to report.
      queue: rec?.queue && typeof rec.queue === 'object' ? rec.queue : null,
    })
  }
  return { defaultConcurrency: NODE_CONCURRENCY_DEFAULT, legacyConcurrency: NODE_CONCURRENCY_LEGACY, nodes }
}

/** Wait for the receipt of one request; undefined on timeout. */
function waitForReceipt(registry, { requestId, timeoutMs }) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { registry.off?.('nodeConfigResult', onResult) ?? registry.removeListener?.('nodeConfigResult', onResult) } catch {}
      resolve(value)
    }
    const onResult = (ev) => {
      if (ev && ev.requestId === requestId) finish(ev)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    timer.unref?.()
    registry.on('nodeConfigResult', onResult)
  })
}

/**
 * Send one node/config and record what came back. `attempt` starts at 0.
 * Returns the entry view; retries are scheduled on the runtime, never blocking the UI.
 */
async function pushLimit(rt, nodeId, attempt = 0) {
  const entry = entryOf(rt, nodeId)
  const wanted = validConcurrency(entry.maxConcurrent) ?? NODE_CONCURRENCY_DEFAULT
  const registry = registryOf(rt)
  if (!registry || typeof registry.send !== 'function') {
    entry.status = 'error'
    entry.lastError = 'node-config-unavailable'
    await rt.save?.()
    return viewOf(entry)
  }
  const requestId = randomUUID()
  entry.status = 'pending'
  entry.requestId = requestId
  entry.lastError = null
  entry.attempt = attempt
  entry.at = Date.now()
  await rt.save?.()
  let sent = false
  try {
    sent = registry.send(nodeId, 'node/config', { nodeId, requestId, maxConcurrent: wanted }) === true
  } catch { sent = false }
  if (!sent) {
    entry.status = 'error'
    entry.lastError = 'node-config-not-delivered'
    await rt.save?.()
    return viewOf(entry)
  }
  const receipt = await waitForReceipt(registry, { requestId, timeoutMs: NODE_CONCURRENCY_ACK_MS })
  if (receipt === undefined) {
    // No frame came back. A node that does not know node/config will never answer:
    // say so once instead of retrying for minutes, and report its old default.
    entry.status = 'unsupported'
    entry.lastError = 'node-config-no-answer'
    entry.appliedMaxConcurrent = NODE_CONCURRENCY_LEGACY
    await rt.save?.()
    return viewOf(entry)
  }
  if (receipt.ok === true && Number.isInteger(receipt.maxConcurrent)) {
    entry.status = 'applied'
    entry.appliedMaxConcurrent = receipt.maxConcurrent
    entry.lastError = null
    entry.attempt = 0
    await rt.save?.()
    return viewOf(entry)
  }
  // The node understood and refused: retry with backoff, then keep the failure visible.
  entry.status = 'refused'
  entry.lastError = String(receipt.error ?? 'node-config-refused').slice(0, 64)
  const nextAttempt = attempt + 1
  const delay = NODE_CONCURRENCY_RETRY_MS[Math.min(nextAttempt - 1, NODE_CONCURRENCY_RETRY_MS.length - 1)]
  if (nextAttempt < 3) {
    const timer = setTimeout(() => { void pushLimit(rt, nodeId, nextAttempt) }, delay)
    timer.unref?.()
  } else {
    entry.status = 'error'
  }
  await rt.save?.()
  return viewOf(entry)
}

/**
 * Save a node's limit and push it now. Returns the same view the panel reads.
 * A value outside 1–64 is refused as `bot/invalid` — never clipped.
 */
export async function setNodeConcurrency(rt, nodeId, maxConcurrent) {
  const id = String(nodeId ?? '').trim()
  if (id === '') throw Object.assign(new Error('Which node?'), { code: 'bot/invalid' })
  const wanted = validConcurrency(maxConcurrent)
  if (wanted === undefined) throw Object.assign(new Error('The limit must be a whole number from 1 to 64'), { code: 'bot/invalid' })
  const entry = entryOf(rt, id)
  entry.maxConcurrent = wanted
  // A new value always counts as a fresh attempt, even after "unsupported".
  const view = await pushLimit(rt, id, 0)
  return { nodeId: id, ...view }
}

export function install(rt) {
  rt.nodeConcurrencyView = () => nodeConcurrencyView(rt)
  rt.setNodeConcurrency = (nodeId, maxConcurrent) => setNodeConcurrency(rt, nodeId, maxConcurrent)
  // Re-apply a saved limit when the node comes back, unless it already told us it
  // does not support the frame (then only a new save may try again).
  const registry = registryOf(rt)
  if (registry && typeof registry.on === 'function') {
    registry.on('nodeOnline', (ev) => {
      const nodeId = String(ev?.nodeId ?? '')
      if (nodeId === '') return
      const entry = limitsOf(rt)[nodeId]
      if (!entry || !Number.isInteger(entry.maxConcurrent)) return
      if (entry.status === 'unsupported') return
      void pushLimit(rt, nodeId, 0)
    })
  }
}
