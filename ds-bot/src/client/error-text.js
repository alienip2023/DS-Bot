// The text a failed call shows: a known code is shown in the reader's language, because
// the host's own sentence is English. An unknown code keeps the host's message.
import { hostText, t } from './i18n.js'

const BY_CODE = {
  'memory/federation-requires-node': () => t('Federated memory needs a node joined to a hub. This machine has no node identity, so the Bot keeps its memory here.'),
  'memory/federation-unsupported': () => t('Federated memory is not available here: this machine is not a node, or the hub does not support it. Nothing was saved.'),
}

export function failureText(failure) {
  const code = typeof failure?.code === 'string' ? failure.code : undefined
  const localize = code === undefined ? undefined : BY_CODE[code]
  if (localize !== undefined) return localize()
  return hostText(failure?.message ?? String(failure))
}
