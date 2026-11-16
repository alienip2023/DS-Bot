import { createElement as h, useEffect, useState } from 'react'
import { ModelMenu } from './model-menu.js'
import { isJoinedRemote } from './joined-errors.js'
import { pickTargets } from './pick-targets.js'
import { t } from './i18n.js'
import { isLocalRoute } from './agent-routes.js'

// A node's reported catalog can lag config-sync. API models configured on the main
// remain candidates; the node checks its live catalog before applying a pick.
// CLIs absent from the node stay disabled: a main's CLI is not a remote runtime.
// Both spellings: upstream v0.3.2 routes live under `local-`, a node of an older build still reports the bare names.
const CLI_PROVIDER = /^(?:local-)?(claude-code|codex-cli)(\/|$)/
const isCli = ref => isLocalRoute(ref) || CLI_PROVIDER.test(ref)

// The reason a model is greyed out, in one place so the wording is easy to change.
export const NODE_REASONS = Object.freeze({
  cli: () => t('The node has no matching CLI yet, or its setup is not synced'),
  provider: () => t("This model's provider setup is not synced to the node yet"),
})

export const nodeNoticeText = () => t('The node has not reported its models; some may be unavailable.')

// `nodeModels`: null while loading, [] when the node reports none (or the lookup failed), else
// [{ ref, provider, id, name }]. Returns what ModelMenu needs: { roster, unavailable, notice }.
export function joinedModelView(bot, roster, nodeModels) {
  const same = { roster, unavailable: [], notice: null }
  if (!isJoinedRemote(bot) || nodeModels === null || nodeModels === undefined) return same
  if (nodeModels.length === 0) return { ...same, notice: nodeNoticeText() }
  const onNode = new Set(nodeModels.map(model => model.ref))
  const missing = (roster.models ?? []).filter(model => !onNode.has(model.ref))
  const candidates = missing.filter(model => !isCli(model.ref) && model.needsKey !== true)
  const unavailable = missing.filter(model => isCli(model.ref) || model.needsKey === true).map(model => ({
    ref: model.ref, name: model.name, provider: model.provider, providerName: model.providerName,
    reason: isCli(model.ref) ? NODE_REASONS.cli() : NODE_REASONS.provider(),
  }))
  // `labels`: how the main names the models the node cannot run. The model picker's trigger reads it for a Bot whose
  // model is one of those, so the trigger and the greyed row call the same model by the same name.
  const labels = Object.fromEntries(unavailable.map(model => [model.ref, { name: model.name, providerName: model.providerName }]))
  return {
    // The picker reads a model's thinking levels from `reasoning.efforts` (what the host's own catalog gives it),
    // so a node model's `efforts` is normalized to that same shape here, at the boundary. Only when the node
    // actually reported levels: a model without them keeps asking the host, as before.
    roster: { ...roster, models: [...nodeModels.map(model => ({ ref: model.ref, provider: model.provider, name: model.name, providerName: model.provider, ...(Array.isArray(model.efforts) && model.efforts.length > 0 ? { reasoning: { efforts: model.efforts } } : {}) })), ...candidates], labels },
    unavailable, notice: null,
  }
}

// The node's model list for a joined remote Bot: null until the host answers.
export function useNodeModels(bot, actions) {
  const [catalog, setCatalog] = useState(null)
  const nodeId = bot.worker?.nodeId
  const remote = isJoinedRemote(bot) && Boolean(nodeId)
  const model = bot.model ?? bot.appliedModel
  useEffect(() => {
    if (!remote) return undefined
    let cancelled = false
    actions.botCreateTargets?.().then(res => {
      if (cancelled) return
      const node = pickTargets(res).find(target => target.nodeId === nodeId)
      setCatalog({ botId: bot.id, nodeId, model, models: Array.isArray(node?.models) ? node.models : [] })
    }).catch(() => { if (!cancelled) setCatalog({ botId: bot.id, nodeId, model, models: [] }) })
    return () => { cancelled = true }
  }, [bot.id, remote, nodeId, model])
  // React keeps hook state when a drawer switches Bots. A previous node's list
  // cannot establish availability for this Bot, or for a newly selected model.
  return remote && catalog?.botId === bot.id && catalog.nodeId === nodeId && catalog.model === model ? catalog.models : null
}

// ModelMenu with the node's list. The hook-free half is separate so a test can hand it a list.
export function NodeModelMenu({ bot, roster, actions, run, wide, inline, nodeModels }) {
  const view = joinedModelView(bot, roster, nodeModels)
  return h(ModelMenu, { bot, roster: view.roster, actions, run, wide, inline, unavailable: view.unavailable, notice: view.notice, availabilityKnown: !isJoinedRemote(bot) || (nodeModels?.length ?? 0) > 0 })
}

export function BotModelMenu({ bot, roster, actions, run, wide, inline }) {
  return h(NodeModelMenu, { bot, roster, actions, run, wide, inline, nodeModels: useNodeModels(bot, actions) })
}
