// P1-T2 serial gate: one turn per Bot. These tests drive the real thread-queue module
// through the real channel route and the real delivery path; turn events are dispatched
// with both arguments exactly like the core's session/event.
import test from 'node:test'
import assert from 'node:assert/strict'
import { threadWorld, makeBot } from './thread-t2-world.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))
const texts = w => w.prompts.map(entry => entry.request.content[0].text)

async function running(w, bot, text = 'first') {
  const res = await w.call('send', { sessionId: bot.id, text })
  assert.equal(res.ok, true, JSON.stringify(res))
  return res
}

test('T2-second send during a running turn is queued', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  await running(w, bot, 'first')
  const second = await w.call('send', { sessionId: bot.id, text: 'second' })
  assert.equal(second.ok, true)
  assert.equal(second.value, true)
  assert.deepEqual(texts(w), ['first'])
  const live = w.rt.threadQueueLive(bot.id)
  assert.equal(live.running.threadId, `${bot.id}:main`)
  assert.equal(live.queued.length, 1)
  assert.equal(live.queued[0].preview, 'second')
})

test('T2-second turn/start happens after the first turn/end', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  await running(w, bot, 'first')
  await w.call('send', { sessionId: bot.id, text: 'second' })
  w.sessionEvent(bot.id, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  assert.deepEqual(texts(w), ['first'], 'the second turn must not start while the first runs')
  w.sessionEvent(bot.id, { type: 'turn/end', data: { turn: 1 }, time: Date.now() })
  await tick()
  assert.deepEqual(texts(w), ['first', 'second'])
})

test('T2-cancel removes a queued message and leaves the running turn alone', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  await running(w, bot, 'first')
  await w.call('send', { sessionId: bot.id, text: 'second' })
  await w.call('send', { sessionId: bot.id, text: 'third' })
  const queued = await w.call('thread-queue', { botId: bot.id })
  assert.equal(queued.ok, true)
  assert.deepEqual(queued.value.items.map(item => item.preview), ['second', 'third'])
  const cancel = await w.call('thread-queue-cancel', { botId: bot.id, queueId: queued.value.items[0].queueId })
  assert.equal(cancel.ok, true)
  assert.equal(cancel.value.cancelled, true)
  assert.equal(cancel.value.remaining, 1)
  w.sessionEvent(bot.id, { type: 'turn/end', data: { turn: 1 }, time: Date.now() })
  await tick()
  assert.deepEqual(texts(w), ['first', 'third'])
})

test('T2-prompt rejection frees the Bot for the next message', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  let calls = 0
  w.ctx.sessionController.prompt = async (request) => {
    calls += 1
    w.prompts.push({ request })
    if (calls === 1) throw new Error('provider refused')
    return { accepted: true }
  }
  const first = await w.call('send', { sessionId: bot.id, text: 'first' })
  assert.equal(first.ok, false)
  const second = await w.call('send', { sessionId: bot.id, text: 'second' })
  assert.equal(second.ok, true)
  assert.deepEqual(texts(w), ['first', 'second'])
  assert.equal(w.rt.threadQueueLive(bot.id).running !== null, true)
})

test('T2-queue is empty after install', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  await running(w, bot, 'first')
  await w.call('send', { sessionId: bot.id, text: 'second' })
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 1)
  // The queue is memory only: a new runtime on the same state.json starts empty.
  await w.rt.save()
  const restarted = threadWorld({ home: w.home })
  await restarted.rt.load()
  assert.deepEqual(restarted.rt.threadQueueLive(bot.id), { running: null, queued: [] })
  const res = await restarted.call('thread-queue', { botId: bot.id })
  assert.equal(res.ok, true)
  assert.deepEqual(res.value.items, [])
})

test('T2-threads view reports live running and queued counts', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  await running(w, bot, 'first')
  await w.call('send', { sessionId: bot.id, text: 'second' })
  const res = await w.call('threads', { botId: bot.id })
  assert.equal(res.ok, true)
  const main = res.value.threads.find(thread => thread.isMain)
  assert.equal(main.running, 1)
  assert.equal(main.queued, 1)
  const again = await w.call('threads', { botId: bot.id })
  assert.equal(again.value.threads.find(thread => thread.isMain).queued, 1)
})

// The pair's book of messages (ledger.js): v0.3.5 writes a message there before it goes out.
const pairBook = (a, b) => `pair-${[a, b].sort().join('-')}`
const bookOf = (w, a, b) => w.rt.ledger.records(pairBook(a, b))

test("T2-team delivery waits for the running thread's turn/end", async () => {
  const w = threadWorld()
  const bot = await makeBot(w, 'Alpha')
  const other = await makeBot(w, 'Beta')
  await running(w, bot, 'first')
  const exchangeId = await w.rt.deliver({
    fromId: other.id, fromName: 'Beta', toId: bot.id, text: 'team message', role: 'request',
  })
  assert.equal(typeof exchangeId, 'string')
  assert.equal(w.followups.length, 0, 'a queued delivery must not write to the Session yet')
  assert.equal(w.flushes.length, 0)
  assert.equal(w.rt.state.exchanges.length, 0)
  assert.equal(bookOf(w, bot.id, other.id).filter(record => record.id === exchangeId && record.event === undefined).length, 1, 'the message is in the book before it goes out')
  w.sessionEvent(bot.id, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  w.sessionEvent(bot.id, { type: 'turn/end', data: { turn: 1 }, time: Date.now() })
  await tick()
  assert.equal(w.followups.length, 1)
  assert.equal(w.flushes.length, 1)
  assert.equal(w.rt.state.exchanges.length, 0)
  const delivered = bookOf(w, bot.id, other.id).filter(record => record.event === 'delivered' && record.id === exchangeId)
  assert.equal(delivered.length, 1, 'the delivery is marked in the book')
  assert.equal(delivered[0].sessionId, bot.id)
})

test('T2-steer delivery is not queued', async () => {
  const w = threadWorld()
  const bot = await makeBot(w, 'Alpha')
  const other = await makeBot(w, 'Beta')
  await running(w, bot, 'first')
  const exchangeId = await w.rt.deliver({
    fromId: other.id, fromName: 'Beta', toId: bot.id, text: 'interrupt', role: 'request', steer: true,
  })
  assert.equal(typeof exchangeId, 'string')
  assert.equal(w.steers.length, 1)
  assert.equal(w.followups.length, 0)
  assert.equal(w.rt.state.exchanges.length, 0)
  assert.equal(bookOf(w, bot.id, other.id).filter(record => record.event === 'delivered' && record.id === exchangeId).length, 1)
})

test('T2-room delivery is not gated', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  await running(w, bot, 'first')
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 0)
  const exchangeId = await w.rt.deliver({
    fromId: bot.id, fromName: 'Alpha', toId: bot.id, sessionId: 'room-session-1', text: 'room message', role: 'request',
  })
  assert.equal(typeof exchangeId, 'string')
  assert.equal(w.followups.length, 1, 'a room Session has its own concurrency and must not wait')
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 0)
})
