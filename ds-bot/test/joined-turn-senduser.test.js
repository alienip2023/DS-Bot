import test from 'node:test'
import assert from 'node:assert/strict'

// ── settleJoinForTurn: field chain rpcId → requestId → exchangeId ─────────────
// Knife: change to only read info.requestId → rpcId test must fail (settle not called)
test('6a. settleJoinForTurn: rpcId fires settle', async () => {
  const { settleJoinForTurn } = await import('../src/host/turns.js')
  let settled = null
  const rt = { settleJoinedTurn: (id, reply) => { settled = { id, reply }; return true } }
  const result = settleJoinForTurn(rt, { rpcId: 'rpc-1' }, 'reply text', undefined)
  assert.equal(result, true, 'must return true when settle finds a match')
  assert.equal(settled?.id, 'rpc-1', 'must pass rpcId to settleJoinedTurn')
})

test('6b. settleJoinForTurn: requestId fires settle when rpcId absent', async () => {
  const { settleJoinForTurn } = await import('../src/host/turns.js')
  let settled = null
  const rt = { settleJoinedTurn: (id, reply) => { settled = { id, reply }; return true } }
  const result = settleJoinForTurn(rt, { requestId: 'req-2' }, 'reply text', undefined)
  assert.equal(result, true, 'must return true when requestId matches')
  assert.equal(settled?.id, 'req-2', 'must pass requestId to settleJoinedTurn')
})

test('6c. settleJoinForTurn: exchangeId fires settle when rpcId and requestId absent', async () => {
  const { settleJoinForTurn } = await import('../src/host/turns.js')
  let settled = null
  const rt = { settleJoinedTurn: (id, reply) => { settled = { id, reply }; return true } }
  const result = settleJoinForTurn(rt, { exchangeId: 'exc-3' }, 'reply text', undefined)
  assert.equal(result, true, 'must return true when exchangeId matches')
  assert.equal(settled?.id, 'exc-3', 'must pass exchangeId to settleJoinedTurn')
})

test('6d. settleJoinForTurn: empty info returns false → falls through to finish', async () => {
  const { settleJoinForTurn } = await import('../src/host/turns.js')
  let calledSettle = false
  const rt = { settleJoinedTurn: () => { calledSettle = true; return false } }
  const result = settleJoinForTurn(rt, {}, 'reply', undefined)
  assert.equal(result, false, 'must return false when no id field present')
  assert.equal(calledSettle, false, 'settleJoinedTurn must not be called with empty id')
})

// ── joined-turn.js: sendUser → settle via rpcId (no manual settle) ─────────────
// The rt stub simulates turns.js: after sendUser, it calls settleJoinedTurn with the
// rpcId (= requestId passed to sendUser), mirroring dsh-api-session-controller:749.
// No manual settle — settle is triggered only by simulated turn completion.
// Knife: revert joined-turn.js to rt.deliver({role:'request'}) → sendUser not called
//        → rpcId never registered → settle never fires → timeout → ok:false
test('6. acceptJoinedTurn: sendUser → turn completes via rpcId → result returned (no manual settle)', async () => {
  const { createBotTurnReceiver } = await import('../src/host/joined-turn.js')

  const sentUser = []
  const bot = { id: 'session-bot-abc', origin: 'local', worker: undefined }
  const rt = {
    state: { bots: { 'session-bot-abc': bot } },
    botOf(id) { return this.state.bots[id] },
    chatOf(id) { return id },
    settleJoinedTurn: null, // set by createBotTurnReceiver
    sendUser: async (args) => {
      sentUser.push(args)
      // Simulate turns.js finishing the turn: source.rpcId === args.requestId
      // settleJoinForTurn reads info.rpcId, so we call settleJoinedTurn with args.requestId
      const rpcId = args.requestId
      setImmediate(() => {
        if (typeof rt.settleJoinedTurn === 'function') {
          rt.settleJoinedTurn(rpcId, 'The bot replied with this text.')
        }
      })
      return { ok: true }
    },
    warn: () => {},
  }

  const accept = createBotTurnReceiver(rt, { timeoutMs: 500 })
  const exchangeId = 'xid-001'

  const result = await accept({ remoteBotId: 'session-bot-abc', exchangeId, text: 'Hello from hub' })

  assert.equal(sentUser.length, 1, 'rt.sendUser must be called once')
  assert.equal(sentUser[0].content?.[0]?.text, 'Hello from hub', 'sendUser content must include original text')
  assert.equal(sentUser[0].requestId, exchangeId, 'requestId must equal exchangeId')
  assert.equal(result.ok, true, 'accept must return ok:true when turn settles via rpcId')
  assert.equal(result.text, 'The bot replied with this text.', 'bot/turn-result text must equal settled reply')
})

// ── config-source: multi-namespace + CLI skip ─────────────────────────────────
test('7. buildConfigPayload: enumerates multi-namespace providers, skips claude-code/* and codex-cli/*', async () => {
  const { buildConfigPayload } = await import('../src/host/config-source.js')

  const fakeEntries = [
    { provider: 'prov-a', settingsNs: 'ns-a', settingsPath: ['providers', 'prov-a'], api: undefined },
    { provider: 'prov-b', settingsNs: 'ns-b', settingsPath: ['providers', 'prov-b'], api: undefined },
    { provider: 'claude-code/local', settingsNs: 'ns-cc', settingsPath: [], api: undefined },
    { provider: 'codex-cli/local', settingsNs: 'ns-cx', settingsPath: [], api: undefined },
  ]
  const fakeSections = new Map([
    ['ns-a', { ns: 'ns-a', value: { providers: { 'prov-a': { api: 'openai', apiKeyEnv: 'PROV_A_KEY', models: [{ id: 'model-1', name: 'Model One' }] } } } }],
    ['ns-b', { ns: 'ns-b', value: { providers: { 'prov-b': { api: 'anthropic-messages', baseURL: 'https://example.com', apiKeyEnv: 'PROV_B_KEY', models: [] } } } }],
  ])

  const rt = {
    ctx: {
      get: (n) => {
        if (n === 'settings') return { describe: () => [...fakeSections.values()] }
        return undefined
      },
      llm: { listConfigurableProviders: () => fakeEntries },
    },
    warn: () => {},
  }
  const payload = buildConfigPayload(rt, { defaultModel: null, readRefs: () => new Map([['PROV_A_KEY', 'sk-aaa'], ['PROV_B_KEY', 'sk-bbb']]) })

  assert.equal(payload.providers.length, 2, 'CLI providers must be skipped (knife: remove LOCAL_CLI_PREFIX skip → length=4)')
  const ids = payload.providers.map(p => p.id)
  assert.ok(ids.includes('prov-a'), 'prov-a must be included')
  assert.ok(ids.includes('prov-b'), 'prov-b must be included')
  assert.ok(!ids.includes('claude-code/local'), 'claude-code/local must be skipped')
  assert.ok(!ids.includes('codex-cli/local'), 'codex-cli/local must be skipped')
  assert.equal(payload.providers.find(p => p.id === 'prov-a')?.apiKey, 'sk-aaa')
})
