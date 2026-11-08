import test from 'node:test'
import assert from 'node:assert/strict'

// ── joined-turn.js: sendUser produces user+bot bubbles in chatPage ─────────────
test('6. acceptJoinedTurn: uses rt.sendUser so chatPage gets user bubble (knife: revert to deliver)', async () => {
  // This test exercises the node-side createBotTurnReceiver.
  // We use a minimal rt stub where sendUser is available and records the call.
  const { createBotTurnReceiver } = await import('../src/host/joined-turn.js')

  const sentUser = []
  const bot = { id: 'session-bot-abc', origin: 'local', worker: undefined }
  const rt = {
    state: { bots: { 'session-bot-abc': bot } },
    botOf(id) { return this.state.bots[id] },
    chatOf(id) { return id },
    settleJoinedTurn: null,
    sendUser: async (args) => { sentUser.push(args); return { ok: true } },
    warn: () => {},
  }

  const accept = createBotTurnReceiver(rt)
  const exchangeId = 'xid-001'

  // Trigger accept in background; settle the turn manually after sendUser is called
  const resultP = accept({ remoteBotId: 'session-bot-abc', exchangeId, text: 'Hello from hub' })

  // Wait for sendUser to be invoked
  await new Promise(r => setImmediate(r))

  assert.equal(sentUser.length, 1, 'rt.sendUser must be called (knife: revert to deliver → sentUser.length=0)')
  assert.equal(sentUser[0].content?.[0]?.text, 'Hello from hub', 'sendUser content must include original text')
  assert.equal(sentUser[0].requestId, exchangeId, 'requestId must equal exchangeId')

  // Settle the turn so the promise resolves
  if (typeof rt.settleJoinedTurn === 'function') {
    rt.settleJoinedTurn(exchangeId, 'Hi there!')
  }

  const result = await resultP
  // The result.text must be 'Hi there!' (the settled text)
  if (result.ok) {
    assert.equal(result.text, 'Hi there!', 'bot/turn-result text must equal settled reply')
  }
})

// ── config-source: multi-namespace + CLI skip ────────────────────────────────
test('7. buildConfigPayload: enumerates multi-namespace providers, skips claude-code/* and codex-cli/*', async () => {
  const { buildConfigPayload } = await import('../src/host/config-source.js')

  const fakeRefs = 'version: 1\nrefs:\n  PROV_A_KEY: sk-aaa\n  PROV_B_KEY: sk-bbb\n'
  const fakeEntries = [
    { provider: 'prov-a', settingsNs: 'ns-a', settingsPath: ['providers', 'prov-a'], api: undefined },
    { provider: 'prov-b', settingsNs: 'ns-b', settingsPath: ['providers', 'prov-b'], api: undefined },
    { provider: 'claude-code/local', settingsNs: 'ns-cc', settingsPath: [], api: undefined },  // CLI → skip
    { provider: 'codex-cli/local', settingsNs: 'ns-cx', settingsPath: [], api: undefined },    // CLI → skip
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
