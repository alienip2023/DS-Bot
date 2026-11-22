import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createSendUser } from '../src/host/channel.js'
import { createTurnTracker } from '../src/host/turn-tracker.js'
import { makeWorld, textRequest, types } from './joined-world.js'

const drain = () => new Promise(resolve => setImmediate(resolve))
const texts = session => session.log.filter(event => event.type === 'assistant/message')
  .map(event => event.data.message.content.map(part => part.text ?? '').join(''))
const failures = session => session.log.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error')

function pageWorld(t) {
  const w = makeWorld()
  w.rt.turnTracker = createTurnTracker()
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
  assert.equal(texts(w.sessionOf('mirror-1')).length, 1)
  assert.match(texts(w.sessionOf('mirror-1'))[0], /Delivered to Joined.*running/i)
  assert.equal(types(w.sessionOf('mirror-1')).includes('turn/end'), false)
})

test('B: a later botTurnResult follows pending in the same session and turn, exactly once', async t => {
  const w = pageWorld(t)
  const pending = w.send()
  await drain()
  assert.match(texts(w.sessionOf('mirror-1'))[0] ?? '', /Delivered to Joined/)
  w.reply(0, { text: 'finished work', seq: 42, nodeId: 'n1' })
  w.reply(0, { text: 'finished work', seq: 42, nodeId: 'n1' })
  await pending
  await drain()
  const session = w.sessionOf('mirror-1')
  assert.deepEqual(texts(session), ['Delivered to Joined; running…', 'finished work'])
  assert.equal(types(session).filter(type => type === 'turn/start').length, 1)
  assert.equal(types(session).filter(type => type === 'turn/end').length, 1)
  assert.equal(session.log.at(-1).data.reason.kind, 'completed')
  assert.equal(w.frames.length, 1)
  assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
})

test('C: 601 seconds is pending progress, never bot-turn-lost, bridge-down or an error card', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const w = pageWorld(t)
  const pending = w.send().catch(error => error)
  await drain()
  t.mock.timers.tick(601_000)
  await drain()
  const session = w.sessionOf('mirror-1')
  assert.equal(failures(session).length, 0)
  assert.doesNotMatch(JSON.stringify(session.log), /bot-turn-lost|桥已断|bridge-down|E_TIMEOUT/)
  assert.match(texts(session).at(-1), /Node is still running; its result will be delivered later/)
  assert.equal(types(session).includes('turn/end'), false)
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
  const turnId = w.frames[0].payload.exchangeId
  w.rt.turnTracker.sweep(Date.now() + 120_000, 660_000)
  assert.equal(w.rt.turnTracker.get(turnId).status, 'pending', 'tracker sweep must not invent a timeout')
  w.reply(0, { text: 'after ten minutes', seq: 1 })
  await pending
  await drain()
  assert.equal(texts(session).at(-1), 'after ten minutes')
  assert.equal(types(session).filter(type => type === 'turn/start').length, 1)
})

test('D: only the matching nodeOffline closes an unanswered page turn as failed', async t => {
  const w = pageWorld(t)
  const pending = w.send().catch(error => error)
  await drain()
  const session = w.sessionOf('mirror-1')
  w.emitter.emit('nodeOffline', { nodeId: 'another-node' })
  await drain()
  assert.equal(failures(session).length, 0)
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  await pending
  await drain()
  assert.equal(failures(session).length, 1)
  assert.equal(failures(session)[0].data.reason.error.code, 'E_OFFLINE')
  assert.match(texts(session).at(-1), /无法送达节点/)
  assert.equal(w.rt.joinedInFlight.size, 0)
  assert.equal(w.emitter.listenerCount('nodeOffline'), 0)
})

test('page prompt and sendUser share the async lifecycle; stop still ends it after the soft deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = pageWorld(t)
  assert.deepEqual(await w.prompt(textRequest('work')), { accepted: true })
  t.mock.timers.tick(601_000)
  await drain()
  assert.deepEqual(await w.cancel(), { accepted: true })
  await w.idle()
  const session = w.sessionOf('mirror-1')
  assert.equal(failures(session).length, 0)
  assert.equal(session.log.at(-1).data.reason.kind, 'aborted')
  assert.equal(w.rt.joinedInFlight.size, 0)
  assert.equal(w.statuses().at(-1)[1], false)
})

test('a page retry with the same requestId dispatches once while results are pending', async t => {
  const w = pageWorld(t)
  assert.deepEqual(await w.send(), { accepted: true })
  assert.deepEqual(await w.send(), { accepted: true })
  assert.equal(w.frames.length, 1)
  assert.equal(texts(w.sessionOf('mirror-1')).length, 1)
  w.reply(0)
  await w.idle()
  assert.deepEqual(await w.send(), { accepted: true })
  assert.equal(w.frames.length, 1)
})

test('offline after the soft deadline fails once and keeps the answer that follows; results from another node are ignored', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = pageWorld(t)
  await w.send()
  t.mock.timers.tick(601_000)
  w.reply(0, { nodeId: 'another-node', text: 'wrong node' })
  await drain()
  const session = w.sessionOf('mirror-1')
  assert.equal(failures(session).length, 0)
  assert.doesNotMatch(JSON.stringify(session.log), /wrong node/)
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  await w.idle()
  assert.equal(failures(session).length, 1)
  // The link dropped, not the work: the node's answer, sent once it is back, is still written (a late reply).
  w.reply(0, { text: 'after disconnect' })
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  await drain()
  assert.equal(failures(session).length, 1, 'the turn failed once')
  assert.match(JSON.stringify(session.log), /节点迟到回复[^"]*after disconnect/, 'and the answer that came after the link was lost is on the page')
  w.reply(0, { text: 'after disconnect', seq: 0 })
  await drain()
  assert.equal((JSON.stringify(session.log).match(/after disconnect/g) ?? []).length, 1, 'written once')
})

test('late window expiry is still pending and stoppable, with no invented bridge loss', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = pageWorld(t)
  w.rt.joinedTurnTimeoutMs = 10
  w.rt.joinedLateWindowMs = 100
  await w.send()
  t.mock.timers.tick(10)
  t.mock.timers.tick(100)
  await drain()
  const session = w.sessionOf('mirror-1')
  assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
  assert.equal(failures(session).length, 0)
  assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
  await w.cancel()
  await w.idle()
  assert.equal(session.log.at(-1).data.reason.kind, 'aborted')
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
