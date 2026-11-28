import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as settle } from 'node:timers/promises'
import { threadWorld, makeBot } from './thread-t2-world.js'

const pathOf = w => join(w.home, 'thread-queue.json')
const readQueue = w => JSON.parse(readFileSync(pathOf(w), 'utf8'))
const writeQueue = (w, items) => writeFileSync(pathOf(w), JSON.stringify({ version: 1, items }))
const texts = w => w.prompts.map(({ request }) => request.content[0].text)

function itemsOf(w) {
  try {
    return readQueue(w).items
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function send(w, id, text) {
  const result = await w.call('send', { sessionId: id, text })
  assert.equal(result.ok, true, JSON.stringify(result))
}

function end(w, sessionId, turn = 1) {
  w.sessionEvent(sessionId, { type: 'turn/end', data: { turn }, time: Date.now() })
}

async function queuedPair(second = 'second') {
  const w = threadWorld()
  const bot = await makeBot(w)
  const id = w.rt.chatOf(bot.id)
  await send(w, id, 'first')
  w.sessionEvent(id, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  await send(w, id, second)
  assert.deepEqual(texts(w), ['first'])
  return { w, bot, id }
}

async function restart(w, runningSession, services) {
  await w.ctx.dispose()
  const next = threadWorld({ home: w.home, services })
  if (runningSession !== undefined) next.agentOf(runningSession).status = 'running'
  const warnings = []
  next.rt.warn = (...args) => {
    if (/thread.queue/i.test(args[0])) warnings.push(args)
  }
  await next.rt.load()
  await settle()
  return { next, warnings }
}

test('PERSIST-WRITE stores the waiting user send with its original request ID', async () => {
  const second = 'second '.repeat(30).trimEnd()
  const { w, bot, id } = await queuedPair(second)
  const [queued] = w.rt.threadQueueLive(bot.id).queued
  const saved = readQueue(w)
  assert.equal(saved.version, 1)
  assert.equal(saved.items.length, 1)
  const [item] = saved.items
  assert.deepEqual({ ...item, requestId: undefined }, {
    queueId: queued.queueId, botId: bot.id, threadId: queued.threadId, sessionId: id,
    preview: queued.preview, text: second, enqueuedAt: queued.enqueuedAt, requestId: undefined,
  })
  assert.match(item.requestId, /^[0-9a-f-]{36}$/)
})

test('PERSIST-LONG replays the full controller prompt once after restart', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const id = w.rt.chatOf(bot.id)
  const thread = await w.call('thread-create', { botId: bot.id })
  assert.equal(thread.ok, true, JSON.stringify(thread.error))
  const threadSession = thread.value.sessionId
  await send(w, id, 'first')
  w.sessionEvent(id, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  const text = `${'long prompt '.repeat(20)}END-MARKER`
  const result = await w.ctx.sessionController.prompt({
    requestId: 'long-prompt', sessionId: threadSession, mode: 'queue', content: [{ type: 'text', text }],
  })
  assert.equal(result.queued, true)
  assert.deepEqual(texts(w), ['first'])
  const [queued] = itemsOf(w)
  assert.match(queued.text, /END-MARKER$/)
  assert.equal(queued.text.length, text.length)
  assert.equal(queued.preview, text.slice(0, 120))
  assert.equal(w.rt.threadQueueLive(bot.id).queued[0].preview, queued.preview)

  const { next } = await restart(w)
  assert.deepEqual(texts(next), [text])
  assert.deepEqual(itemsOf(next), [])
  assert.equal(next.prompts[0].request.sessionId, threadSession)
  assert.equal(next.prompts[0].request.requestId, 'long-prompt')
  end(next, threadSession)
  const { next: again } = await restart(next)
  assert.deepEqual(texts(again), [])
})

test('PERSIST-DRAIN removes the second send after the Session takes it', async () => {
  const { w, id } = await queuedPair()
  assert.equal(itemsOf(w).length, 1)
  end(w, id)
  await settle()
  assert.deepEqual(texts(w), ['first', 'second'])
  assert.deepEqual(itemsOf(w), [])
})

test('PERSIST-PRE-ADMISSION keeps the item on disk while the Session submission is held', async () => {
  const { w, id } = await queuedPair()
  const [record] = itemsOf(w)
  const entered = Promise.withResolvers()
  const submit = Promise.withResolvers()
  const realSend = w.rt.sendUser
  w.rt.sendUser = async (payload) => {
    entered.resolve(payload)
    await submit.promise
  }
  try {
    end(w, id)
    const payload = await entered.promise
    assert.equal(payload.requestId, record.requestId)
    assert.deepEqual(itemsOf(w), [record])
    const { next } = await restart(w)
    assert.deepEqual(texts(next), ['second'])
    assert.equal(next.prompts[0].request.requestId, record.requestId)
  } finally {
    submit.reject(new Error('original host exited before submission'))
    w.rt.sendUser = realSend
  }
})

test('PERSIST-ACK-WINDOW retires an accepted request on reboot without prompting again', async () => {
  const { w, id } = await queuedPair()
  const [record] = itemsOf(w)
  w.ctx.sessions.flush = async () => false
  end(w, id)
  await settle()
  assert.deepEqual(texts(w), ['first', 'second'])
  const requestId = w.prompts[1].request.requestId
  assert.equal(requestId, record.requestId)
  assert.deepEqual(itemsOf(w), [record])

  const receipt = { id: 'accepted-message', source: { kind: 'user', rpcId: requestId } }
  const events = [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [receipt] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  ]
  const services = { sessionQuery: { async readSession(sid) { return { events: sid === id ? events : [] } } } }
  const { next } = await restart(w, undefined, services)
  assert.deepEqual(texts(next), [])
  assert.deepEqual(itemsOf(next), [])
})

test('PERSIST-RESTART waits for the active Session and sends the persisted text once', async () => {
  const { w, bot, id } = await queuedPair()
  const [queued] = w.rt.threadQueueLive(bot.id).queued
  const { next } = await restart(w, id)
  assert.deepEqual(texts(next), [])
  assert.deepEqual(next.rt.threadQueueLive(bot.id).queued, [queued])
  next.agentOf(id).status = 'idle'
  end(next, id)
  await settle()
  assert.deepEqual(texts(next), ['second'])
  assert.deepEqual(itemsOf(next), [])
  end(next, id, 2)
  const { next: again } = await restart(next)
  assert.deepEqual(texts(again), [])
})

test('PERSIST-CANCEL removes the queued send and leaves the first turn running', async () => {
  const { w, bot, id } = await queuedPair()
  const { running, queued: [item] } = w.rt.threadQueueLive(bot.id)
  const result = await w.call('thread-queue-cancel', { botId: bot.id, queueId: item.queueId })
  assert.deepEqual(result.value, { cancelled: true, remaining: 0 })
  assert.deepEqual(itemsOf(w), [])
  assert.deepEqual(w.rt.threadQueueLive(bot.id).running, running)
  end(w, id)
  await settle()
  assert.deepEqual(texts(w), ['first'])
})

test('PERSIST-CANCEL-FAIL does not report success while the send remains on disk', async () => {
  const { w, bot } = await queuedPair()
  const [entry] = itemsOf(w)
  const temporary = `${pathOf(w)}.tmp`
  mkdirSync(temporary)
  try {
    const result = await w.call('thread-queue-cancel', { botId: bot.id, queueId: entry.queueId })
    assert.equal(result.ok, false)
    assert.deepEqual(itemsOf(w), [entry])
    assert.equal(w.rt.threadQueueLive(bot.id).queued[0].queueId, entry.queueId)
  } finally {
    rmdirSync(temporary)
  }
})

test('PERSIST-BAD warns once for invalid JSON and replays nothing', async () => {
  const w = threadWorld()
  await makeBot(w)
  writeFileSync(pathOf(w), '{invalid JSON')
  const { next, warnings } = await restart(w)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /thread.queue/i)
  assert.deepEqual(texts(next), [])
})

test('PERSIST-ORDER skips invalid records and restores valid sends by enqueuedAt', async () => {
  const { w, id } = await queuedPair()
  const [second] = itemsOf(w)
  writeQueue(w, [
    { ...second, queueId: 'third', requestId: undefined, preview: 'third', text: 'third', enqueuedAt: second.enqueuedAt + 1 },
    { ...second, queueId: 'stale', sessionId: 'old-session' },
    { ...second, queueId: 'missing', preview: undefined },
    { ...second, queueId: 'legacy', text: undefined },
    second,
  ])
  const { next, warnings } = await restart(w)
  assert.equal(warnings.length, 3)
  assert.deepEqual(texts(next), ['second'])
  assert.deepEqual(itemsOf(next).map(item => item.preview), ['third'])
  end(next, id)
  await settle()
  assert.deepEqual(texts(next), ['second', 'third'])
  assert.deepEqual(itemsOf(next), [])
})

test('PERSIST-STOP keeps sends behind the turn being stopped', async () => {
  const { w, bot, id } = await queuedPair()
  assert.deepEqual(await w.ctx.sessionController.cancel({ sessionId: id }), { accepted: true })
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 1)
  assert.deepEqual(itemsOf(w).map(item => item.preview), ['second'])
  w.sessionEvent(id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } }, time: Date.now() })
  await settle()
  assert.deepEqual(texts(w), ['first', 'second'])
  assert.deepEqual(itemsOf(w), [])
})

test('PERSIST-SCOPE leaves dispatch and textless sends in memory only', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const id = w.rt.chatOf(bot.id)
  await send(w, id, 'first')
  for (const spec of [
    { kind: 'dispatch', sessionId: id, preview: 'dispatch' },
    { kind: 'send', sessionId: id, preview: '' },
    { kind: 'send', preview: 'Bot-only action' },
  ]) {
    await w.rt.sendThreadTurn({ ...spec, botId: bot.id, run: () => assert.fail('still waiting') })
  }
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 3)
  assert.deepEqual(itemsOf(w), [])
  const { next } = await restart(w)
  assert.deepEqual(next.rt.threadQueueLive(bot.id), { running: null, queued: [] })
  assert.deepEqual(texts(next), [])
})
