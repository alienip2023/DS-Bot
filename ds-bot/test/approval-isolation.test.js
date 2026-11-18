// DS-3 characterization: approval isolation between two sessions of one Bot, answer
// ordering, and the one-turn-per-Bot gate across threads. No product edit; the binding is
// a stale-card guard, not a credential (docs/thread-model.md).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/approvals.js'
import { threadWorld, makeBot } from './thread-t2-world.js'

function harness({ noteApproval } = {}) {
  const handlers = []
  const warnings = []
  const rt = {
    ctx: { on: (_name, handler) => handlers.push(handler) },
    groupOwners: new Map(), chatOwners: new Map([['A', 'bot1'], ['B', 'bot1']]),
    warn: (...args) => warnings.push(args),
    ...(noteApproval ? { noteApproval } : {}),
  }
  install(rt)
  const ask = (sessionId, callId = 'c1') => handlers[0]({ agent: { session: { id: sessionId } }, toolName: 'shell', callId, reason: 'r', signal: new AbortController().signal }, () => new Promise(() => {}))
  return { rt, ask, warnings }
}
const rowOf = (rt, sessionId) => rt.approvalsView().find(row => row.sessionId === sessionId)
const bindingOf = row => ({ sessionId: row.sessionId, fingerprint: row.fingerprint })
const staleCode = error => error.code === 'bot/stale'
const open = async (promise) => { const state = { settled: false }; promise.then(() => { state.settled = true }); await new Promise(r => setImmediate(r)); return state }

function setup() {
  const h = harness()
  const a = h.ask('A', 'ca')
  const b = h.ask('B', 'cb')
  return { ...h, a, b, rowA: rowOf(h.rt, 'A'), rowB: rowOf(h.rt, 'B') }
}

test('1 binding with a different sessionId but A\'s own fingerprint is bot/stale and A stays pending', async () => {
  const { rt, a, rowA } = setup()
  assert.throws(() => rt.answerApproval(rowA.id, 'allow', { sessionId: 'B', fingerprint: rowA.fingerprint }), staleCode)
  assert.equal((await open(a)).settled, false)
  assert.equal(rowOf(rt, 'A')?.answerable, true)
})

test('1b binding with A\'s sessionId but a different fingerprint is bot/stale', async () => {
  const { rt, a, rowA } = setup()
  assert.throws(() => rt.answerApproval(rowA.id, 'allow', { sessionId: 'A', fingerprint: 'f'.repeat(64) }), staleCode)
  assert.equal((await open(a)).settled, false)
})

test('1c B\'s whole binding on A\'s id is bot/stale (both fields differ)', async () => {
  const { rt, a, rowA, rowB } = setup()
  assert.throws(() => rt.answerApproval(rowA.id, 'allow', bindingOf(rowB)), staleCode)
  assert.equal((await open(a)).settled, false)
})

test('2 cancelApprovals(A) leaves B answerable with its own binding', async () => {
  const { rt, a, rowA, rowB } = setup()
  rt.cancelApprovals('A')
  assert.equal(await a, 'cancelled')
  assert.equal(rowOf(rt, 'A'), undefined)
  assert.throws(() => rt.answerApproval(rowA.id, 'allow', bindingOf(rowA)), staleCode)
  const stillB = rowOf(rt, 'B')
  assert.equal(stillB.answerable, true)
  rt.answerApproval(rowB.id, 'allow', bindingOf(rowB))
})

test('2b B answers allowed-once after A was cancelled', async () => {
  const { rt, b, rowB } = setup()
  rt.cancelApprovals('A')
  rt.answerApproval(rowB.id, 'allow', bindingOf(rowB))
  assert.equal(await b, 'allowed-once')
})

test('3 two answers to one id: first wins, second is bot/stale', async () => {
  const log = []
  const { rt, ask } = harness({ noteApproval: (sessionId, value) => log.push(['note', sessionId, value]) })
  rt.onApproval(kind => log.push([kind]))
  const request = ask('A')
  request.then(outcome => log.push(['resolved', outcome]))
  const row = rowOf(rt, 'A')
  log.length = 0
  const results = ['allow', 'reject'].map((choice) => {
    try { rt.answerApproval(row.id, choice); return 'ok' } catch (error) { return error.code }
  })
  assert.deepEqual(results, ['ok', 'bot/stale'])
  assert.equal(await request, 'allowed-once')
  assert.deepEqual(log, [['note', 'A', undefined], ['settled'], ['resolved', 'allowed-once']])
})

test('4 a matching binding with an invalid choice is bot/invalid and leaves the request open', async () => {
  const { rt, a, rowA } = setup()
  assert.throws(() => rt.answerApproval(rowA.id, 'maybe', bindingOf(rowA)), error => error.code === 'bot/invalid')
  assert.equal((await open(a)).settled, false)
  assert.equal(rowOf(rt, 'A').answerable, true)
})

test('5 a settled id with a matching binding is bot/stale', async () => {
  const { rt, a, rowA } = setup()
  rt.answerApproval(rowA.id, 'reject', bindingOf(rowA))
  assert.equal(await a, 'rejected')
  assert.throws(() => rt.answerApproval(rowA.id, 'allow', bindingOf(rowA)), staleCode)
})

test('5b an unknown id with any binding is bot/stale', () => {
  const { rt, rowA } = setup()
  assert.throws(() => rt.answerApproval('nope', 'allow', bindingOf(rowA)), staleCode)
  assert.throws(() => rt.answerApproval(undefined, 'allow'), staleCode)
})

test('6 same bot, two threads: only one turn runs at a time', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const created = await w.call('thread-create', { botId: bot.id, title: 'Second' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const threadId = created.value.id ?? created.value.thread?.id
  assert.equal(typeof threadId, 'string')
  const first = await w.call('send', { sessionId: bot.id, text: 'first' })
  assert.equal(first.ok, true, JSON.stringify(first))
  const second = await w.call('send', { threadId, text: 'second' })
  assert.equal(second.ok, true, JSON.stringify(second))
  await new Promise(r => setTimeout(r, 20))
  const texts = () => w.prompts.map(entry => entry.request.content[0].text)
  assert.deepEqual(texts(), ['first'])
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 1)
  w.sessionEvent(bot.id, { type: 'turn/end', data: { turn: 1 }, time: Date.now() })
  await new Promise(r => setTimeout(r, 40))
  assert.deepEqual(texts(), ['first', 'second'])
})
