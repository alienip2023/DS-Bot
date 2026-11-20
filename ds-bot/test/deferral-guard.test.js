import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { detectDeferral } from '../src/host/deferral-guard.js'

const examples = [
  ['今夜再处理。', '今夜'],
  ['我明早再看。', '明早'],
  ['我今晚会继续。', '今晚'],
  ['I’ll WAIT until the server is ready.', 'WAIT until'],
  ['I’ll check again tomorrow morning.', 'tomorrow morning'],
]

test('returns the original deferral fragment from Chinese and English replies', () => {
  for (const [text, match] of examples) assert.equal(detectDeferral(text), match)
  assert.equal(detectDeferral('今晚再做，明早验收。'), '今晚')
})

test('ignores immediate work, partial English words and missing text', () => {
  for (const text of ['I am checking now.', 'Completed.', 'await untilDone()', '', null, undefined]) {
    assert.equal(detectDeferral(text), null)
  }
})

test('a deferring member reply adds one room notice without retrying the turn', { timeout: 3000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-deferral-'))
  const ctx = fakeContext()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Chief', sessionId: 'a' } },
    rooms: { r: { id: 'r', name: 'Ops', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga' }, log: [], seq: 0, seen: {} } },
  }))
  const sent = []
  let called
  const delivery = new Promise(resolve => { called = resolve })
  ctx.workspaceRegistry = { get: () => undefined }
  ctx.sessionController = { resolveAgent: async id => ({ agent: {
    session: { id }, followup(message) { sent.push(message); called(message.source) }, cancel() {},
  } }) }
  ctx.sessions = { flush: async () => {} }
  const rt = createRuntime(ctx, { home })
  await rt.load()
  const emit = async (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id }, { type, data })
  }
  await emit('r', 'user/message', { content: [{ type: 'text', text: 'Can you check this tomorrow morning?' }], source: { kind: 'user' } })
  const abort = new AbortController()
  t.after(() => abort.abort())
  const relay = rt.teamTools.find(tool => tool.name === 'group_relay')
  const round = relay.execute({}, { agent: { id: 'r' }, callId: 'r1', signal: abort.signal })
  const source = await delivery
  await emit('ga', 'turn/start', { turn: 1 })
  await emit('ga', 'user/message', { content: [{ type: 'text', text: 'Your turn' }], source })
  await emit('ga', 'assistant/message', { message: { content: [{ type: 'text', text: 'I will check tomorrow morning.' }] } })
  await emit('ga', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await round
  const lines = rt.roomOf('r').log
  assert.deepEqual(lines.slice(-2).map(line => line.text), ['I will check tomorrow morning.', '现在做，或写明等什么。'])
  assert.equal(lines.filter(line => line.reason === 'deferral').length, 1)
  assert.ok(rt.groupRows('r', 1).some(row => row.text === '现在做，或写明等什么。'))
  assert.equal(sent.length, 1)
})
