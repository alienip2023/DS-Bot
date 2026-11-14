// The host's federation refusals are English sentences; a client that knows the code
// shows the localized sentence instead, and anything else keeps the host's text.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failureText } from '../src/client/error-text.js'

const coded = (message, code) => Object.assign(new Error(message), { code })

test('a federation refusal without a node is shown in local wording', () => {
  const error = coded('Federated memory only exists on a node joined to a hub; this machine has no node identity, so it keeps memory locally instead.', 'memory/federation-requires-node')
  assert.equal(failureText(error), 'Federated memory needs a node joined to a hub. This machine has no node identity, so the Bot keeps its memory here.')
})

test('a hub that cannot federate is shown in local wording', () => {
  const error = coded('Federated memory is not available on this machine.', 'memory/federation-unsupported')
  assert.equal(failureText(error), 'Federated memory is not available here: this machine is not a node, or the hub does not support it. Nothing was saved.')
})

test('an unknown code keeps the host message', () => {
  assert.equal(failureText(coded('Something broke.', 'memory/other')), 'Something broke.')
  assert.equal(failureText(new Error('No code here.')), 'No code here.')
})

test('a node that lacks the chosen model is shown in local wording', () => {
  assert.equal(
    failureText(coded('bot-create-model-unknown', 'bot/refused')),
    'This machine does not have the selected model. Pick another one.',
  )
})

test('a node whose provider has no key is shown in local wording', () => {
  assert.equal(
    failureText(coded('bot-create-model-no-key', 'bot/refused')),
    'This machine has the model, but its provider has no key. Add the key on that machine, or pick another model.',
  )
})

test('a create without a name is shown in local wording', () => {
  assert.equal(
    failureText(coded('bot-create-name-missing', 'bot/refused')),
    'A Bot needs a name.',
  )
})

test('a create without a machine is shown in local wording', () => {
  assert.equal(
    failureText(coded('bot-create-nodeId-missing', 'bot/refused')),
    'Pick a machine first.',
  )
})

test('a bridge that is down is shown in local wording', () => {
  assert.equal(
    failureText(coded('bridge-down', 'bot/refused')),
    'The connection to that machine is down. Try again when it is back.',
  )
})

test('a node that dropped offline is shown in local wording', () => {
  assert.equal(
    failureText(coded('node-unknown', 'bot/refused')),
    'That machine is no longer connected. Pick another one.',
  )
})
