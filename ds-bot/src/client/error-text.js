// The text a failed call shows: a known code is shown in the reader's language, because
// the host's own sentence is English. An unknown code keeps the host's message.
import { hostText, t } from './i18n.js'

const BY_CODE = {
  'memory/federation-requires-node': () => t('Federated memory needs a node joined to a hub. This machine has no node identity, so the Bot keeps its memory here.'),
  'memory/federation-unsupported': () => t('Federated memory is not available here: this machine is not a node, or the hub does not support it. Nothing was saved.'),
  'bot-create-model-unknown': () => t('This machine does not have the selected model. Pick another one.'),
  'bot-create-model-no-key': () => t('This machine has the model, but its provider has no key. Add the key on that machine, or pick another model.'),
  'node-unknown': () => t('That machine is no longer connected. Pick another one.'),
  'bot-create-unavailable': () => t('Creating a Bot on a remote machine is not available here.'),
  'bot-create-workdir-denied': () => t('That folder is outside the folders this machine allows. Pick one inside them.'),
  'bot-create-name-missing': () => t('A Bot needs a name.'),
  'bot-create-nodeId-missing': () => t('Pick a machine first.'),
  'bridge-down': () => t('The connection to that machine is down. Try again when it is back.'),
}

export function failureText(failure) {
  const code = typeof failure?.code === 'string' ? failure.code : undefined
  const message = typeof failure?.message === 'string' ? failure.message : undefined
  // create-bot wraps the specific code in message and sends code 'bot/refused'.
  const localize = (code !== undefined ? BY_CODE[code] : undefined) ?? (message !== undefined ? BY_CODE[message] : undefined)
  if (localize !== undefined) return localize()
  return hostText(message ?? String(failure))
}
