import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createSendUser } from '../src/host/channel.js'
import { createTurnTracker } from '../src/host/turn-tracker.js'
import { makeWorld, textRequest, types } from './joined-world.js'

const drain = () => new Promise(resolve => setImmediate(resolve))
const texts = session => session.log.filter(event => event.type === 'assistant/message')
  .map(event => event.data.message.content.map(part => part.text ?? '').join(''))
// The page is a copy of the node Bot's chat (W4): how a message ended is its tracker entry, not a line on the page.
const turnOf = (w, index = 0) => w.rt.turnTracker.get(w.frames.filter(frame => frame.type === 'bot/turn')[index].payload.exchangeId)
const outcome = (w, index) => { const entry = turnOf(w, index); return [entry.status, entry.error] }
// Under mocked timers the composer's short wait for an immediate refusal only ends when the clock moves.
async function ticked(t, promise) {
  let over = false
  promise.then(() => { over = true }, () => { over = true })
  for (let i = 0; i < 100 && !over; i++) { await drain(); if (!over) t.mock.timers.tick(1) }
  return promise
}

function pageWorld(t) {
  const w = makeWorld()
  w.rt.turnTracker = createTurnTracker()
  w.rt.joinedRefusalWaitMs = 1
  w.rt.sendUser = createSendUser(w.rt)
  w.send = (requestId = 'page-request') => w.rt.sendUser({
    sessionId: w.bot.sessionId, content: [{ type: 'text', text: 'long work' }], requestId,
  })
  t.after(async () => {
    w.emitter.emit('nodeOffline', { nodeId: 'n1' })
    await drain()
    for (const dispose of w.disposers) dispose()
  })
  return w
}

test('A: page sendUser accepts within 100ms with zero result frames and a pending assistant message', async t => {
  const w = pageWorld(t)
  const started = performance.now()
  const result = await Promise.race([
    w.send(),
    delay(100).then(() => { throw new Error('sendUser waited for the node for 100ms') }),
  ])
  assert.ok(performance.now() - started < 100)
  assert.equal(result.accepted, true)
  assert.deepEqual(w.frames.map(frame => frame.type), ['bot/turn'])
  assert.equal(texts(w.sessionOf('mirror-1')).length, 0, 'no "delivered, running…" line: the running state says it')
  assert.equal(types(w.sessionOf('mirror-1')).includes('turn/end'), false)
})

test('B: a later botTurnResult settles the message exactly once (a repeated result changes nothing)', async t => {
  const w = pageWorld(t)
  await w.send()
  await drain()
  assert.equal(turnOf(w).status, 'pending', 'nothing settles before the answer')
  w.reply(0, { text: 'finished work', seq: 42, nodeId: 'n1' })
  w.reply(0, { text: 'finished work', seq: 42, nodeId: 'n1' })
  await w.idle()
  await drain()
  assert.deepEqual(outcome(w), ['done', undefined])
  assert.deepEqual(w.statuses(), [['mirror-1', true], ['mirror-1', false]], 'running true once, false once')
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), false)
  // The page is a copy of the node Bot's chat (W4): nothing is written here.
  assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  assert.equal(w.frames.length, 1)
  assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
})

test('C: 601 seconds is still waiting — never bot-turn-lost, bridge-down or a failure at the soft deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const w = pageWorld(t)
  await w.send()
  await drain()
  t.mock.timers.tick(601_000)
  await drain()
  // The page is a copy of the node Bot's chat (W4): no progress line, no failure; the message is simply still in flight.
  assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
  assert.deepEqual(w.statuses(), [['mirror-1', true]], 'still running')
  const turnId = w.frames[0].payload.exchangeId
  w.rt.turnTracker.sweep(Date.now() + 120_000, 660_000)
  assert.equal(w.rt.turnTracker.get(turnId).status, 'pending', 'tracker sweep must not invent a timeout')
  w.reply(0, { text: 'after ten minutes', seq: 1 })
  await w.idle()
  await drain()
  assert.deepEqual(outcome(w), ['done', undefined])
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), false)
  assert.deepEqual(w.statuses(), [['mirror-1', true], ['mirror-1', false]])
})

test('D: only the matching nodeOffline ends an unanswered page message as failed', async t => {
  const w = pageWorld(t)
  await w.send()
  await drain()
  w.emitter.emit('nodeOffline', { nodeId: 'another-node' })
  await drain()
  assert.equal(turnOf(w).status, 'pending', 'another node going away is not this message')
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  await w.idle()
  await drain()
  // The page is a copy of the node Bot's chat (W4): the failure is the message's outcome, no line is written here.
  assert.deepEqual(outcome(w), ['failed', 'E_OFFLINE'])
  assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  assert.equal(w.rt.joinedInFlight.size, 0)
  assert.deepEqual(w.statuses(), [['mirror-1', true], ['mirror-1', false]])
  assert.equal(w.emitter.listenerCount('nodeOffline'), 0)
})

test('page prompt and sendUser share the async lifecycle; stop still ends it after the soft deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = pageWorld(t)
  assert.deepEqual(await ticked(t, w.prompt(textRequest('work'))), { accepted: true })
  t.mock.timers.tick(601_000)
  await drain()
  assert.equal(turnOf(w).status, 'pending', 'no failure at the soft deadline')
  assert.deepEqual(await w.cancel(), { accepted: true })
  await w.idle()
  // The page is a copy of the node Bot's chat (W4): Stop ends the wait and frees the Bot; nothing is written here.
  assert.deepEqual(outcome(w), ['failed', 'E_ABORTED'])
  assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  assert.equal(w.rt.joinedInFlight.size, 0)
  assert.equal(w.statuses().at(-1)[1], false)
})

test('a page retry with the same requestId dispatches once while results are pending', async t => {
  const w = pageWorld(t)
  assert.deepEqual(await w.send(), { accepted: true })
  // The page is a copy of the node Bot's chat (W4): the node's copy of the message carries the page's request id
  // (conv-replica.js maps it back through rt.joinedRequestOf), and that copy is what a retry is recognised by.
  const exchangeId = w.frames[0].payload.exchangeId
  assert.equal(w.rt.joinedRequestOf(exchangeId), 'page-request')
  w.sessionOf('mirror-1').append('user/message', { message: { role: 'user', content: [{ type: 'text', text: 'long work' }] }, source: { rpcId: w.rt.joinedRequestOf(exchangeId) } }, { surfaceOp: 'append' })
  assert.deepEqual(await w.send(), { accepted: true })
  assert.equal(w.frames.length, 1)
  assert.equal(w.rt._joinedNextQueues?.get(w.bot.id), undefined, 'the retry was not queued behind its own message')
  w.reply(0)
  await w.idle()
  assert.deepEqual(await w.send(), { accepted: true })
  await drain()
  assert.equal(w.frames.length, 1)
  assert.equal(w.rt.joinedInFlight.size, 0)
})

test('offline after the soft deadline fails once; results from another node are ignored, and nothing after the failure reopens it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = pageWorld(t)
  await w.send()
  t.mock.timers.tick(601_000)
  w.reply(0, { nodeId: 'another-node', text: 'wrong node' })
  await drain()
  assert.equal(turnOf(w).status, 'pending', 'a result from another node does not settle it')
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  await w.idle()
  assert.deepEqual(outcome(w), ['failed', 'E_OFFLINE'])
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), false)
  // The page is a copy of the node Bot's chat (W4): an answer after the link was lost reaches the page as the node's copy.
  w.reply(0, { text: 'after disconnect' })
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  await drain()
  assert.deepEqual(outcome(w), ['failed', 'E_OFFLINE'], 'failed once')
  assert.deepEqual(w.statuses(), [['mirror-1', true], ['mirror-1', false]])
  assert.deepEqual(types(w.sessionOf('mirror-1')), [])
})

test('when the window for the answer ends without one, the turn fails with its own code and frees the Bot (no bridge loss is invented)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = pageWorld(t)
  w.rt.joinedTurnTimeoutMs = 10
  w.rt.joinedLateWindowMs = 100
  await w.send()
  t.mock.timers.tick(10)
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), true, 'still waiting and stoppable inside the window')
  t.mock.timers.tick(100)
  await w.idle()
  assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
  // The page is a copy of the node Bot's chat (W4): the timeout is the message's outcome, no row is written here.
  assert.deepEqual(outcome(w), ['timeout', 'E_TIMEOUT'])
  assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), false, 'the Bot is free: later messages are not held behind a turn that will never end')
  assert.deepEqual(w.statuses(), [['mirror-1', true], ['mirror-1', false]])
})

test('a turn that is still inside its window can be stopped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = pageWorld(t)
  w.rt.joinedTurnTimeoutMs = 10
  w.rt.joinedLateWindowMs = 100
  await w.send()
  t.mock.timers.tick(10)
  await drain()
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
  await w.cancel()
  await w.idle()
  // The page is a copy of the node Bot's chat (W4): the Stop is the message's outcome, nothing is written here.
  assert.deepEqual(outcome(w), ['failed', 'E_ABORTED'])
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), false)
  assert.deepEqual(types(w.sessionOf('mirror-1')), [])
})

test('unload removes active page listeners and releases the pending turn', async t => {
  const w = pageWorld(t)
  await w.send()
  for (const dispose of w.disposers) dispose()
  await w.idle()
  assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
  assert.equal(w.emitter.listenerCount('nodeOffline'), 0)
  assert.equal(w.rt.joinedInFlight.size, 0)
  assert.equal(w.rt.joinedPromptTasks.size, 0)
})
