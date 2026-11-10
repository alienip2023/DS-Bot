import { createElement as h, useEffect, useState } from 'react'
import { ModelMenu } from './model-menu.js'
import { isJoinedRemote } from './joined-errors.js'
import { pickTargets } from './pick-targets.js'
import { t } from './i18n.js'

// A remote Bot runs on its node, so its model picker lists what the node can run: the node's
// reported catalog. Models of the main DSH that the node cannot run yet are not hidden; they are
// listed apart, greyed out, each with the reason. When the node reports no catalog the picker
// falls back to the main list, says so, and the node may still refuse a pick.
// Both spellings: upstream v0.3.2 routes live under `local-`, a node of an older build still reports the bare names.
const CLI_PROVIDER = /^(?:local-)?(claude-code|codex-cli)(\/|$)/

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
  const unavailable = (roster.models ?? []).filter(model => !onNode.has(model.ref)).map(model => ({
    ref: model.ref, name: model.name, provider: model.provider, providerName: model.providerName,
    reason: CLI_PROVIDER.test(model.ref) ? NODE_REASONS.cli() : NODE_REASONS.provider(),
  }))
  // `labels`: how the main names the models the node cannot run. The model picker's trigger reads it for a Bot whose
  // model is one of those, so the trigger and the greyed row call the same model by the same name.
  const labels = Object.fromEntries(unavailable.map(model => [model.ref, { name: model.name, providerName: model.providerName }]))
  return {
    roster: { ...roster, models: nodeModels.map(model => ({ ref: model.ref, provider: model.provider, name: model.name, providerName: model.provider, ...(Array.isArray(model.efforts) && model.efforts.length > 0 ? { efforts: model.efforts } : {}) })), labels },
    unavailable, notice: null,
  }
}

// The node's model list for a joined remote Bot: null until the host answers.
export function useNodeModels(bot, actions) {
  const [nodeModels, setNodeModels] = useState(null)
  const nodeId = bot.worker?.nodeId
  const remote = isJoinedRemote(bot) && Boolean(nodeId)
  useEffect(() => {
    if (!remote) return undefined
    let cancelled = false
    actions.botCreateTargets?.().then(res => {
      if (cancelled) return
      const node = pickTargets(res).find(target => target.nodeId === nodeId)
      setNodeModels(Array.isArray(node?.models) ? node.models : [])
    }).catch(() => { if (!cancelled) setNodeModels([]) })
    return () => { cancelled = true }
  }, [bot.id, remote, nodeId])
  return remote ? nodeModels : null
}

// ModelMenu with the node's list. The hook-free half is separate so a test can hand it a list.
export function NodeModelMenu({ bot, roster, actions, run, wide, nodeModels }) {
  const view = joinedModelView(bot, roster, nodeModels)
  return h(ModelMenu, { bot, roster: view.roster, actions, run, wide, unavailable: view.unavailable, notice: view.notice })
}

export function BotModelMenu({ bot, roster, actions, run, wide }) {
  return h(NodeModelMenu, { bot, roster, actions, run, wide, nodeModels: useNodeModels(bot, actions) })
}
