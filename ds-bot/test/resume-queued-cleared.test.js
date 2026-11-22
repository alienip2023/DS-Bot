// A message noted in inflight.json is done with once it landed: a node has it (dispatch
// succeeded), or a Session recorded it. Messages that did not reach anyone stay noted, so the
// next start sends them again. (REPORT-queued-notes-not-cleared-2026-11-22)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import './harness-resolve.mjs'
import { fakeContext } from './fake-ctx.js'

const { install } = await import('../src/host/resume.js')

const NODE_BOT = { id: 'joined:n1:rb1', origin: 'joined', type: 'remote-worker', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } }
const LOCAL_BOT = { id: 'local', type: 'bot' }

function start(t, deliver) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-queued-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const ctx = fakeContext()
  const rt = {
    ctx, home,
    load: async () => {},
    readOnly: () => undefined,
    botOf: id => [NODE_BOT, LOCAL_BOT].find(bot => bot.id === id),
    chatOf: id => `chat-${id}`, isBotSession: () => false, selfOf: () => undefined,
    resolveAgent: async () => ({ inbox: { nextStep: [], nextTurn: [] } }),
    deliver,
    warn: () => {}, noteFailure: () => {},
  }
  install(rt)
  const queuedNow = async () => { await ctx.dispose(); return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')).queued }
  // fakeContext.emit skips two-argument listeners, so the Session event is fed to them directly.
  const event = (session, data) => { for (const listener of ctx.listeners.get('session/event') ?? []) listener(session, data) }
  return { rt, ctx, event, queuedNow }
}

test('a request the node accepted is not kept for a resend', async (t) => {
  const h = start(t, async args => args.exchangeId)
  await h.rt.deliver({ toId: NODE_BOT.id, sessionId: 'mirror-1', role: 'request', text: 'work', exchangeId: 'x1' })
  assert.deepEqual(await h.queuedNow(), {})
})

test('a dispatch that did not reach the node stays noted (offline node)', async (t) => {
  const h = start(t, async () => ({ ok: false, error: 'bridge-down' }))
  await h.rt.deliver({ toId: NODE_BOT.id, sessionId: 'mirror-1', role: 'request', text: 'work', exchangeId: 'x2' })
  const queued = await h.queuedNow()
  assert.deepEqual(queued['mirror-1'].map(item => item.args.exchangeId), ['x2'])
})

test('a delivery that throws stays noted', async (t) => {
  const h = start(t, async () => { throw new Error('socket closed') })
  await assert.rejects(h.rt.deliver({ toId: NODE_BOT.id, sessionId: 'mirror-1', role: 'request', text: 'work', exchangeId: 'x3' }))
  assert.deepEqual((await h.queuedNow())['mirror-1'].map(item => item.args.exchangeId), ['x3'])
})

test('a local message is cleared when the Bot takes it up, not when it is only shown', async (t) => {
  const h = start(t, async args => args.exchangeId)
  await h.rt.deliver({ toId: LOCAL_BOT.id, role: 'reply', text: 'answer', exchangeId: 'x4' })
  // delivery.js first writes the text the user is shown (kind 'user'); the turn is still owed.
  h.event({ id: 'chat-local' }, { type: 'user/message', data: { source: { kind: 'user', exchangeId: 'x4' } } })
  // Then the empty wake the agent takes up, which keeps kind 'bot'.
  h.event({ id: 'chat-local' }, { type: 'user/message', data: { source: { kind: 'bot', exchangeId: 'x4', deferred: true } } })
  assert.deepEqual(await h.queuedNow(), {})
})

test('a shown-only message keeps its note: a restart before the wake is taken still owes the turn', async (t) => {
  const h = start(t, async args => args.exchangeId)
  await h.rt.deliver({ toId: LOCAL_BOT.id, role: 'reply', text: 'answer', exchangeId: 'x5' })
  h.event({ id: 'chat-local' }, { type: 'user/message', data: { source: { kind: 'user', exchangeId: 'x5' } } })
  assert.deepEqual((await h.queuedNow())['chat-local'].map(item => item.args.exchangeId), ['x5'])
})

test('a message the user typed (no exchangeId) clears nothing', async (t) => {
  const h = start(t, async args => args.exchangeId)
  await h.rt.deliver({ toId: LOCAL_BOT.id, role: 'reply', text: 'answer', exchangeId: 'x6' })
  h.event({ id: 'chat-local' }, { type: 'user/message', data: { source: { kind: 'user' } } })
  assert.deepEqual((await h.queuedNow())['chat-local'].map(item => item.args.exchangeId), ['x6'])
})
