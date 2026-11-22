// The exchange view of a Bot pair (军团司令 ⇄ node009执行) shows what each side said. A request
// dispatched to a node leaves this machine before it reaches any Session, so nothing marked it as
// delivered and the view showed only the node's answers. (Reported 2026-11-22 with screenshots.)
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { install as installDelivery } from '../src/host/delivery.js'
import { install as installQueue } from '../src/host/thread-queue.js'
import { BRIDGE_DOWN_TEXT, handleJoinedTurn } from '../src/host/joined-turn.js'
import { fakeContext } from './fake-ctx.js'

const drain = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)) }

function world(t, { sendResult = true, books = new Map() } = {}) {
  const registry = new EventEmitter()
  const frames = []
  const bot = {
    id: 'joined:n1:rb1', name: 'node009执行', origin: 'joined', type: 'remote-worker', sessionId: 'mirror',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' },
  }
  const bots = { [bot.id]: bot, chief: { id: 'chief', name: '军团司令', sessionId: 'chief-chat' } }
  const session = new Session('mirror')
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return sendResult }
  const rt = {
    ctx: fakeContext({ services: { 'remote-agent:registry': registry } }),
    state: { bots, exchanges: [], threads: {} },
    botOf: id => bots[id], chatOf: id => bots[id]?.sessionId, roomOf: () => undefined,
    hideBotUnusedTools() {},
    ensureCapabilities: async () => {},
    closeWork() {},
    ledger: {
      importer() {}, records: book => books.get(book) ?? [], written: async () => {},
      append(book, record) { books.set(book, [...(books.get(book) ?? []), record]) },
    },
  }
  const agent = { session, followup() {}, steer() {}, whenIdle: async () => {}, inbox: { nextStep: [], nextTurn: [] } }
  rt.ctx.sessionController = { resolveAgent: async () => ({ agent }) }
  rt.ctx.sessions = { flush: async () => {} }
  installDelivery(rt)
  rt.handleJoinedTurn = msg => handleJoinedTurn(rt, msg)
  installQueue(rt)
  t.after(async () => { registry.emit('nodeOffline', { nodeId: 'n1' }); await drain() })
  return { rt, registry, frames, bot, books }
}
const texts = (rt, bot) => Array.from(rt.exchangesOf('chief', bot.id), row => [row.role, row.text])

test('a request the node accepted shows in the pair\'s view, beside the node\'s answer', async (t) => {
  const w = world(t)
  await w.rt.deliver({ fromId: 'chief', toId: w.bot.id, text: 'ping the node', role: 'request', exchangeId: 'ex-1' })
  assert.deepEqual(texts(w.rt, w.bot), [['request', 'ping the node']])
  // The node answers; the answer reaches the sender as a reply from the node's Bot.
  w.registry.emit('botTurnResult', { nodeId: 'n1', exchangeId: 'ex-1', ok: true, text: '68', seq: 1 })
  await drain()
  assert.deepEqual(texts(w.rt, w.bot).map(([role]) => role), ['request', 'reply'])
  assert.deepEqual(texts(w.rt, w.bot).map(([, text]) => text), ['ping the node', '68'])
})

test('a request that never reached the node is not marked as sent; the view shows it with the failure note', async (t) => {
  const w = world(t, { sendResult: false })
  await w.rt.deliver({ fromId: 'chief', toId: w.bot.id, text: 'lost', role: 'request', exchangeId: 'ex-2' }).catch(() => {})
  assert.equal(w.frames.length, 1, 'the frame was tried')
  const marks = [...w.books.values()].flat().filter(record => record.event === 'delivered' && record.id === 'ex-2')
  assert.deepEqual(marks, [], 'the request itself was never marked as delivered')
  // What the sender was told instead (the node did not take it) is a delivered reply, and the
  // request it answers is shown beside it.
  const rows = texts(w.rt, w.bot)
  assert.deepEqual(rows.map(([role]) => role), ['request', 'reply'])
  assert.equal(rows[1][1], BRIDGE_DOWN_TEXT)
})

test('an older book holds the request unmarked: it shows once its answer is there, in time order', (t) => {
  // What fork.93 wrote: the request written, never marked; the node's reply delivered later.
  const book = 'pair-chief-joined:n1:rb1'
  const books = new Map([[book, [
    { id: 'old-1', from: 'chief', to: 'joined:n1:rb1', role: 'request', text: 'old question', time: 1000 },
    { id: 'old-1-reply', from: 'joined:n1:rb1', to: 'chief', role: 'reply', replyTo: 'old-1', text: 'old answer', time: 2000 },
    { event: 'delivered', id: 'old-1-reply', sessionId: 'chief-chat', time: 2000 },
    { id: 'unanswered', from: 'chief', to: 'joined:n1:rb1', role: 'request', text: 'never answered', time: 3000 },
  ]]])
  const w = world(t, { books })
  assert.deepEqual(texts(w.rt, w.bot), [['request', 'old question'], ['reply', 'old answer']],
    'the answered request is back, before its answer; one nobody answered stays out')
})
