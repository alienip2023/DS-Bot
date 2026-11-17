// msg-s1: a turn that ends `blocked` releases the queue at once (REBUILD-MSG-MODEL S5, D1).
// ACCEPT_WAIT_MS stays 60s; it covers only an accepted turn with no turn/start and no failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { threadWorld, makeBot } from './thread-t2-world.js'

const CODE = 'E_BOT_MODEL_UNAVAILABLE'
const texts = w => w.prompts.map(entry => entry.request.content[0].text)

test('S5-a blocked turn releases the queue: the next message starts in under 5s, with an error row', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const warnings = []
  const warn = w.rt.warn
  w.rt.warn = (...args) => { warnings.push(args.join(' ')); return warn?.(...args) }

  assert.equal((await w.call('send', { sessionId: bot.id, text: 'first' })).ok, true)
  w.sessionEvent(bot.id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: CODE, message: 'model gone' } } }, time: Date.now() })
  assert.equal(w.rt.botOf(bot.id).blocked?.code, CODE, 'the failed turn blocks the Bot')

  const began = Date.now()
  const second = await w.call('send', { sessionId: bot.id, text: 'second' })
  // started, or failed with the same code; a wedged queue shows up as neither before the deadline
  while (!texts(w).includes('second') && !(second.ok === false && second.code === CODE) && Date.now() - began < 5500) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const elapsed = Date.now() - began
  assert.ok(elapsed < 5000, `second message took ${elapsed}ms`)
  const started = texts(w).includes('second')
  const failedWithCode = second.ok === false && second.code === CODE
  assert.ok(started || failedWithCode, JSON.stringify(second))
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 0, 'second is not parked behind the failed turn')
  assert.equal(warnings.some(line => /accepted but never started/.test(line)), false)

  const rows = (await w.rt.diagnostics.entries()).filter(entry => entry.code === CODE)
  assert.ok(rows.length >= 1, 'the timeline has an error row')
})

test('S5-b a refused turn with no turn/end is released by its failure, not by the accept wait', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  assert.equal((await w.call('send', { sessionId: bot.id, text: 'first' })).ok, true)
  // the turn is refused: the Bot is blocked, no turn/start and no turn/end ever arrive
  w.rt.botOf(bot.id).blocked = { code: CODE, at: Date.now() }
  const began = Date.now()
  const second = await w.call('send', { sessionId: bot.id, text: 'second' })
  assert.equal(second.ok, true)
  while (!texts(w).includes('second') && Date.now() - began < 4000) await new Promise(resolve => setTimeout(resolve, 50))
  const elapsed = Date.now() - began
  assert.ok(elapsed < 5000, `second message took ${elapsed}ms`)
  assert.deepEqual(texts(w), ['first', 'second'])
  const rows = (await w.rt.diagnostics.entries()).filter(entry => entry.code === CODE)
  assert.ok(rows.length >= 1, 'the timeline has an error row')
})

test('S5-c an accepted turn with no start and no failure is still held (not collapsed with failure)', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  await w.call('send', { sessionId: bot.id, text: 'first' })
  await w.call('send', { sessionId: bot.id, text: 'second' })
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.deepEqual(texts(w), ['first'])
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 1)
})
