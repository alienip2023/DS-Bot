// A retried Bot-to-Bot dispatch carries the same exchange id. The ledger keeps one row for it,
// an answer closes the work, and a replay that failed says nothing the sender has not heard.
import test from 'node:test'
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleJoinedTurn, BRIDGE_DOWN_TEXT } from '../src/host/joined-turn.js'
import { shadowId } from '../src/host/roster-join.js'
import { install as installHandoffs } from '../src/host/handoffs.js'
import { DELEGATE_TIMEOUT_MS } from '../src/host/constants.js'

const { Session } = await import('@deepseek-ai/dsh-session')

const settle = () => new Promise(resolve => setImmediate(resolve))

// A real registry emitter, a real mirror Session, and the real hand-offs module: what a retried
// delivery does to the ledger and to the work it answers is what the product does.
function makeLedgerWorld({ timeoutMs = 50, sendResult = true } = {}) {
  const emitter = new EventEmitter()
  const frames = []
  const replies = []
  const warnings = []
  const shadow = {
    id: shadowId('n1', 'rb1'),
    name: 'Alpha',
    origin: 'joined',
    type: 'remote-worker',
    worker: { home: 'remote', nodeId: 'n1', remoteBotId: 'rb1', hostname: 'desk-1' },
    sessionId: 'mirror-1',
  }
  const local = { id: 'local', name: 'Local', type: 'normal', sessionId: 'local-1' }
  const session = new Session('mirror-1')
  const registry = {
    send(nodeId, type, payload) {
      if (sendResult !== true) return false
      frames.push({ nodeId, type, payload })
      return true
    },
    on(name, fn) { emitter.on(name, fn) },
    off(name, fn) { emitter.off(name, fn) },
  }
  const botOf = id => (id === shadow.id ? shadow : id === local.id ? local : undefined)
  const rt = {
    ctx: { get: name => (name === 'remote-agent:registry' ? registry : undefined) },
    state: { bots: { [shadow.id]: shadow, local }, exchanges: [], works: {} },
    home: mkdtempSync(join(tmpdir(), 'ds-bot-ledger-')),
    botOf,
    chatOf: id => botOf(id)?.sessionId ?? id,
    joinedTurnTimeoutMs: timeoutMs,
    resolveAgent: async () => ({ session }),
    warn: (...args) => { warnings.push(args) },
    async save() {},
    async load() {},
    async deliver(message) { replies.push(message); return message.exchangeId },
  }
  installHandoffs(rt)
  const answer = (patch = {}) => emitter.emit('botTurnResult', {
    exchangeId: frames.at(-1).payload.exchangeId, ok: true, text: 'pong', seq: 3, ...patch,
  })
  const send = (patch = {}) => handleJoinedTurn(rt, {
    fromId: local.id, toId: shadow.id, text: 'ping', exchangeId: 'ex-1', ...patch,
  })
  // Every open work starts a 30-minute timer that holds the process: drop them at the end.
  const drop = () => { for (const id of Object.keys(rt.state.works ?? {})) rt.dropWork?.(id) }
  return { rt, shadow, local, session, frames, replies, warnings, emitter, answer, send, drop }
}

const rowsOf = (w, id) => w.rt.state.exchanges.filter(row => row.id === id)

test('L1 a retried delivery keeps one ledger row and the later answer fills it', async (t) => {
  const w = makeLedgerWorld()
  t.after(w.drop)
  const first = w.send()
  await settle()
  w.answer({ text: 'pong' })
  assert.equal(await first, 'ex-1')
  const retry = w.send()
  await settle()
  w.answer({ text: 'pong again' })
  assert.equal(await retry, 'ex-1')
  const rows = rowsOf(w, 'ex-1')
  assert.equal(rows.length, 1, 'one row per exchange')
  assert.equal(rows[0].text, 'pong again', 'the later answer is the one kept')
  assert.equal(w.replies.length, 2, 'each delivery still reaches the sender')
})

test('L2 a failure after the answer neither replaces the row nor reaches the sender', async (t) => {
  const w = makeLedgerWorld()
  t.after(w.drop)
  const first = w.send()
  await settle()
  w.answer({ text: 'pong' })
  assert.equal(await first, 'ex-1')
  const retry = w.send()
  await settle()
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  assert.deepEqual(await retry, { ok: false, error: 'bridge-down' })
  const rows = rowsOf(w, 'ex-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, 'pong', 'the answer stays in the ledger')
  assert.equal(w.replies.length, 1, 'the sender hears nothing new')
})

test('L3 an answered work closes, so the 30-minute delegate timer stays silent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = makeLedgerWorld()
  t.after(w.drop)
  w.rt.openWork('ex-1', { from: w.local.id, to: w.shadow.id })
  const turn = w.send()
  await settle()
  w.answer({ text: 'pong' })
  assert.equal(await turn, 'ex-1')
  assert.equal(w.rt.state.works['ex-1'], undefined, 'the answer closed the work')
  t.mock.timers.tick(DELEGATE_TIMEOUT_MS)
  await settle()
  assert.equal(w.replies.length, 1, 'no timeout notice for work already answered')
})

test('L4 a failure the sender already heard is not repeated by a replay', async (t) => {
  const w = makeLedgerWorld({ sendResult: false })
  t.after(w.drop)
  assert.deepEqual(await w.send(), { ok: false, error: 'bridge-down' })
  assert.deepEqual(await w.send(), { ok: false, error: 'bridge-down' })
  const rows = rowsOf(w, 'ex-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, BRIDGE_DOWN_TEXT)
  assert.equal(w.replies.length, 1, 'one notice for one exchange')
})

test('L5 a dispatch with no sender writes no ledger row', async (t) => {
  const w = makeLedgerWorld()
  t.after(w.drop)
  const turn = w.send({ fromId: undefined })
  await settle()
  w.answer({ text: 'pong' })
  assert.equal(await turn, 'ex-1')
  assert.equal(w.rt.state.exchanges.length, 0, 'there is no exchange to record')
  assert.equal(w.replies.length, 0, 'and nobody to tell')
})

test('L6 across the delegate window one answered exchange is delivered once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = makeLedgerWorld()
  t.after(w.drop)
  w.rt.openWork('ex-1', { from: w.local.id, to: w.shadow.id })
  const turn = w.send()
  await settle()
  w.answer({ text: 'pong' })
  assert.equal(await turn, 'ex-1')
  t.mock.timers.tick(DELEGATE_TIMEOUT_MS)
  await settle()
  assert.equal(w.replies.length, 1, 'the answer, and no timeout notice after it')
  assert.equal(rowsOf(w, 'ex-1').length, 1)
  assert.equal(w.rt.state.works['ex-1'], undefined)
})
