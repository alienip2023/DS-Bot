// The bot/create receiver must answer with the Bot's id (a non-empty string).
// roster.js createBot resolves to the Bot OBJECT (buildBot returns `bot`); the receiver once
// put that object into `remoteBotId`, the hub's validateBotCreateResult refused it, the
// ingest dropped the frame silently and the main waited 30s for a receipt that never came.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBotCreateReceiver } from '../src/host/joined-create.js'

// remote-agent's own validator, when its checkout sits beside this one (or DSH_REMOTE_AGENT_DIR).
async function hubValidator() {
  const dir = process.env.DSH_REMOTE_AGENT_DIR ?? resolve(import.meta.dirname, '..', '..', '..', 'dsh-remote-agent')
  const file = join(dir, 'lib', 'protocol.js')
  if (!existsSync(file)) return undefined
  return (await import(pathToFileURL(file).href)).validateBotCreateResult
}

// The shape roster.js buildBot really returns (state.bots[id]): `id` is the Session id.
const realBot = (opts, id = 'session-81c4bc08-5f0e-4d6f-9d0a-1b2c3d4e5f60') => ({
  id,
  name: opts.name,
  role: opts.role ?? '',
  model: opts.model ?? 'jina/jina-ai/jina-embeddings-v5-text-small',
  instructions: opts.instructions ?? '',
  createdAt: 1,
  createdBy: null,
  capabilities: [],
})

const receiverOf = createBot => createBotCreateReceiver({ state: { bots: {} }, createBot, warn() {} })

test('1. createBot resolves to a Bot object → remoteBotId is its id string and passes the hub validator', async () => {
  const accept = receiverOf(async opts => realBot(opts))
  const result = await accept({ name: 'test3', role: '测' })
  assert.equal(result.ok, true)
  assert.equal(typeof result.remoteBotId, 'string', 'remoteBotId must be a string, got ' + JSON.stringify(result.remoteBotId))
  assert.match(result.remoteBotId, /^session-/)
  assert.equal(result.name, 'test3')
  assert.equal(result.role, '测')
  // the same acceptance the hub applies, locally (requiredTurnId) …
  assert.ok(result.remoteBotId.trim() !== '')
  // … and remote-agent's own validateBotCreateResult when its checkout is beside this one.
  const validate = await hubValidator()
  if (validate) {
    const v = validate({ requestId: 'req-1', ...result })
    assert.equal(v.ok, true, 'hub validator refused the receipt: ' + JSON.stringify(v))
    assert.equal(v.result.remoteBotId, result.remoteBotId)
  }
})

test('2. name and role come from the created Bot, falling back to the request', async () => {
  const accept = receiverOf(async opts => ({ id: 'session-aaa', name: opts.name.toUpperCase() }))
  const result = await accept({ name: 'beta', role: 'qa' })
  assert.equal(result.name, 'BETA')
  assert.equal(result.role, 'qa')
})

test('3. createBot resolves to something with no id → bot-create-failed, never an empty or object remoteBotId', async () => {
  for (const returned of [{ name: 'x' }, { id: '' }, { id: '   ' }, { id: 42 }, undefined, null, 'session-old-style-string']) {
    const accept = receiverOf(async () => returned)
    const result = await accept({ name: 'x' })
    assert.equal(result.ok, false, 'must fail for ' + JSON.stringify(returned))
    assert.match(result.error, /^bot-create-failed: /)
    assert.equal('remoteBotId' in result, false)
  }
})

test('4. the failure reaches the hub as a valid receipt (ok:false + error), not as a dropped frame', async () => {
  const accept = receiverOf(async () => ({ name: 'x' }))
  const result = await accept({ name: 'x' })
  const validate = await hubValidator()
  if (validate) {
    const v = validate({ requestId: 'req-2', ...result })
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.equal(v.result.ok, false)
  }
  assert.equal(result.ok, false)
})
