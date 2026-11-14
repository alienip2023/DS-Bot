import test from 'node:test'
import assert from 'node:assert/strict'
import { joinedChatPage, joinedUpdateBot, createBotUpdateReceiver } from '../src/host/joined-page.js'
import { NodeRegistry } from '/Users/kjclaw/Library/Application Support/dsh-desktop/harness/bot/workspace/roster-join-3/dsh-remote-agent/lib/hub/node-registry.js'
import { HUB_TO_NODE, NODE_TO_HUB } from '/Users/kjclaw/Library/Application Support/dsh-desktop/harness/bot/workspace/roster-join-3/dsh-remote-agent/lib/protocol.js'

// helpers
function makeRt(overrides = {}) {
  return {
    state: { bots: {} },
    botOf(id) { return this.state.bots[id] },
    ctx: { get: () => undefined },
    ...overrides,
  }
}

function makeJoinedBot(nodeId = 'n1', remoteBotId = 'session-a') {
  const id = `joined:${nodeId}:${remoteBotId}`
  return { id, origin: 'joined', worker: { nodeId, remoteBotId, home: 'remote' } }
}

// ── 1. bot-create-targets includes models from node catalog ────────────────────
// (channel.js test — knife: strip models from registry node → models array empty)
test('1. joinedUpdateBot: routes through registry.send with correct payload', async () => {
  const relay = { ready: true, send: () => true }
  const registry = new NodeRegistry({ log() {}, relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0, e2e: null })

  const sent = []
  registry.send = (nid, type, data) => { sent.push({ nid, type, data }); return true }

  const bot = makeJoinedBot()
  const rt = makeRt({
    botOf(id) { return id === bot.id ? bot : undefined },
    ctx: { get: (n) => n === 'remote-agent:registry' ? registry : undefined },
  })
  registry.onlineNodes = () => [{ nodeId: 'n1' }]

  // Trigger joinedUpdateBot — registry.send should be called
  const p = joinedUpdateBot(rt, bot.id, { model: 'prov/model-x', effort: null, instructions: null, workDir: null })
  // Let registry emit the result
  await new Promise(r => setImmediate(r))
  if (sent.length > 0) {
    const reqId = sent[0].data.requestId
    registry.emit('botUpdateResult', { requestId: reqId, ok: true, model: 'prov/model-x', effort: null, instructions: null, workDir: null })
  }
  const result = await p
  assert.equal(result.ok, true, 'joinedUpdateBot must succeed (knife: remove registry.send call → sent.length=0 → timeout → fail)')
  assert.equal(sent.length, 1, 'registry.send must be called once')
  assert.equal(sent[0].data.model, 'prov/model-x')
})

// ── 2. node catalog validation: unknown model → bot-create-model-unknown ───────
test('2. createBotOnNode: unknown model ref → returns bot-create-model-unknown without dispatching', async () => {
  // Test the validation logic directly: if nodeRec.models is set and does not include the ref → reject
  const relay = { ready: true, send: () => true }
  const registry = new NodeRegistry({ log() {}, relay })
  // Online node with known models
  const nodeRec = { nodeId: 'n1', online: true, lastSeen: 0, e2e: null, models: [{ ref: 'prov/model-good', provider: 'prov', id: 'model-good', name: 'Good' }] }
  registry.nodes.set('n1', nodeRec)
  registry.onlineNodes = () => [nodeRec]
  const sent = []
  registry.send = (nid, type, data) => { sent.push({ nid, type, data }); return true }

  const { createBotOnNode } = await import('../src/host/joined-create.js')
  const rt = makeRt({
    ctx: { get: (n) => n === 'remote-agent:registry' ? registry : undefined },
    botCreateTimeoutMs: 200,
  })

  const result = await createBotOnNode(rt, { nodeId: 'n1', name: 'Alpha', role: '', modelRef: 'prov/bad-model' })
  assert.equal(result.ok, false, 'must fail for unknown model (knife: remove catalog check → ok:true)')
  assert.equal(result.error, 'bot-create-model-unknown', 'error code must be bot-create-model-unknown')
  assert.equal(sent.length, 0, 'registry.send must NOT be called for unknown model')
})

// A model only the node serves is not in the hub catalog. Resolving it here rejects the
// create before it is sent; the node's own catalog already named the ref exactly.
test('2b. createBotOnNode: a model only the node serves is sent as-is and written on the shadow row', async () => {
  const relay = { ready: true, send: () => true }
  const registry = new NodeRegistry({ log() {}, relay })
  const nodeRec = { nodeId: 'n1', online: true, lastSeen: 0, e2e: null, models: [{ ref: 'node/only', provider: 'node', id: 'only', name: 'Only' }] }
  registry.nodes.set('n1', nodeRec)
  registry.onlineNodes = () => [nodeRec]
  const sent = []
  registry.send = (nid, type, data) => {
    sent.push({ nid, type, data })
    Promise.resolve().then(() => registry.emit('botCreateResult', { requestId: data.requestId, ok: true, remoteBotId: 'bot-created', name: data.name, role: data.role ?? '' }))
    return true
  }

  const { createBotOnNode } = await import('../src/host/joined-create.js')
  const { shadowId } = await import('../src/host/roster-join.js')
  const rt = makeRt({
    ctx: { get: (n) => n === 'remote-agent:registry' ? registry : undefined },
    botCreateTimeoutMs: 200,
    save() {},
    // The hub does not serve this model. Resolving it must not run for a ref the node listed.
    resolveModel: async () => { throw new Error('Model node/only is not available') },
  })

  const result = await createBotOnNode(rt, { nodeId: 'n1', name: 'Alpha', role: '', modelRef: 'node/only' })
  assert.equal(result.ok, true, `a node-only model must be created, got ${result.error}`)
  assert.equal(sent.length, 1, 'the create must be dispatched')
  assert.equal(sent[0].data.modelRef, 'node/only', 'the frame keeps the node ref, not a hub resolution')
  assert.equal(rt.state.bots[shadowId('n1', 'bot-created')].model, 'node/only')
})

// ── 3. createBotUpdateReceiver: node-side updates bot and returns profile ──────
test('3. createBotUpdateReceiver: updates bot and returns profile', async () => {
  const updated = []
  // Provide a fake llm so model validation passes
  const fakeCtx = { get: (n) => n === 'llm' ? { listProviders: () => [{ id: 'prov' }] } : undefined }
  const rt = makeRt({
    ctx: fakeCtx,
    updateBot: async (id, patch) => { updated.push({ id, patch }); return { model: patch.model ?? 'old', effort: null, instructions: null, workDir: null } },
  })
  const receiver = createBotUpdateReceiver(rt)
  const result = await receiver({ remoteBotId: 'session-a', model: 'prov/model-new', effort: null, instructions: null, workDir: null })
  assert.equal(result.ok, true)
  assert.equal(result.model, 'prov/model-new')
  assert.equal(updated.length, 1)
  assert.equal(updated[0].id, 'session-a')
})

test('4. createBotUpdateReceiver: bot-not-found → ok:false', async () => {
  // Provide llm stub so model validation passes, then updateBot returns null
  const fakeCtx = { get: (n) => n === 'llm' ? { listProviders: () => [{ id: 'prov' }] } : undefined }
  const rt = makeRt({ ctx: fakeCtx, updateBot: async () => null })
  const receiver = createBotUpdateReceiver(rt)
  const result = await receiver({ remoteBotId: 'session-missing', model: 'prov/m', effort: null, instructions: null, workDir: null })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bot-update-not-found')
})

// ── 5. joinedUpdateBot: offline node → returns error without dispatching ───────
test('5. joinedUpdateBot: offline node → node-offline error, no send', async () => {
  const relay = { ready: true, send: () => true }
  const registry = new NodeRegistry({ log() {}, relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: false, lastSeen: 0, e2e: null })
  registry.onlineNodes = () => []  // no online nodes
  const sent = []
  registry.send = (nid, type, data) => { sent.push({ nid, type, data }); return true }

  const bot = makeJoinedBot()
  const rt = makeRt({
    botOf(id) { return id === bot.id ? bot : undefined },
    ctx: { get: (n) => n === 'remote-agent:registry' ? registry : undefined },
  })

  const result = await joinedUpdateBot(rt, bot.id, { model: 'prov/model-x', effort: null, instructions: null, workDir: null })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'node-offline')
  assert.equal(sent.length, 0, 'must not send if node offline')
})
