import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { install as installDelivery } from '../src/host/delivery.js'
import { install as installQueue } from '../src/host/thread-queue.js'
import { handleJoinedTurn, createBotTurnReceiver, BRIDGE_DOWN_TEXT, LINK_LOST_TEXT, JOINED_TURN_TIMEOUT_MS } from '../src/host/joined-turn.js'
import { install as installWorkerBridge } from '../src/host/worker-bridge.js'
import { fakeContext } from './fake-ctx.js'

const drain = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)) }
async function within(promise, ms) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`did not return within ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

function joinedWorld(t, { sendResult = true, noRegistry = false } = {}) {
  const registry = new EventEmitter()
  const frames = []
  const replies = []
  const closed = []
  const bot = {
    id: 'joined:n1:rb1', name: 'Remote', origin: 'joined', type: 'remote-worker', sessionId: 'mirror',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' },
  }
  const bots = { [bot.id]: bot, sender: { id: 'sender', name: 'Sender' } }
  const session = new Session('mirror')
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return sendResult }
  const records = new Map()
  const rt = {
    ctx: fakeContext({ services: { 'remote-agent:registry': noRegistry ? undefined : registry } }),
    state: { bots, exchanges: [], threads: {} },
    botOf: id => bots[id], chatOf: id => bots[id]?.sessionId,
    hideBotUnusedTools() {},
    closeWork: (...args) => closed.push(args),
    ledger: {
      importer() {}, records: book => records.get(book) ?? [], written: async () => {},
      append(book, record) { records.set(book, [...(records.get(book) ?? []), record]) },
    },
  }
  rt.ctx.sessionController = { resolveAgent: async () => ({ agent: { session } }) }
  installDelivery(rt)
  const deliver = rt.deliver
  rt.deliver = msg => msg.role === 'reply' ? (replies.push(msg), Promise.resolve(msg.exchangeId)) : deliver(msg)
  rt.handleJoinedTurn = msg => handleJoinedTurn(rt, msg)
  installQueue(rt)
  const send = (patch = {}) => rt.deliver({ fromId: 'sender', toId: bot.id, text: 'work', role: 'request', ...patch })
  const reply = (index, text = `answer ${index}`) => registry.emit('botTurnResult', {
    nodeId: 'n1', exchangeId: frames[index].payload.exchangeId, ok: true, text, seq: index + 1,
  })
  t.after(async () => { registry.emit('nodeOffline', { nodeId: 'n1' }); await drain() })
  return { rt, registry, frames, replies, closed, bot, session, send, reply }
}

test('three joined sends release the thread queue before any remote result', async t => {
  const w = joinedWorld(t)
  for (let i = 0; i < 3; i += 1) {
    const outcome = await within(w.rt.sendThreadTurn({
      botId: w.bot.id, kind: 'send', releaseOn: 'run',
      run: () => w.send({ exchangeId: `ex-${i}`, text: `work ${i}` }),
    }), 200)
    assert.equal(outcome.queued, false, `send ${i + 1} was handed off without waiting for the first result`)
    assert.deepEqual(w.rt.threadQueueLive(w.bot.id), { running: null, queued: [] })
  }
  assert.deepEqual(w.frames.map(frame => frame.type), ['bot/turn', 'bot/turn', 'bot/turn'])
  assert.equal(w.replies.length, 0)
  for (const index of [2, 0, 1]) w.reply(index)
  await drain()
  assert.equal(w.replies.length, 3)
  assert.deepEqual(w.replies.map(msg => msg.replyTo).sort(), ['ex-0', 'ex-1', 'ex-2'])
  assert.ok(w.replies.every(msg => msg.role === 'reply' && msg.toId === 'sender'))
  assert.deepEqual(w.session.log.filter(e => e.type === 'assistant/message').map(e => e.data.message.content[0].text), ['answer 0', 'answer 1', 'answer 2'])
  assert.equal(w.session.log.filter(e => e.type === 'turn/end').length, 3)
})

test('duplicate deferred deliveries for the same exchangeId dispatch and reply only once', async t => {
  const w = joinedWorld(t)
  const msg = { fromId: 'sender', toId: w.bot.id, text: 'work', exchangeId: 'duplicate', defer: true }
  assert.equal(await handleJoinedTurn(w.rt, msg), 'duplicate')
  assert.equal(await handleJoinedTurn(w.rt, msg), 'duplicate')
  assert.deepEqual(w.frames.map(frame => frame.type), ['bot/turn'])
  assert.equal(w.session.log.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(w.replies.length, 0)

  w.reply(0, 'one answer')
  await drain()
  assert.deepEqual(w.replies, [{
    fromId: w.bot.id, toId: 'sender', text: 'one answer', role: 'reply', replyTo: 'duplicate', joinedTurn: true,
  }])
  assert.equal(w.session.log.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(w.session.log.filter(e => e.type === 'turn/end').length, 1)
})

test('wait:true overrides joinedAsync and waits for the node result', async t => {
  const w = joinedWorld(t)
  let finished = false
  const pending = w.send({ exchangeId: 'wait', wait: true, joinedAsync: true }).then(result => { finished = true; return result })
  await drain()
  assert.equal(finished, false)
  w.reply(0)
  assert.equal(await within(pending, 200), 'wait')
})

for (const options of [{ sendResult: false }, { noRegistry: true }]) {
  test(`a real bridge loss fails immediately: ${JSON.stringify(options)}`, async t => {
    const w = joinedWorld(t, options)
    assert.deepEqual(await within(w.send(), 200), { ok: false, error: 'bridge-down' })
    assert.equal(w.replies[0].text, BRIDGE_DOWN_TEXT)
    assert.equal(w.session.log.filter(e => e.type === 'turn/end').length, 1)
    assert.equal(w.registry.listenerCount('botTurnResult'), 0)
  })
}

test('a deferred timeout keeps the mirror open and delivers a late result once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = joinedWorld(t)
  w.rt.joinedTurnTimeoutMs = 10
  w.rt.joinedLateWindowMs = 100
  assert.equal(await w.send({ exchangeId: 'late', joinedAsync: true }), 'late')
  t.mock.timers.tick(10)
  await drain()
  assert.equal(w.replies.length, 0)
  assert.equal(w.closed.length, 0)
  assert.equal(w.session.log.filter(e => e.type === 'turn/end').length, 0)
  assert.match(JSON.stringify(w.session.log), /节点仍在运行，结果会在完成后送到这里/)
  w.registry.emit('botTurnResult', { nodeId: 'other-node', exchangeId: 'late', ok: true, text: 'wrong', seq: 1 })
  w.reply(0, 'late answer')
  w.reply(0, 'late answer')
  await drain()
  assert.deepEqual(w.replies.map(msg => msg.text), ['late answer'])
  assert.match(JSON.stringify(w.session.log), /late answer/)
  assert.doesNotMatch(JSON.stringify(w.session.log), /桥已断|bridge-down|wrong/)
  assert.equal(w.session.log.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(w.registry.listenerCount('botTurnResult'), 0)
  assert.equal(w.registry.listenerCount('nodeOffline'), 0)
})

test('nodeOffline after a deferred timeout reports a real bridge loss', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = joinedWorld(t)
  w.rt.joinedTurnTimeoutMs = 10
  await w.send({ joinedAsync: true })
  t.mock.timers.tick(10)
  await drain()
  assert.equal(w.replies.length, 0)
  w.registry.emit('nodeOffline', { nodeId: 'n1' })
  await drain()
  assert.deepEqual(w.replies.map(msg => msg.text), [LINK_LOST_TEXT])
})

test('expiry of the window for the answer tells the sender the node did not answer, once; a later disconnect adds nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = joinedWorld(t)
  w.rt.joinedTurnTimeoutMs = 10
  w.rt.joinedLateWindowMs = 100
  await w.send({ joinedAsync: true })
  t.mock.timers.tick(10)
  await drain()
  assert.equal(w.replies.length, 0, 'still waiting inside the window')
  t.mock.timers.tick(100)
  await drain()
  assert.equal(w.registry.listenerCount('botTurnResult'), 0, 'the window is bounded')
  assert.deepEqual(w.replies.map(msg => msg.text), ['副机没有接上：bot-turn-timeout'])
  w.registry.emit('nodeOffline', { nodeId: 'n1' })
  await drain()
  assert.equal(w.replies.length, 1, 'the exchange is closed: a disconnect now says nothing more')
  assert.equal(w.session.log.filter(e => e.type === 'turn/end').length, 1)
})

for (const duringDispatch of [false, true]) {
  test(`worker returns on acceptance and delivers once (taskEnd during dispatch: ${duringDispatch})`, async t => {
    const registry = new EventEmitter()
    const replies = []
    let dispatched
    const tools = new Map([
      ['remote_task', { execute: async args => {
        dispatched = args
        if (duringDispatch) registry.emit('taskEnd', { taskId: args.taskId, status: 'COMPLETED' })
        return { value: { accepted: true } }
      } }],
      ['remote_status', { execute: async () => { throw new Error('event-driven task should not poll') } }],
      ['remote_handoff', { execute: async () => ({ value: { text: 'worker answer' } }) }],
    ])
    const bot = { id: 'worker', name: 'Worker', type: 'remote-worker', worker: { nodeId: 'n1' } }
    const rt = {
      ctx: fakeContext({ services: { tools, 'remote-agent:registry': registry } }),
      botOf: () => bot, deliver: async msg => replies.push(msg), warn() {},
    }
    installWorkerBridge(rt)
    t.after(() => { if (dispatched) registry.emit('taskEnd', { ...dispatched, status: 'COMPLETED' }) })
    const result = await within(rt.handleRemoteTurn({ fromId: 'sender', toId: 'worker', text: 'work', exchangeId: 'worker-ex', work: 'root' }), 100)
    assert.equal(result, 'worker-ex')
    if (!duringDispatch) assert.equal(replies.length, 0)
    registry.emit('taskEnd', { taskId: dispatched.taskId, status: 'COMPLETED' })
    registry.emit('taskEnd', { taskId: dispatched.taskId, status: 'COMPLETED' })
    await drain()
    assert.deepEqual(replies, [{ fromId: 'worker', toId: 'sender', text: 'worker answer', role: 'reply', replyTo: 'worker-ex', work: 'root' }])
    assert.equal(registry.listenerCount('taskEnd'), 0)
  })
}

test('the node receiver can return a real result after the hub soft timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bot = { id: 'local', sessionId: 'node-session' }
  const rt = {
    state: { bots: { local: bot } },
    chatOf: () => bot.sessionId, sendUser: async () => {},
  }
  const accept = createBotTurnReceiver(rt)
  const pending = accept({ remoteBotId: 'local', exchangeId: 'long-turn', text: 'long work' })
  await drain()
  t.mock.timers.tick(JOINED_TURN_TIMEOUT_MS + 1)
  await drain()
  assert.equal(rt.settleJoinedTurn('long-turn', 'long work finished'), true)
  assert.deepEqual(await pending, { ok: true, exchangeId: 'long-turn', text: 'long work finished' })
})

test('the link drops while the node works: the sender is told it is not a failure, and the answer that comes after is delivered to it', async t => {
  const w = joinedWorld(t)
  await w.send({ joinedAsync: true })
  assert.equal(w.frames.length, 1, 'the node had the work')
  w.registry.emit('nodeOffline', { nodeId: 'n1' })
  await drain()
  assert.deepEqual(w.replies.map(msg => msg.text), [LINK_LOST_TEXT])
  assert.match(LINK_LOST_TEXT, /不是失败/)
  assert.match(LINK_LOST_TEXT, /不要取消它的任务/)
  assert.equal(w.registry.listenerCount('botTurnResult'), 1, 'still waiting for the answer')
  // the node is back and sends what it finished while the link was down
  w.reply(0, 'finished while the link was down')
  await drain()
  assert.equal(w.replies.length, 2)
  assert.match(w.replies[1].text, /连接恢复后，节点送回了结果[^]*finished while the link was down/)
  assert.equal(w.registry.listenerCount('botTurnResult'), 0, 'one answer, then done')
  assert.match(JSON.stringify(w.session.log), /节点迟到回复[^"]*finished while the link was down/, 'and it is on the Bot\'s page')
})

test('a link loss before the node had the work is a failure and nothing is waited for', async t => {
  const w = joinedWorld(t, { sendResult: false })
  const result = await w.send()
  assert.deepEqual(result, { ok: false, error: 'bridge-down' })
  assert.equal(w.registry.listenerCount('botTurnResult'), 0)
  assert.equal(w.replies[0].text, BRIDGE_DOWN_TEXT, 'the short text: the work never left')
})

test('an answer that arrives after a lost link while a page turn is open waits for it instead of closing it as interrupted', async t => {
  const { flushLateReplies } = await import('../src/host/executor.js')
  const w = joinedWorld(t)
  await w.send({ joinedAsync: true })
  w.registry.emit('nodeOffline', { nodeId: 'n1' })
  await drain()
  // the user kept talking: a page turn of this Bot is open
  w.rt.joinedInFlight = new Map([[w.bot.id, { requestId: 'page' }]])
  const turnStarts = () => w.session.log.filter(event => event.type === 'turn/start').length
  const before = turnStarts()
  w.reply(0, 'finished while the link was down')
  await drain()
  assert.equal(turnStarts(), before, 'nothing is written into the page while its turn is open')
  w.rt.joinedInFlight.delete(w.bot.id)
  flushLateReplies(w.rt, w.bot.id)
  assert.equal(turnStarts(), before + 1, 'then it is written as a turn of its own')
  assert.match(JSON.stringify(w.session.log), /节点迟到回复[^"]*finished while the link was down/)
  assert.equal(w.session.log.filter(event => event.type === 'turn/end' && event.data.reason?.kind === 'interrupted').length, 0)
})
