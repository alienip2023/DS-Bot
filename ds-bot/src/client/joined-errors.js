import { t } from './i18n.js'

// The host refuses a change to a remote (joined) Bot with the node's own reason code
// ('bot-update-model-unknown', 'node-offline', ...). The drawer shows an error where the user
// acted, so the code becomes a sentence: an unknown reason still says the node refused and why.
export const isJoinedRemote = bot => bot?.origin === 'joined' && bot?.worker?.home === 'remote'

// Why a control that only exists where the Bot runs is off for a node Bot. The same sentence is what
// the host refuses such a change with, so a call that gets through anyway reads the same.
export const nodeOnlyReason = () => t('This Bot runs on a node: change it there')

export function joinedUpdateErrorText(raw) {
  const reason = String(raw ?? '').trim()
  switch (reason) {
    case 'bot-update-model-unknown': return t('The node has no provider for this model. Pick a model the node already has.')
    case 'bot-update-workdir-denied': return t('The node does not allow this working folder. Pick a folder the node allows.')
    case 'node-offline':
    case 'bridge-down': return t('The node is offline, so the change did not reach it. Try again when it is back.')
    case 'bot-update-timeout': return t('The node did not answer in time, so the change may not have applied. Try again in a moment.')
    case 'bot-update-not-found': return t('The node cannot find this Bot.')
    case 'This Bot runs on a node: change it there': return nodeOnlyReason()
    default: return t('The node refused this change: {reason}', { reason: reason.replace(/^bot-update-failed:\s*/, '') || t('unknown reason') })
  }
}

// A failed update of a joined remote Bot, as an error whose message is that sentence (code kept).
export function joinedUpdateError(error, bot) {
  if (!isJoinedRemote(bot) || error?.code !== 'bot/refused') return error
  return Object.assign(new Error(joinedUpdateErrorText(error.message)), { code: error.code, cause: error })
}
