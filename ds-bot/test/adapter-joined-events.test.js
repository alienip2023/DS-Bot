// DS-3 carryover criterion 4: the joined dispatch crosses LocalAgentAdapter.screenEvent.
// Chain driven here: the real createBotTurnReceiver -> rt.sendUser -> a real DSH agent loop
// -> real LocalAgentAdapter.stream() -> the loop's idle -> the real settleJoinForTurn ->
// rt.settleJoinedTurn -> the receiver's result.
// STAND-IN: `rt.sendUser` and the turn-end settle caller below replace the production
// createRuntime / turns.js chain, which stays uncovered by this file.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { createBotTurnReceiver } from '../src/host/joined-turn.js'
import { settleJoinForTurn } from '../src/host/turns.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const SENTINEL = 'SECRET-TOKEN-sk-123456'
const tmp = () => mkdtempSync(join(tmpdir(), 'dsb-je-'))

function stubEngine(script) {
  const queue = []
  const waiters = []
  const push = (event) => { const w = waiters.shift(); if (w) w(event); else queue.push(event) }
  const session = { next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise(r => waiters.push(r))), dead: false }
  return { open: async () => session, prompt: async () => { for (const event of script) push(event) }, supportsImages: () => false }
}

async function boot({ script } = {}) {
  const warns = []
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new LocalAgentAdapter({
    rt: { warn: message => warns.push(String(message)), ctx },
    customAgents: () => [{ id: 'fake', name: 'Fake', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => (script === undefined
      ? new AcpEngine(route, { ...spec, command: process.execPath, args: [FIXTURE] }, { findExecutable: path => path })
      : stubEngine(script)),
    record: () => undefined, saveRecord: () => {}, presetFor: () => 'workspace-write',
    cwdFor: async () => tmp(), probeCwd: () => tmp(), toolsFor: () => [],
  })
  // Forwarding spy on the instance: which event objects crossed screenEvent.
  const seen = []
  const original = adapter.screenEvent.bind(adapter)
  adapter.screenEvent = (live, event) => { seen.push(event); return original(live, event) }
  ctx.llm.registerAdapter(['local-acp-fake'], adapter)
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('s1'), { provider: 'local-acp-fake', model: 'default' })
  const textOf = () => agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    .map(event => (event.data.message.content ?? []).map(block => block.text ?? '').join('')).join('')
  const finishOf = () => agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason
  const rt = {
    state: { bots: { b1: { id: 'b1', name: 'Bot', type: 'local' } } },
    chatOf: () => 's1',
    warn: () => {},
    // Stand-in for the production sendUser + turns.js turn-end settle caller.
    sendUser: ({ content, requestId }) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== agent || status !== 'idle') return
        dispose()
        settleJoinForTurn(rt, { rpcId: requestId }, textOf())
      })
      agent.followup(createUserMessage({ content, source: { kind: 'user', rpcId: requestId } }))
    },
  }
  const accept = createBotTurnReceiver(rt)
  const stop = async () => {
    for (const live of [...adapter.live.values()]) await adapter.closeLive(live, { idle: true }).catch(() => {})
    await adapter.dispose(); await ctx.fiber.dispose()
  }
  return { accept, adapter, agent, seen, warns, textOf, finishOf, stop }
}
const turn = text => ({ remoteBotId: 'b1', exchangeId: 'ex-1', text })
const seenAll = (seen, scripted) => {
  assert.ok(seen.length >= scripted.length, `screenEvent saw ${seen.length} < ${scripted.length}`)
  for (const event of scripted) assert.ok(seen.includes(event), 'a scripted event crossed screenEvent')
}

test('14a valid parity with the real engine through the joined turn', async (t) => {
  const h = await boot()
  t.after(h.stop)
  await h.accept(turn('kick off'))
  const result = await h.accept({ ...turn('hello there'), exchangeId: 'ex-2' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.exchangeId, 'ex-2')
  assert.match(result.text, /ok: .*hello there/)
  assert.ok(h.seen.length >= 6, `screenEvent calls: ${h.seen.length}`)
  assert.ok(h.seen.every(event => event !== null && typeof event === 'object'))
  assert.equal(h.adapter.eventDiscards ?? 0, 0)
  assert.deepEqual(h.warns, [])
  assert.equal(h.finishOf()?.kind, 'completed')
})

test('14b valid parity with a scripted engine', async (t) => {
  const scripted = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'done', reason: 'stop' }]
  const h = await boot({ script: scripted })
  t.after(h.stop)
  const result = await h.accept(turn('go'))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.text, 'ab')
  assert.equal(h.finishOf()?.kind, 'completed')
  assert.deepEqual(h.warns, [])
  seenAll(h.seen, scripted)
})

test('14c malformed events are dropped; one rate-limited warning, nothing pending or allowed', async (t) => {
  const replies = []
  const permission = { type: 'permission', id: 'p1', reply: value => replies.push(value) }
  const noFn = { type: 'permission', id: 'p2', reply: 'not-a-function' }
  const scripted = [{ type: 'text', text: 'a' }, null, { type: 'bogus', text: SENTINEL }, noFn, { type: 'text', text: 'b' }, { type: 'done', reason: 'stop' }]
  const h = await boot({ script: scripted })
  t.after(h.stop)
  const result = await h.accept(turn('go'))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.text, 'ab')
  assert.equal(h.adapter.eventDiscards, 3)
  assert.equal(h.warns.length, 1)
  assert.ok(!h.warns[0].includes(SENTINEL), 'the warning never carries event content')
  seenAll(h.seen, scripted.filter(event => event !== null))
  assert.ok(h.seen.includes(null))
  // A well-formed-shape permission with a function reply is answered null (never allowed).
  assert.equal(h.adapter.screenEvent({}, { type: 'permission', id: 'p1', reply: permission.reply, options: 'bad' }), false)
  assert.deepEqual(replies, [null])
})
