// node-compat.js — what a node's AC can do, read from the capabilities it advertises in its hello.
//
// ds-bot's node features need AC on the node to carry them (AC 0.4.20): `bot-turn-mode/1` (a steer joins
// the running turn), `bot-action/1` (answer a card, stop / follow up a task from the hub), `roster-cards/1`
// (the cards a Bot waits on reach the hub); and `bot-trace/1` (AC 0.4.21: the node's thinking and tool steps
// reach the hub's page). A node without one is never silently half-working: ds-bot
// falls back to what the node can do and says which node needs which update.
// A node whose capabilities are not known yet (not connected, or an AC that does not report them) counts
// as able: nothing is held back on a guess, and the node's own refusal is still shown.

export const NODE_FEATURES = Object.freeze({
  steer: { cap: 'bot-turn-mode/1', label: '插话' },
  actions: { cap: 'bot-action/1', label: '在主控回答卡片、操作任务' },
  cards: { cap: 'roster-cards/1', label: '节点卡片' },
  trace: { cap: 'bot-trace/1', label: '思考过程与工具步骤' },
  attach: { cap: 'bot-attach/1', label: '图片和文件附件' },
  models: { cap: 'config-models/1', label: '模型能力（图片、思考档位）' },
})
// The AC release that carries every capability above: ds-bot 0.3.10-fork.109 pairs with AC 0.4.29 (hub and nodes).
// The full version table is in docs/ac-pairing.md and in AC's README.
export const AC_NEEDED = '0.4.29'

/** The capabilities of a node, or undefined when they are not known. */
export function nodeCapsOf(rt, nodeId) {
  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  let node
  try { node = registry?.getNode?.(nodeId) } catch { node = undefined }
  const caps = node?.hello?.caps
  return Array.isArray(caps) ? new Set(caps) : undefined
}

/** Can this node Bot's node do `feature`? Unknown counts as yes. */
export function nodeCan(rt, bot, feature) {
  const caps = nodeCapsOf(rt, bot?.worker?.nodeId)
  return caps === undefined || caps.has(NODE_FEATURES[feature].cap)
}

/** The features this node lacks (empty when it has them all or its capabilities are not known). */
export function nodeMissing(rt, bot) {
  const caps = nodeCapsOf(rt, bot?.worker?.nodeId)
  if (caps === undefined) return []
  return Object.entries(NODE_FEATURES).filter(([, feature]) => !caps.has(feature.cap)).map(([key]) => key)
}

/** The AC version a node reported in its hello (0.4.28+), or undefined. */
export function nodeAcVersion(rt, nodeId) {
  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  let node
  try { node = registry?.getNode?.(nodeId) } catch { node = undefined }
  const version = node?.hello?.acVersion
  return typeof version === 'string' && version !== '' ? version : undefined
}

/** What the Bot list carries for a node Bot whose AC is behind: { nodeCompat: ['steer', …], nodeAcVersion?, acNeeded }. */
export function compatOf(rt, bot) {
  const missing = bot?.origin === 'joined' && bot.worker?.home === 'remote' && bot.worker.online !== false ? nodeMissing(rt, bot) : []
  if (missing.length === 0) return {}
  const version = nodeAcVersion(rt, bot.worker?.nodeId)
  return { nodeCompat: missing, ...(version === undefined ? {} : { nodeAcVersion: version }), acNeeded: AC_NEEDED }
}

export const refusalFor = (feature) => `节点上的 AC 版本太旧，不支持「${NODE_FEATURES[feature].label}」，请把节点升级到 AC ${AC_NEEDED}`
