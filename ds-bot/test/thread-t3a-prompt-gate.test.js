// The prompt gate: a prompt made directly on the session controller must wait for the
// Bot's running turn, except for the paths that already went through the serial queue.
// These use the real runtime (index.js module order), the real route handler and the
// real thread queue; only the Session host is a recorder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { ensureMainThread } from '../src/host/bot-store.js'
import { threadWorld, makeBot } from './thread-t2-world.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

/** A local Bot plus one real Thread of its own (new Session, new row). */
async function withThread() {
  const w = threadWorld()
  const bot = await makeBot(w)
  const created = await w.call('thread-create', { botId: bot.id })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  return { w, bot, thread: created.value.thread, threadSession: created.value.sessionId }
}

function prompt(w, sessionId, text, signal = new AbortController().signal) {
  return w.ctx.sessionController.prompt({
    requestId: `prompt-${Math.random().toString(16).slice(2)}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, signal)
}

/** Start the Main Thread's turn through the real send endpoint; it stays running. */
async function startMainTurn(w, bot) {
  await w.call('send', { sessionId: bot.id, text: 'main turn' })
  assert.equal(w.prompts.length, 1)
}

test('a prompt for another Thread waits for the running turn, then runs after it ends', async () => {
  const { w, bot, threadSession } = await withThread()
  // The Thread's own prompt takes the Bot's one slot and keeps it until its turn ends.
  const first = await prompt(w, threadSession, 'first')
  assert.equal(first.queued, false)
  assert.equal(w.prompts.length, 1)

  await w.call('send', { sessionId: bot.id, text: 'second' })
  assert.equal(w.prompts.length, 1, 'the Main send waited behind the running Thread turn')
  const live = w.rt.threadQueueLive(bot.id)
  assert.equal(live.queued.length, 1)
  assert.equal(live.queued[0].preview, 'second')

  w.sessionEvent(threadSession, { type: 'turn/end', data: { turn: 1 } })
  await tick()
  assert.equal(w.prompts.length, 2, 'the queued send ran once the turn ended')
  assert.equal(w.prompts[1].request.sessionId, bot.id)
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 0)
})

test('a prompt for a Session that is not a Thread goes straight through', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  await prompt(w, 'session-plain', 'hello')
  assert.equal(w.prompts.length, 1)
  assert.deepEqual(w.rt.threadQueueLive(bot.id), { running: null, queued: [] })
})

test('aborting a queued prompt withdraws it without running the turn', async () => {
  const { w, bot, threadSession } = await withThread()
  await startMainTurn(w, bot)
  const controller = new AbortController()
  const queued = await prompt(w, threadSession, 'will be aborted', controller.signal)
  assert.equal(queued.queued, true)
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 1)

  controller.abort()
  await tick()
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 0)
  w.sessionEvent(bot.id, { type: 'turn/end', data: { turn: 1 } })
  await tick()
  assert.equal(w.prompts.length, 1, 'the aborted prompt never reached the Session')
})

test('a request already admitted by the gate is not queued a second time', async () => {
  const { w, bot, threadSession } = await withThread()
  await startMainTurn(w, bot)
  const request = {
    requestId: 'admitted-1', sessionId: threadSession, mode: 'queue',
    content: [{ type: 'text', text: 'already queued by its caller' }],
  }
  w.rt.markThreadPromptAdmitted(request)
  await w.ctx.sessionController.prompt(request)
  assert.equal(w.prompts.length, 2)
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 0)
})

test('two sends on one Session reach the queue once each', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  await w.call('send', { sessionId: bot.id, text: 'one' })
  assert.equal(w.prompts.length, 1)
  await w.call('send', { sessionId: bot.id, text: 'two' })
  assert.equal(w.prompts.length, 1, 'the second send waited')
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 1, 'marked admitted, so not enqueued twice')

  w.sessionEvent(bot.id, { type: 'turn/end', data: { turn: 1 } })
  await tick()
  assert.equal(w.prompts.length, 2)
})

test('a disposed Session drops its queued prompt', async () => {
  const { w, bot, threadSession } = await withThread()
  await startMainTurn(w, bot)
  await prompt(w, threadSession, 'orphan')
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 1)

  w.ctx.emit('session/disposed', { id: threadSession })
  await tick()
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 0)
})

test('stopping a Session clears its queued prompt and still reports the stop', async () => {
  const { w, bot, threadSession } = await withThread()
  await startMainTurn(w, bot)
  await prompt(w, threadSession, 'stop me')
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 1)

  const result = await w.ctx.sessionController.cancel({ sessionId: threadSession })
  assert.deepEqual(result, { accepted: true })
  assert.equal(w.rt.threadQueueLive(bot.id).queued.length, 0)
})

// A joined Bot's page is its mirror Session, which the full index resolves to the Bot's
// Main Thread. Its prompt belongs to the node, not to the Bot's local turn queue: the
// queue's one-slot invariant is about turns this host starts, and a joined turn's `done`
// has no local `turn/end` to release the slot. Removing the joined bypass in
// thread-prompt.js therefore leaves the slot running forever and parks the next message.
test('a joined Bot prompt goes to its node and never takes the Thread gate', async () => {
  const w = threadWorld()
  await w.rt.load()
  const { Session } = await import('@deepseek-ai/dsh-session')
  const sessionId = 'mirror-beta'
  const session = new Session(sessionId)
  const joined = {
    id: 'joined:n1:rb1', name: 'Joined beta', role: 'Worker', type: 'remote-worker', origin: 'joined',
    createdAt: Date.now(), capabilities: [], sessionId,
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true },
  }
  w.rt.state.bots[joined.id] = joined
  ensureMainThread(w.rt.state, joined)
  await w.rt.save()
  assert.deepEqual(w.rt.bySessionIdFull(sessionId), { botId: joined.id, threadId: `${joined.id}:main` })

  const emitter = new EventEmitter()
  const frames = []
  w.ctx.get = name => name === 'remote-agent:registry'
    ? {
        send: (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true },
        on: (event, listener) => emitter.on(event, listener),
        off: (event, listener) => emitter.off(event, listener),
      }
    : undefined
  const originalResolve = w.ctx.sessionController.resolveAgent
  w.ctx.sessionController.resolveAgent = async (id) => id === sessionId
    ? { agent: { session, status: 'idle', ctx: { tools: { register: () => () => {} } }, followup() {}, steer() {} } }
    : originalResolve(id)

  const result = await prompt(w, sessionId, 'hello node')
  assert.deepEqual(result, { accepted: true })
  assert.equal(w.prompts.length, 0, 'the node path took the message, not the local prompt')
  assert.equal(frames.length, 1)
  assert.equal(frames[0].nodeId, 'n1')
  assert.equal(frames[0].type, 'bot/turn')
  assert.equal(frames[0].payload.remoteBotId, 'rb1')
  assert.equal(frames[0].payload.text, 'hello node')
  assert.deepEqual(w.rt.threadQueueLive(joined.id), { running: null, queued: [] },
    'a joined turn is not a local turn: it must not hold the Bot\'s one slot')

  emitter.emit('botTurnResult', { exchangeId: frames[0].payload.exchangeId, nodeId: 'n1', ok: true, text: 'hi', seq: 0 })
  await tick()
  await Promise.all([...w.rt.joinedPromptTasks])
})
