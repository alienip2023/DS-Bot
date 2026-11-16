import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { install } from '../src/host/schedules.js'
import { install as installQueue } from '../src/host/thread-queue.js'
import { createSendUser } from '../src/host/channel.js'
import { createBotTurnReceiver } from '../src/host/joined-turn.js'
import { fakeContext } from './fake-ctx.js'
import { threadWorld, makeBot } from './thread-t2-world.js'

const drain = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)) }

function world(t, { offline = false, reject = false, state } = {}) {
  const local = { id: 'writer', name: 'Writer', sessionId: 'part-1' }
  const joined = { id: 'joined:n1:remote', name: 'Node writer', sessionId: 'mirror', origin: 'joined', type: 'remote-worker', worker: { nodeId: 'n1', remoteBotId: 'remote', home: 'remote' } }
  const registry = new EventEmitter()
  const frames = []
  const prompts = []
  const nodePrompts = []
  const persisted = []
  const legacy = []
  const schedule = { edit() {}, catalog: async () => [], create: async (...args) => legacy.push(args) }
  const ctx = fakeContext({ services: { schedule, 'remote-agent:registry': registry } })
  const sessions = new Map([['mirror', new Session('mirror')]])
  const rt = {
    ctx, state: state ?? { bots: { writer: local, [joined.id]: joined }, threads: {} },
    chatOwners: new Map([['part-1', 'writer'], ['mirror', joined.id]]), groupOwners: new Map(), pastOwners: new Map(),
    load: async () => {}, save: async () => { persisted.push(structuredClone(rt.state)) }, warn() {},
    roomOf: () => undefined, botOf: id => rt.state.bots[id], chatOf: id => rt.state.bots[id]?.sessionId,
    bySessionId: id => Object.values(rt.state.bots).find(bot => bot.sessionId === id),
    ensureCapabilities: async () => {}, resolveAgent: async id => ({ session: sessions.get(id) }),
  }
  const event = (id, type, data = {}) => { for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, { type, data }) }
  ctx.sessionController = { prompt: async request => {
    prompts.push(request)
    event(request.sessionId, 'turn/start')
    if (reject) throw new Error('model unavailable')
    return { accepted: true }
  } }
  const node = { state: { bots: { remote: { id: 'remote', sessionId: 'node-real-session' } } }, chatOf: () => 'node-real-session' }
  node.sendUser = async request => { nodePrompts.push(request); setImmediate(() => node.settleJoinedTurn(request.requestId, 'node result')) }
  const receive = createBotTurnReceiver(node)
  registry.send = (nodeId, type, payload) => {
    frames.push({ nodeId, type, payload })
    if (offline) return false
    void receive(payload).then(result => registry.emit('botTurnResult', { ...result, nodeId, seq: frames.length }))
    return true
  }
  rt.sendUser = createSendUser(rt)
  installQueue(rt)
  install(rt)
  const call = (endpoint, body) => rt.scheduleEndpoint(endpoint, body)
  const create = (botId = 'writer', when = { kind: 'every', minutes: 1 }) => call('schedule-create', { target: { kind: 'bot', botId }, title: 'Routine', prompt: 'Check the work', when })
  const due = async () => {
    const view = await call('schedules')
    const task = view.tasks[0]
    await rt.runDueRoutines(Date.parse(task.scheduledAt))
    await drain()
    return (await call('schedules')).tasks[0]
  }
  t.after(async () => { registry.emit('nodeOffline', { nodeId: 'n1' }); await ctx.dispose(); await drain() })
  return { rt, ctx, local, joined, call, create, due, event, prompts, frames, nodePrompts, sessions, persisted, legacy }
}

test('a Bot target is stored and listed by stable Bot identity', async t => {
  const w = world(t)
  const view = await w.create()
  assert.equal(view.tasks.length, 1)
  assert.deepEqual(view.tasks[0].target, { kind: 'bot', botId: 'writer' })
  assert.equal(view.tasks[0].botId, 'writer')
  assert.equal(w.legacy.length, 0, 'unsupported targets must never be passed to DSH schedule')
  assert.equal(w.persisted.at(-1).routines[view.tasks[0].id].target.botId, 'writer')
})

test('a local routine resolves the current main chat and records actual completion', async t => {
  const w = world(t)
  await w.create()
  w.local.sessionId = 'part-2'
  const running = await w.due()
  assert.equal(w.prompts[0].sessionId, 'part-2')
  assert.match(w.prompts[0].content[0].text, /Check the work/)
  assert.equal(running.lastRun.status, 'running', 'acceptance is not successful execution')
  w.event('part-2', 'turn/end', { reason: { kind: 'completed' } })
  await drain()
  assert.equal((await w.call('schedules')).tasks[0].lastRun.status, 'succeeded')
})

test('a joined routine reaches the node real Session and mirrors the result without a local prompt', async t => {
  const w = world(t)
  await w.create(w.joined.id)
  const task = await w.due()
  assert.equal(w.frames.length, 1)
  assert.equal(w.frames[0].type, 'bot/turn')
  assert.equal(w.frames[0].payload.remoteBotId, 'remote')
  assert.equal(w.nodePrompts[0].sessionId, 'node-real-session')
  assert.equal(w.prompts.length, 0)
  assert.match(JSON.stringify(w.sessions.get('mirror').log), /node result/)
  assert.equal(task.lastRun.status, 'succeeded')
})

test('an offline joined node leaves a failed routine and visible mirror failure', async t => {
  const w = world(t, { offline: true })
  await w.create(w.joined.id)
  const task = await w.due()
  assert.equal(task.lastRun.status, 'failed')
  assert.match(task.lastRun.error, /E_OFFLINE|offline/i)
  assert.match(JSON.stringify(w.sessions.get('mirror').log), /E_OFFLINE/)
  assert.equal(w.prompts.length, 0)
})

test('prompt rejection is retained as a visible failed run', async t => {
  const w = world(t, { reject: true })
  await w.create()
  const task = await w.due()
  assert.equal(task.lastRun.status, 'failed')
  assert.match(task.lastRun.error, /model unavailable/)
})

test('a due routine queues behind the Bot running in another thread', async t => {
  const w = world(t)
  await w.rt.sendThreadTurn({ botId: 'writer', sessionId: 'part-1', kind: 'send', run: async () => {} })
  await w.create()
  const task = await w.due()
  assert.equal(task.lastRun.status, 'queued')
  assert.equal(w.prompts.length, 0)
  assert.equal(w.rt.threadQueueLive('writer').queued.length, 1)
  w.event('part-1', 'turn/end')
  await drain()
  assert.equal(w.prompts.length, 1)
  w.event('part-1', 'turn/end', { reason: { kind: 'completed' } })
  await drain()
  assert.equal((await w.call('schedules')).tasks[0].lastRun.status, 'succeeded')
})

test('a model turn error is failed even after the prompt was accepted', async t => {
  const w = world(t)
  await w.create()
  await w.due()
  w.event('part-1', 'turn/end', { reason: { kind: 'error', error: { message: 'quota exhausted' } } })
  await drain()
  const task = (await w.call('schedules')).tasks[0]
  assert.equal(task.lastRun.status, 'failed')
  assert.match(task.lastRun.error, /quota exhausted/)
})

test('a restart preserves Bot targets and reports interrupted work rather than replaying it', async t => {
  const w = world(t)
  await w.create()
  await w.due()
  const saved = JSON.parse(JSON.stringify(w.persisted.at(-1)))
  const restarted = world(t, { state: saved })
  await restarted.rt.runDueRoutines(Date.now())
  const task = (await restarted.call('schedules')).tasks[0]
  assert.deepEqual(task.target, { kind: 'bot', botId: 'writer' })
  assert.equal(task.lastRun.status, 'failed')
  assert.match(task.lastRun.error, /restart|interrupted/i)
  assert.equal(restarted.prompts.length, 0)
})

test('one-shot routines fire from the timer once and can be deleted by Bot target', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 })
  const w = world(t)
  const made = await w.create('writer', { kind: 'at', at: new Date(Date.now() + 1000).toISOString() })
  t.mock.timers.tick(1000)
  await drain()
  assert.equal(w.prompts.length, 1)
  w.event('part-1', 'turn/end', { reason: { kind: 'completed' } })
  await drain()
  t.mock.timers.tick(60_000)
  await drain()
  assert.equal(w.prompts.length, 1)
  assert.equal((await w.call('schedules')).tasks[0].status, 'ended')
  await w.call('schedule-delete', { id: made.tasks[0].id, target: { kind: 'bot', botId: 'writer' } })
  assert.deepEqual((await w.call('schedules')).tasks, [])
})

test('unknown Bot targets are refused without saving or sending', async t => {
  const w = world(t)
  await assert.rejects(w.create('missing'), /No such Bot/)
  assert.equal(w.persisted.length, 0)
  assert.equal(w.frames.length, 0)
})

test('cancelling a queued routine leaves a failed run instead of a stuck queued record', async t => {
  const w = world(t)
  await w.rt.sendThreadTurn({ botId: 'writer', kind: 'send', run: async () => {} })
  await w.create()
  await w.due()
  const [queued] = w.rt.threadQueueLive('writer').queued
  assert.equal(w.rt.threadQueueCancel('writer', queued.queueId).cancelled, true)
  await drain()
  assert.equal((await w.call('schedules')).tasks[0].lastRun.status, 'failed')
  assert.equal(w.prompts.length, 0)
})

test('node receipt respects the real Bot queue before sending to its real chat', async t => {
  const ctx = fakeContext()
  const calls = []
  const bot = { id: 'remote', sessionId: 'node-real-session' }
  const node = { ctx, state: { bots: { remote: bot }, threads: {} }, botOf: id => id === bot.id ? bot : undefined, chatOf: () => bot.sessionId }
  installQueue(node)
  node.sendUser = async request => { calls.push(request); setImmediate(() => node.settleJoinedTurn(request.requestId, 'finished on node')) }
  await node.sendThreadTurn({ botId: bot.id, kind: 'send', run: async () => {} })
  const receive = createBotTurnReceiver(node)
  const pending = receive({ remoteBotId: bot.id, exchangeId: 'node-routine', text: 'Check' })
  await drain()
  assert.equal(calls.length, 0)
  for (const listener of ctx.listeners.get('session/event')) listener({ id: bot.sessionId }, { type: 'turn/end' })
  assert.equal((await pending).text, 'finished on node')
  assert.equal(calls[0].sessionId, 'node-real-session')
  for (const listener of ctx.listeners.get('session/event')) listener({ id: bot.sessionId }, { type: 'turn/end' })
  t.after(() => ctx.dispose())
})

test('a joined routine waits for an existing page turn without dispatching twice', async t => {
  const w = world(t)
  w.rt.joinedInFlight = new Map([[w.joined.id, {}]])
  await w.create(w.joined.id)
  const task = await w.due()
  assert.equal(task.lastRun.status, 'queued')
  assert.equal(w.frames.length, 0)
  w.rt.joinedInFlight.clear()
  await new Promise(resolve => setTimeout(resolve, 120))
  await drain()
  assert.equal(w.frames.length, 1)
  assert.equal((await w.call('schedules')).tasks[0].lastRun.status, 'succeeded')
})

test('recurring routines skip old missed occurrences and hold while execution is unfinished', async t => {
  const w = world(t)
  const made = await w.create()
  const at = Date.parse(made.tasks[0].scheduledAt) + 10 * 60_000
  await w.rt.runDueRoutines(at)
  await drain()
  await w.rt.runDueRoutines(at + 60_000)
  assert.equal(w.prompts.length, 1)
  const task = (await w.call('schedules')).tasks[0]
  assert.equal(Date.parse(task.scheduledAt), at + 60_000)
  assert.equal(task.runs.length, 1)
  w.event('part-1', 'turn/end', { reason: { kind: 'completed' } })
})

test('daily and weekly Bot timing uses the selected time zone', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2030-01-06T00:00:00.000Z') })
  const w = world(t)
  await w.create('writer', { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' })
  const view = await w.create(w.joined.id, { kind: 'weekly', time: '09:00', timeZone: 'Asia/Shanghai', weekdays: [1] })
  assert.deepEqual(view.tasks.map(task => task.scheduledAt), ['2030-01-06T01:00:00.000Z', '2030-01-07T01:00:00.000Z'])
})

test('failure to save the occurrence prevents dispatch and keeps it due for retry', async t => {
  const w = world(t)
  const made = await w.create()
  const at = Date.parse(made.tasks[0].scheduledAt)
  const save = w.rt.save
  w.rt.save = async () => { throw new Error('disk full') }
  await assert.rejects(w.rt.runDueRoutines(at), /disk full/)
  assert.equal(w.prompts.length, 0)
  assert.equal((await w.call('schedules')).tasks[0].scheduledAt, made.tasks[0].scheduledAt)
  w.rt.save = save
  await w.rt.runDueRoutines(at)
  await drain()
  assert.equal(w.prompts.length, 1)
  w.event('part-1', 'turn/end', { reason: { kind: 'completed' } })
})

test('the real API, store and prompt wrappers execute and persist a Bot routine', async t => {
  const w = threadWorld({ services: { schedule: { edit() {}, catalog: async () => [] } } })
  t.after(async () => { await w.ctx.dispose(); rmSync(w.home, { recursive: true, force: true, maxRetries: 5 }) })
  const bot = await makeBot(w, 'Routine writer')
  const created = await w.call('schedule-create', { target: { kind: 'bot', botId: bot.id }, title: 'Check', prompt: 'Check the work', when: { kind: 'every', minutes: 1 } })
  assert.equal(created.ok, true)
  const task = created.value.tasks[0]
  await w.rt.runDueRoutines(Date.parse(task.scheduledAt))
  // The store serializes real disk writes before admitting the prompt.
  const deadline = Date.now() + 3000
  while (w.prompts.length === 0 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.prompts.length, 1, 'the admitted request must not queue behind its own routine')
  assert.equal(w.prompts[0].request.sessionId, w.rt.chatOf(bot.id))
  w.sessionEvent(w.rt.chatOf(bot.id), { type: 'turn/start', data: { turn: 1 } })
  w.sessionEvent(w.rt.chatOf(bot.id), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  while (Date.now() < deadline) {
    const saved = JSON.parse(readFileSync(join(w.home, 'state.json'), 'utf8')).routines[task.id]
    if (saved.lastRun.status === 'succeeded') {
      assert.equal(saved.runs[0].status, 'succeeded')
      return
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('completed routine must be written to the real team store')
})
