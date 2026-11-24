import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'
import { install as installTurns } from '../src/host/turns.js'
import { install as installParts } from '../src/host/parts.js'
import { HANDOFF_ACK, SOURCE_KIND } from '../src/host/constants.js'
import { estimateTokens } from '../src/host/text.js'

let rt

// A two-Bot team, optionally with b in a group Session 'gb' of room 'Ops'.
function team({ group = false } = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: group ? { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } } : {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// Services for a full apply(): resolveAgent returns a per-Session agent that
// records followup/steer/inject/cancel calls.
async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-messages-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  let created = 0
  const agents = new Map()
  // Every message any Session got, in order: a Bot's are those of its own chat and of its background tasks (its work
  // threads among them, work model W2), which `callsOf` and `turnTaker` follow.
  const log = []
  agents.botCalls = botId => log.filter(entry => entry.sessionId === botId || rt.taskOwners?.get(entry.sessionId)?.botId === botId
    || rt.pastOwners?.get(entry.sessionId)?.botId === botId).map(entry => entry.call)
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const messages = []
      const note = call => { call.sessionId = sessionId; calls.push(call); log.push({ sessionId, call }) }
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined, deriveMessages: () => messages },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { note(['followup', message]) },
        steer(message) { note(['steer', message]) },
        inject(message) { note(['inject', message]) },
        cancel(cause) { note(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++created}` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data, extra) => {
    if (type === 'user/message') agentOf(id).session.deriveMessages().push({ role: 'user', content: data.content, source: data.source })
    if (type === 'assistant/message') agentOf(id).session.deriveMessages().push({ ...data.message, role: 'assistant' })
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, ...extra })
    }
  }
  // Runs every registered waterfall listener; `next` settles the chain.
  const fire = (name, payload) => Promise.all((ctx.listeners.get(name) ?? []).map(listener => listener(payload, () => Promise.resolve(undefined))))
  // A Bot calls a tool from the turn it is running: its own chat, or the work thread it is working in (W2).
  const running = (id) => {
    if (rt.live.get(id)?.turn !== undefined || rt.botOf(id) === undefined) return id
    return (rt.botOf(id).tasks ?? []).find(task => rt.live.get(task.sessionId)?.turn !== undefined)?.sessionId ?? id
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: running(sessionId) } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const exchanges = async () => (await call('exchange', { a: 'a', b: 'b' })).value ?? []
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { rt, ctx, agents, agentOf, botCalls: agents.botCalls, emit, fire, tool, call, exchanges, home, stop }
}

const textOf = content => content.map(block => block.text ?? '').join('\n')

// Work model W2 (docs/plans/2026-11-24-work-model.md): a request goes to the work thread of the pair — one standing
// background task of the recipient for this sender's conversation — never into the user's chat with the recipient.
const threadOf = (rt, botId, senderId) => (rt.botOf(botId).tasks ?? []).find(task => task.origin === 'bot-work' && task.workFor?.botId === senderId)

test('message_bot opens the pair\'s work thread; a request goes there, never into the user\'s chat with the Bot', async (t) => {
  const { rt, agents, emit, tool, stop } = await start(team())
  t.after(stop)

  // Idle: the request opens Writer's work thread for Chief and starts its next turn there.
  const idle = await tool('message_bot', { to: 'Writer', message: 'how are you' }, 'a')
  assert.equal(idle, 'Delivered to Writer. What it hands back reaches you in one message once everything you handed on is back; do not wait for it, end your turn when you have handed on all you need.')
  const thread = threadOf(rt, 'b', 'a')
  assert.equal(thread.title, '@Chief · 工作')
  assert.deepEqual(callsOf(agents, 'b').map(call => [call[0], call.sessionId]), [['followup', thread.sessionId]])
  assert.match(textOf(callsOf(agents, 'b')[0][1].content), /^\[Message from Chief\]/)
  assert.equal(callsOf(agents, 'b')[0][1].source.role, 'request')
  assert.equal(agents.get('b'), undefined, 'nothing reaches the chat the user reads')

  // While the thread works on it, Chief's next message is added to that work at its next step (the one steer).
  emit(thread.sessionId, 'turn/start', { turn: 1 })
  const busy = await tool('message_bot', { to: 'Writer', message: 'watch out' }, 'a')
  assert.match(busy, /^Delivered to Writer while it is working: it reads your message at its next step and answers once that work is done\./)
  assert.deepEqual(callsOf(agents, 'b').map(call => [call[0], call.sessionId]), [['followup', thread.sessionId], ['steer', thread.sessionId]])

  // Its turn ends: the thread stands by for the next work of the pair, and the next request goes to the same thread.
  emit(thread.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled(() => thread.status === 'standing')
  assert.equal(thread.status, 'standing')
  assert.match(await tool('message_bot', { to: 'Writer', message: 'one more' }, 'a'), /^Delivered to Writer\./)
  assert.equal(callsOf(agents, 'b').at(-1).sessionId, thread.sessionId)
  assert.equal(rt.botOf('b').tasks.filter(task => task.origin === 'bot-work').length, 1)
})

test('message_bot when "queue" waits for the work the thread is on, and reply_to "user" goes to the user\'s chat', async (t) => {
  const { rt, agents, emit, tool, stop } = await start(team())
  t.after(stop)
  await tool('message_bot', { to: 'Writer', message: 'first' }, 'a')
  const thread = threadOf(rt, 'b', 'a')
  emit(thread.sessionId, 'turn/start', { turn: 1 })
  const queued = await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue' }, 'a')
  assert.match(queued, /^Queued for Writer: it reads your message after its current work\./)
  assert.deepEqual(callsOf(agents, 'b').map(call => [call[0], call.sessionId]), [['followup', thread.sessionId], ['followup', thread.sessionId]])

  const toUser = await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', when: 'now' }, 'a')
  assert.match(toUser, /^Delivered to Writer\. It will answer the user in its own chat; nothing comes back to you, so point the user to Writer's chat instead of relaying\./)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])
  assert.equal(agents.get('b').calls[0][1].source.audience, 'user')
})

test('a Bot busy in a group gets the request in its work thread, and the sender is told', async (t) => {
  const seed = team({ group: true })
  seed.rooms.r1.sessions.a = 'ga'
  const { rt, agents, emit, tool, stop } = await start(seed)
  t.after(stop)

  emit('gb', 'turn/start', { turn: 1 })
  const out = await tool('message_bot', { to: 'Writer', message: 'status?' }, 'a')
  assert.equal(out, 'Delivered to Writer. What it hands back reaches you in one message once everything you handed on is back; do not wait for it, end your turn when you have handed on all you need. Writer now: working in group "Ops" for less than a minute. Your message does not reach its work in group "Ops". If it must not go on there, use stop_bot.')
  assert.deepEqual(callsOf(agents, 'b').map(call => [call[0], call.sessionId]), [['followup', threadOf(rt, 'b', 'a').sessionId]])
  assert.equal(agents.get('gb'), undefined)

  // A non-Main sender gets no stop_bot hint.
  emit('ga', 'turn/start', { turn: 1 })
  const back = await tool('message_bot', { to: 'Chief', message: 'done' }, 'b')
  assert.equal(back, 'Delivered to Chief. What it hands back reaches you in one message once everything you handed on is back; do not wait for it, end your turn when you have handed on all you need. Chief now: working in group "Ops" for less than a minute. Your message does not reach its work in group "Ops".')
})

// A request that arrives in the Bot's own chat (another machine's, until W3) while the user's turn runs there.
const requestInto = async (rt, { from = 'a', to = 'b', text, steer = true }) => {
  const exchangeId = randomUUID()
  rt.openWork(exchangeId, { from, to })
  await rt.deliver({ fromId: from, toId: to, text, role: 'request', exchangeId, steer })
  return exchangeId
}

test('a request steered into a running turn is recorded once and answered in a turn of its own', async (t) => {
  const { rt, agents, emit, exchanges, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  await requestInto(rt, { text: 'which year is the data?' })
  const steered = agents.get('b').calls[0][1]
  emit('b', 'user/message', { content: steered.content, source: steered.source })
  emit('b', 'assistant/message', assistantText('the letter, for the user'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && agents.get('b').calls.length < 2; count += 1) await delay(5)

  // Nothing from the user's turn goes to Chief; the request comes back to Writer.
  assert.equal(agents.get('a')?.calls.length ?? 0, 0)
  const [kind, again] = agents.get('b').calls[1]
  assert.equal(kind, 'followup')
  assert.equal(textOf(again.content), '[Message from Chief · you read it during your last task; answer it now]\nwhich year is the data?')
  assert.equal(again.source.deferred, true)
  assert.equal(again.source.exchangeId, steered.source.exchangeId)
  assert.deepEqual((await exchanges()).map(entry => entry.role), ['request'])

  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: again.content, source: again.source })
  emit('b', 'assistant/message', assistantText('2025'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && (agents.get('a')?.calls ?? []).length < 1; count += 1) await delay(5)
  const reply = agents.get('a').calls[0][1]
  assert.equal(textOf(reply.content), '[Reply from Writer]\n2025')
  assert.equal(reply.source.replyTo, steered.source.exchangeId)
  assert.deepEqual((await exchanges()).map(entry => entry.role), ['request', 'reply'])
})

// Issue #580: a queued message the user steers into the running turn restarts
// the activity row's clock from when it landed, not from the turn's start.
test('a user message steered into the running steps marks when it landed', async (t) => {
  const { emit, call, stop } = await start(team())
  t.after(stop)
  const steered = async () => (await call('state', {})).value.work.steered ?? {}
  const userMessage = id => ({ id, role: 'user', content: textBlock('还没好吗'), source: { kind: 'user' } })
  const spliced = (target, inserted, time, extra = {}) => emit('b', 'agent/inbox/spliced', { target, start: 0, inserted, ...extra }, { time })

  emit('b', 'turn/start', { turn: 1 })
  // Queued for the next turn first; only moving it into the running steps steers.
  spliced('next-turn', [userMessage('m1')], 2000)
  assert.deepEqual(await steered(), {})
  spliced('next-turn', [], 3000, { removedCount: 1, outcome: 'canceled' })
  spliced('next-step', [userMessage('m1')], 3001)
  assert.equal((await steered()).b, 3001)
  // A Bot's request spliced into the same place is not the user's input.
  spliced('next-step', [{ ...userMessage('m2'), source: replySource('request') }], 4000)
  assert.equal((await steered()).b, 3001)
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await steered(), {})

  // A turn a part switch cut short may see turn/start without a turn/end.
  emit('b', 'turn/start', { turn: 2 })
  spliced('next-step', [userMessage('m3')], 5000)
  emit('b', 'turn/start', { turn: 3 })
  assert.deepEqual(await steered(), {})
})

test('a request from a name with brackets keeps its body when replayed after the current work', async (t) => {
  const seed = team()
  seed.bots.a.name = 'R]2'
  const { rt, agents, emit, stop } = await start(seed)
  t.after(stop)
  const body = 'Check [notes](https://example.test)\n[Keep this line]'
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  await requestInto(rt, { text: body })
  const steered = agents.get('b').calls[0][1]
  assert.equal(steered.source.senderName, 'R]2')
  emit('b', 'user/message', { content: steered.content, source: steered.source })
  emit('b', 'assistant/message', assistantText('the letter'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled(() => agents.get('b').calls.length === 2)
  const [kind, again] = agents.get('b').calls[1]
  assert.equal(kind, 'followup')
  assert.equal(again.source.exchangeId, steered.source.exchangeId)
  assert.equal(textOf(again.content), `[Message from R]2 · you read it during your last task; answer it now]\n${body}`)
})

test('a request its recipient has not read yet takes in the next one of the pair, however many come', async (t) => {
  const { rt, ctx, agentOf, emit, tool, exchanges, stop } = await start(team())
  t.after(stop)
  // The first request opens Writer's work thread for Chief; Writer takes it up, and that turn waits on something.
  await tool('message_bot', { to: 'Writer', message: 'task 0' }, 'a')
  const thread = threadOf(rt, 'b', 'a')
  const writer = agentOf(thread.sessionId)
  const first = writer.calls[0][1]
  emit(thread.sessionId, 'turn/start', { turn: 1 })
  emit(thread.sessionId, 'user/message', { content: first.content, source: first.source })
  writer.steer = (message) => { writer.calls.push(['steer', message]); writer.inbox.nextStep.push(message) }

  await tool('message_bot', { to: 'Writer', message: 'task 1' }, 'a')
  const second = await tool('message_bot', { to: 'Writer', message: 'task 2', when: 'queue' }, 'a')
  assert.match(second, /Writer had not read your earlier message yet, so this one was added to it, and it answers both at once\./)
  for (let index = 3; index <= 12; index += 1) await tool('message_bot', { to: 'Writer', message: `task ${index}` }, 'a')
  // One message, still steered, under the first unread one's exchange.
  assert.equal(writer.inbox.nextStep.length, 1)
  const [waiting] = writer.inbox.nextStep
  assert.equal(textOf(waiting.content), `[Message from Chief]\n${Array.from({ length: 12 }, (_, index) => `task ${index + 1}`).join('\n\n')}`)
  assert.equal(waiting.source.exchangeId, writer.calls[1][1].source.exchangeId)
  assert.deepEqual((await exchanges()).map(entry => entry.text.split('\n\n').length), [1, 12])

  // Once a step takes it up, the next message is a new one.
  emit(thread.sessionId, 'user/message', { content: waiting.content, source: waiting.source })
  writer.inbox.nextStep.length = 0
  assert.match(await tool('message_bot', { to: 'Writer', message: 'task 13' }, 'a'), /^Delivered to Writer while it is working/)
  assert.equal((await exchanges()).length, 3)

  // An approval the Bot waits for in that thread shows in what the sender is told.
  for (const listener of ctx.listeners.get('approval/request')) void listener({ agent: { session: { id: thread.sessionId } }, toolName: 'bash', reason: 'rm' }, () => new Promise(() => {}))
  assert.match(await tool('message_bot', { to: 'Writer', message: 'task 14' }, 'a'), /Writer now: waiting for the user's approval to run bash in background task "@Chief · 工作" \(for less than a minute\)/)
})

test('requests from two Bots, or from two conversations of one Bot, go to work threads of their own', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const { rt, agents, emit, tool, stop } = await start(seed)
  t.after(stop)
  await tool('message_bot', { to: 'Writer', message: 'from Chief' }, 'a')
  await tool('message_bot', { to: 'Writer', message: 'from Tester' }, 'c')
  // Tester, now working on what Chief asked it for (in its thread for Chief), writes for that work.
  await tool('message_bot', { to: 'Tester', message: 'check it' }, 'a')
  const testerThread = threadOf(rt, 'c', 'a')
  const ask = callsOf(agents, 'c').at(-1)[1]
  emit(testerThread.sessionId, 'turn/start', { turn: 1 })
  emit(testerThread.sessionId, 'user/message', { content: ask.content, source: ask.source })
  await tool('message_bot', { to: 'Writer', message: 'for that check' }, 'c')
  const writerThreads = rt.botOf('b').tasks.filter(task => task.origin === 'bot-work')
  assert.deepEqual(writerThreads.map(task => [task.workFor.botId, task.title]), [['a', '@Chief · 工作'], ['c', '@Tester · 工作'], ['c', '@Tester · 工作']])
  assert.equal(new Set(writerThreads.map(task => task.sessionId)).size, 3)
  assert.equal(new Set(callsOf(agents, 'b').map(call => call.sessionId)).size, 3)
})

test('a non-Main Bot can hand work to a Main Bot', async (t) => {
  const { rt, agents, tool, stop } = await start(team())
  t.after(stop)

  const out = await tool('message_bot', { to: 'Chief', message: 'heads up' }, 'b')
  assert.equal(out, 'Delivered to Chief. What it hands back reaches you in one message once everything you handed on is back; do not wait for it, end your turn when you have handed on all you need.')
  assert.deepEqual(callsOf(agents, 'a').map(call => [call[0], call.sessionId]), [['followup', threadOf(rt, 'a', 'b').sessionId]])
  assert.equal(callsOf(agents, 'a')[0][1].source.senderSessionId, 'b')
})

test('stop_bot cancels the running turns and tells the Bot why in a new turn', async (t) => {
  const { agents, emit, tool, stop } = await start(team({ group: true }))
  t.after(stop)

  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'a'), /not running/)
  assert.deepEqual(agents.get('b')?.calls ?? [], [])

  emit('b', 'turn/start', { turn: 1 })
  emit('gb', 'turn/start', { turn: 1 })
  const out = await tool('stop_bot', { bot: 'Writer', reason: 'that command deletes data' }, 'a')
  assert.match(out, /Stopped Writer in its own chat and group "Ops"/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['cancel', 'followup'])
  assert.deepEqual(agents.get('b').calls[0][1], { kind: 'hook', reason: 'ds-bot/stopped' })
  assert.deepEqual(agents.get('gb').calls.map(([kind]) => kind), ['cancel'])
  const notice = agents.get('b').calls[1][1]
  assert.match(textOf(notice.content), /^\[Stopped by Chief\]\nthat command deletes data$/)
  assert.equal(notice.source.role, 'stopped')
})

test('stop_bot belongs to a Main Bot', async (t) => {
  const { tool, stop } = await start(team())
  t.after(stop)

  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'b'), { message: 'Only a Main Bot can stop other Bots.' })
  await assert.rejects(tool('stop_bot', { bot: 'Chief' }, 'a'), { message: 'You cannot stop yourself.' })
  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'a'), { message: 'Writer is not running right now, so there is nothing to stop. Use message_bot to reach it.' })
})

function turnsHost() {
  let listener
  const delivered = []
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map(),
    botOf: id => rt.bots[id],
    selfOf: id => id,
    save: async () => {},
    deliver: async (args) => { delivered.push(args) },
    noteFailure() {},
    warn() {},
    switchJobs: () => [],
    userWrote() {},
  }
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { rt, emit, delivered }
}

const replySource = (role, extra = {}) => ({ kind: SOURCE_KIND, role, senderSessionId: 'a', senderName: 'Chief', exchangeId: 'x1', ...extra })
const textBlock = (content) => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })

for (const [name, source, hidden] of [
  ['private work continuation', replySource('reply', { work: 'parent' }), true],
  ['restarted private work continuation', replySource('resume', { work: 'parent', resumed: true }), true],
  ['part-switched private work continuation', replySource('reply', { work: 'parent', handoff: true, resume: true }), true],
  ['direct private request', replySource('request', { exchangeId: 'parent' }), true],
  ['user-owned reply', replySource('reply', { work: 'user-work' }), false],
  ['ordinary reply', replySource('reply'), false],
  ['missing work reply', replySource('reply', { work: 'missing' }), false],
  ['another Bot\'s work reply', replySource('reply', { work: 'other-work' }), false],
  ['explicit user-audience request', replySource('request', { audience: 'user', work: 'parent' }), false],
]) {
  for (const pending of [false, true]) {
    test(`${name} is ${hidden ? 'hidden' : 'visible'} when claimed ${pending ? 'from pending input' : 'during a turn'}`, async (t) => {
      const { rt, emit, stop } = await start(team())
      t.after(stop)
      rt.openWork('parent', { from: 'a', to: 'b' })
      rt.openWork('user-work', { to: 'b' })
      rt.openWork('other-work', { from: 'a', to: 'a' })
      const message = () => emit('b', 'user/message', { content: textBlock('result'), source })
      if (pending) message()
      emit('b', 'turn/start', { turn: 7 })
      if (!pending) message()
      assert.deepEqual(rt.state.exchangeTurns.b ?? [], hidden ? [7] : [])
    })
  }
}

test('a stopped notice routes the acknowledgement back like a request', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Stopped by Chief]\nwhy'), source: replySource('stopped', { exchangeId: 's1' }) })
  assert.deepEqual(rt.state.exchangeTurns.b, [1])
  emit('b', 'assistant/message', assistantText('understood'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].role, 'reply')
  assert.equal(delivered[0].replyTo, 's1')
  assert.equal(delivered[0].text, 'understood')
})

// What the turn hands back for a joined request: the request itself, to answer next.
const deferredOf = job => [job.fromId, job.toId, job.sessionId, job.role, job.exchangeId, job.deferred, job.text]

test('a request that joins a user-started turn is handed back, not answered with the turn\'s text', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmake it shorter'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.map(deferredOf), [['a', 'b', 'b', 'request', 'e1', true, 'make it shorter']])
  assert.deepEqual(rt.state.exchangeTurns, {})

  // The handed-back request opens a hidden turn whose text is the reply.
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief · you read it during your last task; answer it now]\nmake it shorter'), source: replySource('request', { exchangeId: 'e1', deferred: true }) })
  emit('b', 'assistant/message', assistantText('done, it is shorter'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.slice(1).map(job => [job.toId, job.role, job.replyTo, job.text]), [['a', 'reply', 'e1', 'done, it is shorter']])
  assert.deepEqual(rt.state.exchangeTurns, { b: [2] })
})

test('a request that joins a Bot-triggered turn is handed back; the trigger gets the whole turn', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(rt.state.exchangeTurns.b, [1])
  assert.deepEqual(delivered.map(job => [job.role, job.replyTo ?? job.exchangeId, job.text]), [['reply', 'e0', 'first half\n\nsecond half'], ['request', 'e1', 'more']])
})

test('a joined request in a stopped turn tells its sender, and is not handed back', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/stopped' } } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].replyTo, 'e1')
  assert.match(delivered[0].text, /was stopped before it could answer/)
})

test('a joined request gets the failure notice when the model call fails', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: 'upstream busy', status: 503 } } })
  // This fork also retries a failed turn by itself (a 'retry' to the Bot); the sender is told once.
  const toSender = delivered.filter(job => job.toId === 'a')
  assert.equal(toSender.length, 1)
  assert.equal(toSender[0].replyTo, 'e1')
  assert.match(toSender[0].text, /^Writer could not answer your message: its model call failed \(SERVER 503: upstream busy\)/)
})

test('a content-audit 403 stays on its turn without blocking the key', () => {
  const { rt, emit } = turnsHost()
  const body = 'upstream 403 request-id=00000000-0000-4000-8000-000000000000: {"error":{"message":"内容审计命中风险规则，请调整输入后重试","type":"content_policy_violation"}}'
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write it'), source: { kind: 'user' } })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', status: 403, message: body } } })
  const failure = rt.bots.b.failures.b
  assert.equal(failure.turn, 1)
  assert.equal(failure.code, 'CONTENT_POLICY')
  assert.equal(failure.status, 403)
  assert.equal(failure.requestId, '00000000-0000-4000-8000-000000000000')
  assert.match(failure.message, /content_policy_violation/)
  // No key repair: the Bot stays usable and no blocked credential state is set.
  assert.equal(rt.bots.b.blocked, undefined)
  // A completed turn in the same part drops the record.
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('hello'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('hi'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(rt.bots.b.failures, undefined)
})

test('a real auth failure still blocks the Bot', () => {
  const { rt, emit } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('hi'), source: { kind: 'user' } })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', status: 401, message: 'invalid key sk-12' } } })
  assert.equal(rt.bots.b.blocked.code, 'AUTH')
  assert.equal(rt.bots.b.failures.b.code, 'AUTH')
  assert.equal(rt.bots.b.failures.b.message, '')
})

test('a 401 mentioning content_filter stays AUTH, and remembered errors redact keys', () => {
  const { rt, emit } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('hi'), source: { kind: 'user' } })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', status: 401, message: 'Authentication failed for content_filter service' } } })
  assert.equal(rt.bots.b.blocked.code, 'AUTH')
  assert.equal(rt.bots.b.failures.b.code, 'AUTH')
  assert.equal(rt.bots.b.failures.b.message, '')
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('hi'), source: { kind: 'user' } })
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'SERVER', status: 500, message: 'upstream echoed sk-secretkey123456' } } })
  assert.doesNotMatch(rt.bots.b.failures.b.message, /sk-secretkey123456/)
  assert.match(rt.bots.b.failures.b.message, /sk-\[hidden\]/)
})

test('a joined request never claims the next turn', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('answer'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('next task'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('for the user'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.map(job => [job.role, job.exchangeId, job.deferred]), [['request', 'e1', true]])
  assert.deepEqual(rt.state.exchangeTurns, {})
})

test('a schedule-started turn stays visible when a request joins', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('routine'), source: { kind: 'schedule' } })
  emit('b', 'assistant/message', assistantText('before'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('after'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.map(job => [job.role, job.exchangeId, job.text]), [['request', 'e1', 'more']])
  assert.deepEqual(rt.state.exchangeTurns, {})
})

test('a duplicate exchangeId joins no second reply', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('answer'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'e0')
})

test('a joined request crosses a part switch and is handed back in the new part', async (t) => {
  const { agents, agentOf, emit, fire, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  // The model call hits the window: the turn stops and the part moves on.
  await fire('agent/request-error', { failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000), agent: agentOf('b') })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } })
  // Neither the trigger nor the joined request answers from the old part.
  for (let count = 0; count < 200 && agents.get('s1')?.calls.find(([, message]) => message.source?.handoff === true) === undefined; count += 1) await delay(5)
  const handoff = agents.get('s1').calls.find(([, message]) => message.source?.handoff === true)[1]
  assert.equal((agents.get('a')?.calls ?? []).filter(([, message]) => message.source?.role === 'reply').length, 0)
  assert.equal(handoff.source.exchangeId, 'e0')
  assert.deepEqual(handoff.source.joined.map(item => [item.info.exchangeId, item.text]), [['e1', 'more']])

  // The resumed turn answers its trigger and hands the joined request back there.
  emit('s1', 'turn/start', { turn: 1 })
  emit('s1', 'user/message', { content: textBlock('[Handoff]\npackage'), source: handoff.source })
  emit('s1', 'assistant/message', assistantText('done'))
  emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const handedBack = () => agents.get('s1').calls.find(([, message]) => message.source?.deferred === true)
  for (let count = 0; count < 200 && ((agents.get('a')?.calls ?? []).length < 1 || handedBack() === undefined); count += 1) await delay(5)
  const replies = (agents.get('a')?.calls ?? []).filter(([, message]) => message.source?.role === 'reply')
  assert.deepEqual(replies.map(([, message]) => message.source.replyTo), ['e0'])
  assert.equal(textOf(replies[0][1].content), '[Reply from Writer]\ndone')
  assert.equal(handedBack()[0], 'followup')
  assert.equal(handedBack()[1].source.exchangeId, 'e1')
  assert.equal(textOf(handedBack()[1].content), '[Message from Chief · you read it during your last task; answer it now]\nmore')
})

// Each Session takes up the newest message it was sent as its next turn.
// A Bot's turn runs in the Session its newest message went to: its own chat, or a work thread (work model W2).
function turnTaker(agents, emit) {
  const turns = new Map()
  const at = new Map()
  const take = (id) => {
    const call = callsOf(agents, id).at(-1)
    const [, message] = call
    const sessionId = call.sessionId ?? id
    at.set(id, sessionId)
    turns.set(sessionId, (turns.get(sessionId) ?? 0) + 1)
    emit(sessionId, 'turn/start', { turn: turns.get(sessionId) })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const end = (id, text) => {
    const sessionId = at.get(id) ?? id
    if (text !== undefined) emit(sessionId, 'assistant/message', assistantText(text))
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  const userTurn = (id, text) => {
    at.set(id, id)
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: textBlock(text), source: { kind: 'user' } })
  }
  return { take, end, userTurn, sessionOf: id => at.get(id) ?? id }
}
const settled = async (check) => {
  for (let count = 0; count < 200 && !check(); count += 1) await delay(5)
}
const threeBots = () => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  return seed
}
const callsOf = (agents, id) => (agents.botCalls ? agents.botCalls(id) : agents.get(id)?.calls ?? [])
// What state.json holds once the saves made so far are done: a save waits for the earlier
// ones, and a read while one renames the file over makes that save fail on Windows.
const worksIn = async ({ call, home }) => {
  await call('set-prefs', {})
  return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).works ?? {}
}

// Chief asks Writer, which hands part of it on to Tester.
async function handedOn({ agents, emit, tool }) {
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'carry out the plan' }, 'a')
  turns.end('a', 'asked Writer')
  turns.take('b')
  const handed = await tool('message_bot', { to: 'Tester', message: 'review my work' }, 'b')
  return { ...turns, handed }
}

test('a Bot\'s answer waits for the work it handed on, and carries what came back', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, tool, call } = team
  const shown = async () => { const { value } = await call('state', {}); return [value.activity.b === 'waiting', value.work.waiting] }
  const { take, end, handed } = await handedOn(team)
  // Chief's own turn (the user's) handed the work on: Chief waits for Writer, under a root work of its own.
  const [, rootWaiting] = await shown()
  assert.deepEqual(Object.keys(rootWaiting), ['a'])
  assert.deepEqual(rootWaiting.a.waits.map(wait => [wait.to, wait.name]), [['b', 'Writer']])
  assert.match(handed, /end your turn when you have handed on all you need\. Your answer goes to Chief after that\.$/)
  end('b', 'handed it to Tester')
  // Nothing goes up yet; Writer waits, and the team can see it.
  assert.match(await tool('list_bots', {}, 'a'), /- Writer \(Write\)\n {2}now: waiting for Tester to hand back work, for Chief\n/)
  assert.deepEqual(Object.values(await worksIn(team)).map(work => [work.from, work.to, work.open.length, work.held, work.origin]), [[undefined, 'a', 1, 'asked Writer', 'person'], ['a', 'b', 1, 'handed it to Tester', undefined], ['b', 'c', 0, undefined, undefined]])
  assert.deepEqual(callsOf(agents, 'a'), [])
  // Its mark shows it waits, its row whom for, and the menu names the wait to give up.
  const [, waitingWork] = await shown()
  const waits = waitingWork.b.waits
  assert.equal(waits.length, 1)
  assert.equal(typeof waits[0].id, 'string')
  assert.deepEqual([waits[0].to, waits[0].name], ['c', 'Tester'])
  delete waitingWork.b.waits
  delete waitingWork.a.waits
  assert.deepEqual(waitingWork, { a: { bots: ['b'], rooms: [], for: [] }, b: { bots: ['c'], rooms: [], for: ['a'] } })

  take('c')
  end('c', 'two things to fix')
  await settled(() => callsOf(agents, 'b').length === 2)
  const back = take('b')
  assert.deepEqual(Object.keys((await shown())[1]), ['a'], 'Writer goes on with its work; Chief still waits for it')
  assert.equal(textOf(back.content), '[Work handed back to you · from Tester · everything you handed on for the work Chief asked you for is back; your answer goes to Chief]\nTester:\ntwo things to fix')
  end('b', 'fixed both')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nfixed both\n\n[Handed back to Writer for this work]\n\nTester:\ntwo things to fix')
  assert.match(await tool('list_bots', {}, 'a'), /- Writer \(Write\)\n {2}now: idle\n/)
  // Chief goes on with what came back, in one turn of its own chat; then nothing is left open.
  take('a')
  end('a', 'all done, here it is')
  assert.deepEqual(await shown(), [false, {}])
  assert.deepEqual(await worksIn(team), {})
})

test('a Bot may take part in the same work again, but not message one that waits for its result', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, tool } = team
  // Chief designs, Writer builds, Tester reviews; then Chief accepts.
  const { take, end } = await handedOn(team)
  end('b')
  take('c')
  // The guard answers with a result, not a failed call: the turn goes on with the
  // work, and the result says where its answer goes.
  const refused = /^Not sent: (Chief|Writer) is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back\./
  assert.match(await tool('message_bot', { to: 'Chief', message: 'please accept it' }, 'c'), refused)
  assert.match(await tool('message_bot', { to: 'Writer', message: 'it passes' }, 'c'), refused)
  assert.deepEqual(callsOf(agents, 'a'), [])
  assert.equal(callsOf(agents, 'b').length, 1)
  end('c', 'it passes')
  await settled(() => callsOf(agents, 'b').length === 2)
  take('b')
  end('b', 'built and reviewed')
  await settled(() => callsOf(agents, 'a').length === 1)
  take('a')
  // With the result in hand, Chief asks Tester again, and Tester may ask Writer.
  assert.match(await tool('message_bot', { to: 'Tester', message: 'check the last part once more' }, 'a'), /^Delivered to Tester/)
  end('a')
  take('c')
  assert.match(await tool('message_bot', { to: 'Writer', message: 'what did you change last?' }, 'c'), /^Delivered to Writer/)
  assert.match(await tool('message_bot', { to: 'Chief', message: 'done' }, 'c'), refused)
})

test('message_bot tells the Bot not to message one that waits for its result', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { description } = team.rt.teamTools.find(definition => definition.name === 'message_bot')
  assert.match(description, /Do not message a Bot that is waiting for the result of the work you are doing \(the Bot that asked you for it, or one above that\): your answer reaches it by itself once you end your turn and everything you handed on is back\./)
})

// Chief asks Writer, and Writer messages Chief with what it has instead of answering.
async function refusedUp({ agents, emit, tool }) {
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'write the summary' }, 'a')
  turns.end('a', 'asked Writer')
  turns.take('b')
  const refused = await tool('message_bot', { to: 'Chief', message: 'Here is the summary: all three parts are done.' }, 'b')
  return { ...turns, refused }
}

test('a message refused because its Bot waits for the result goes up as the answer', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents } = team
  const { take, end, refused } = await refusedUp(team)
  assert.equal(refused, 'Not sent: Chief is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Your message was kept as your answer. If you end your turn without writing any text, it goes up to Chief; any text you write for this work from now on goes up instead.')
  assert.deepEqual(callsOf(agents, 'a'), [])
  end('b')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nHere is the summary: all three parts are done.')
  take('a')
  end('a', 'noted')
  assert.deepEqual(await worksIn(team), {})
})

test('a final answer replaces the refused message it kept', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents } = team
  const { end } = await refusedUp(team)
  assert.equal(Object.values(await worksIn(team)).find(work => work.to === 'b').held, 'Here is the summary: all three parts are done.')
  end('b', 'The summary, final.')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nThe summary, final.')
})

test('messages refused in one turn add up to the answer, and the refusal says so', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, tool } = team
  const { end } = await refusedUp(team)
  assert.equal(await tool('message_bot', { to: 'Chief', message: 'One more thing: part two needs a review.' }, 'b'), 'Not sent: Chief is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Your message was kept as your answer, after what was kept before in this turn. If you end your turn without writing any text, it goes up to Chief; any text you write for this work from now on goes up instead.')
  end('b')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nHere is the summary: all three parts are done.\n\nOne more thing: part two needs a review.')
})

test('a message refused in a later turn replaces what an earlier turn kept, and the refusal says so', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, tool } = team
  const { take, end } = await handedOn(team)
  assert.match(await tool('message_bot', { to: 'Chief', message: 'Built it; Tester is reviewing.' }, 'b'), /^Not sent: Chief is waiting/)
  end('b')
  take('c')
  end('c', 'looks good')
  await settled(() => callsOf(agents, 'b').length === 2)
  take('b')
  assert.equal(await tool('message_bot', { to: 'Chief', message: 'Built and reviewed.' }, 'b'), 'Not sent: Chief is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Your message was kept as your answer, in place of what was kept for this work before this turn. If you end your turn without writing any text, it goes up to Chief; any text you write for this work from now on goes up instead.')
  end('b')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nBuilt and reviewed.\n\n[Handed back to Writer for this work]\n\nTester:\nlooks good')
})

test('a refused message stays the answer while the work waits for what was handed on', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, tool } = team
  const { take, end } = await handedOn(team)
  assert.match(await tool('message_bot', { to: 'Chief', message: 'Built it; Tester is reviewing.' }, 'b'), /^Not sent: Chief is waiting/)
  end('b')
  assert.equal(Object.values(await worksIn(team)).find(work => work.to === 'b').held, 'Built it; Tester is reviewing.')
  take('c')
  end('c', 'looks good')
  await settled(() => callsOf(agents, 'b').length === 2)
  take('b')
  end('b')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nBuilt it; Tester is reviewing.\n\n[Handed back to Writer for this work]\n\nTester:\nlooks good')
})

test('a long refused message keeps its start as the answer, and the refusal says so', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'write the report' }, 'a')
  turns.end('a')
  turns.take('b')
  const report = 'x'.repeat(2500)
  const refused = await tool('message_bot', { to: 'Chief', message: report }, 'b')
  assert.match(refused, /Only its first 2000 characters were kept as your answer\. To send all of it, write it in full as your answer\. If you end your turn without writing any text, that part goes up to Chief;/)
  turns.end('b')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), `[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\n${report.slice(0, 2000)}`)
})

test('a message refused after a long one in the same turn keeps the start of both, and the refusal says so', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'write the report' }, 'a')
  turns.end('a')
  turns.take('b')
  const report = `${'x'.repeat(1990)}${'y'.repeat(510)}`
  await tool('message_bot', { to: 'Chief', message: report }, 'b')
  const refused = await tool('message_bot', { to: 'Chief', message: 'One more thing.' }, 'b')
  assert.match(refused, /Your message was kept as your answer, after what was kept before in this turn, but only the first 2000 characters of all of it\. To send all of it, write it in full as your answer\./)
  turns.end('b')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), `[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\n${report.slice(0, 2000)}`)
})

test('a message refused because a Bot further up waits goes to the direct asker, and the refusal says so', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, tool } = team
  const { take, end } = await handedOn(team)
  end('b')
  take('c')
  assert.equal(await tool('message_bot', { to: 'Chief', message: 'Chief, it passes.' }, 'c'), 'Not sent: Chief is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Your message was kept as your answer. If you end your turn without writing any text, it goes up to Writer as your answer, and reaches Chief with Writer\'s answer; any text you write for this work from now on goes up instead.')
  end('c')
  await settled(() => callsOf(agents, 'b').length === 2)
  assert.equal(textOf(take('b').content), '[Work handed back to you · from Tester · everything you handed on for the work Chief asked you for is back; your answer goes to Chief]\nTester:\nChief, it passes.')
  assert.deepEqual(callsOf(agents, 'a'), [])
})

test('a message refused after the turn wrote text is not kept, and the refusal says so', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'write the summary' }, 'a')
  turns.end('a')
  turns.take('b')
  emit(turns.sessionOf('b'), 'assistant/message', assistantText('Let me send Chief the summary.'))
  assert.equal(await tool('message_bot', { to: 'Chief', message: 'The summary.' }, 'b'), 'Not sent: Chief is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Your message was not kept: this turn already wrote text, and that goes up to Chief. Write the message in your final answer.')
  assert.equal(Object.values(await worksIn(team)).find(work => work.to === 'b').held, undefined)
  turns.end('b')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nLet me send Chief the summary.')
})

test('a queued or user-facing message to a Bot that waits for the result is not kept as the answer', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'write the summary' }, 'a')
  turns.end('a')
  turns.take('b')
  const plain = 'Not sent: Chief is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Finish the work and end your turn; to ask Chief something, end your turn with the question.'
  assert.equal(await tool('message_bot', { to: 'Chief', message: 'Unrelated: review doc Z later?', when: 'queue' }, 'b'), plain)
  assert.equal(await tool('message_bot', { to: 'Chief', message: 'Tell the user hi', reply_to: 'user' }, 'b'), plain)
  assert.equal(Object.values(await worksIn(team)).find(work => work.to === 'b').held, undefined)
  turns.end('b')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nWriter finished without a reply.')
})

test('a stopped turn answers at once, and what it handed on comes back to it alone', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit } = team
  const { take, end, sessionOf } = await handedOn(team)
  emit(sessionOf('b'), 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nWriter was stopped before it could answer your message.')

  take('c')
  end('c', 'reviewed')
  await settled(() => callsOf(agents, 'b').length === 2)
  // Writer's work ended when it was stopped: Tester's answer comes back to Writer alone, as a plain reply.
  assert.equal(textOf(callsOf(agents, 'b')[1][1].content), '[Reply from Tester]\nreviewed')
  take('b')
  end('b', 'noted')
  await delay(20)
  assert.equal(callsOf(agents, 'a').length, 1)
})

test('a result read during other work comes back in a turn of its own and goes on with its work', async (t) => {
  const seed = threeBots()
  seed.bots.a.name = 'Chief [ops]'
  const team = await start(seed)
  t.after(team.stop)
  const { agents, emit } = team
  const { take, end, userTurn } = await handedOn(team)
  end('b', 'handed it on')
  take('c')
  end('c', 'reviewed')
  await settled(() => callsOf(agents, 'b').length === 2)
  const [, result] = callsOf(agents, 'b')[1]
  // The user's turn reads the result along with the user's message.
  userTurn('b', 'an unrelated question')
  emit('b', 'user/message', { content: result.content, source: result.source })
  end('b', 'the answer for the user')
  await settled(() => callsOf(agents, 'b').length === 3)
  const [kind, again] = callsOf(agents, 'b')[2]
  assert.equal(kind, 'followup')
  assert.equal(textOf(again.content), '[Work handed back to you · from Tester · you read it during your last task; go on with that work now · everything you handed on for the work Chief [ops] asked you for is back; your answer goes to Chief [ops]]\nTester:\nreviewed')
  assert.deepEqual(callsOf(agents, 'a'), [])
  take('b')
  end('b', 'done after the review')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\ndone after the review\n\n[Handed back to Writer for this work]\n\nTester:\nreviewed')
})

test('deleting a Bot that waits for work it handed on tells the Bot that asked', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, call } = team
  const { take, end } = await handedOn(team)
  end('b', 'handed it on')
  assert.equal((await call('delete-bot', { id: 'b' })).ok, true)
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Work handed back to you · from Writer · everything you handed on is back]\nWriter:\nWriter was deleted before it could answer your message.')
  take('a')
  end('a', 'Writer is gone; I will do it myself')
  assert.deepEqual(await worksIn(team), {})
})

test('an answer that grows past 20,000 characters with what came back goes as a file', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { ctx, agents } = team
  const store = fakeAttachments()
  ctx.get = name => (name === 'attachments' ? store : undefined)
  const { take, end } = await handedOn(team)
  end('b', 'handed it on')
  take('c')
  const review = '审查意见。'.repeat(3000)
  end('c', review)
  await settled(() => callsOf(agents, 'b').length === 2)
  take('b')
  end('b', '改好了。'.repeat(1500))
  await settled(() => callsOf(agents, 'a').length === 1)
  const [text, file] = callsOf(agents, 'a')[0][1].content
  const whole = `${'改好了。'.repeat(1500)}\n\n[Handed back to Writer for this work]\n\nTester:\n${review}`
  // Handed back to Chief's own work, whole: one message, as a file past what a message carries.
  assert.ok(text.text.startsWith(`[Work handed back to you · from Writer · everything you handed on is back]\n[A long message: ${whole.length + 'Writer:\n'.length} characters.`))
  assert.equal(file.attachment.name, 'Work handed back.txt')
  assert.equal(new TextDecoder().decode(store.files.get(file.attachment.attachmentId)), `Writer:\n${whole}`)
})

test('Bots keep messaging and posting with no count of messages or rounds', async (t) => {
  const { agents, tool, stop } = await start(team({ group: true }))
  t.after(stop)
  for (let count = 0; count < 60; count += 1) assert.match(await tool('message_bot', { to: 'Writer', message: `ping ${count}` }, 'a'), /^Delivered to Writer/)
  for (let count = 0; count < 5; count += 1) assert.match(await tool('post_to_group', { group: 'Ops', message: `note ${count}` }, 'a'), /^Posted in "Ops"/)
  // All sixty went to Writer's one work thread for Chief.
  assert.equal(callsOf(agents, 'b').length, 60)
  assert.equal(new Set(callsOf(agents, 'b').map(call => call.sessionId)).size, 1)
  assert.equal(agents.get('r1').calls.length, 5)
})

// A Writer whose earlier part b1 holds `events`.
function earlierParts(events) {
  const writer = { id: 'b', name: 'Writer', createdAt: 1, sessionId: 'b2', segments: [{ sessionId: 'b1', endedAt: 2 }] }
  const rt = {
    ctx: { on() {}, effect() {}, get() {}, sessionController: { page: async () => ({ records: events.map(event => ({ event })), hasMore: false }) } },
    config: {},
    state: { exchangeTurns: {} },
    chatOwners: new Map([['b2', 'b']]),
    pastOwners: new Map([['b1', { botId: 'b' }]]),
    botOf: id => (id === 'b' ? writer : undefined),
    roomOf: () => undefined,
    chatOf: () => 'b2',
    resolveAgent: async id => ({ session: { id, seq: 3 } }),
  }
  installParts(rt)
  return rt
}

test('an earlier part keeps the request its Bot answered', async () => {
  const rt = earlierParts([
    { type: 'user/message', seq: 1, time: 10, data: { turn: 1, content: [{ type: 'text', text: '[Message from Chief]\nDo not delete that' }], source: replySource('request') } },
    { type: 'assistant/message', seq: 2, time: 11, data: { turn: 1, message: { content: [{ type: 'text', text: 'Understood, I stopped.' }] } } },
  ])
  const { items } = await rt.earlierPage('b2')
  assert.deepEqual(items.map(item => [item.kind, item.role ?? item.text]), [['event', 'request'], ['bot', 'Understood, I stopped.']])
  assert.equal(items[0].botId, 'a')
})

// #537: an archived earlier part may have no live agent to resolve; the page
// still loads from the stored events.
test('an earlier part loads when its agent is gone', async () => {
  const rt = earlierParts([
    { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: 'still here' }], source: { kind: 'user' } } },
  ])
  rt.resolveAgent = async () => { throw Object.assign(new Error('Session unavailable'), { code: 'session/gone' }) }
  const { items } = await rt.earlierPage('b2')
  assert.deepEqual(items.map(item => [item.kind, item.text]), [['user', 'still here']])
})

// #537: a turn that spans a page boundary keeps its number on the newer page
// even when the part's agent is gone (no live projection to seed it).
test('an agentless part keeps the turn that opened on an older page', async () => {
  const events = [{ seq: 1, type: 'turn/start', time: 1, data: { turn: 6 } }]
  for (let seq = 2; seq <= 430; seq += 1) {
    events.push({ seq, type: 'user/message', time: seq, data: { content: [{ type: 'text', text: `m${seq}` }], source: { kind: 'user' } } })
  }
  const rt = earlierParts([])
  rt.ctx.sessionController.page = async ({ beforeSeq, maxMessages }) => {
    let list = events.filter(event => !Number.isInteger(beforeSeq) || event.seq < beforeSeq)
    const hasMore = list.length > maxMessages
    if (hasMore) list = list.slice(-maxMessages)
    return { records: list.map(event => ({ event })), hasMore }
  }
  rt.resolveAgent = async () => { throw Object.assign(new Error('Session unavailable'), { code: 'session/gone' }) }
  const { items } = await rt.earlierPage('b2')
  const first = items.find(item => item.kind !== 'divider')
  assert.equal(first?.kind, 'user')
  assert.equal(first?.turn, 6)
})

test('each text block of a Bot message is an entry of its own, as each is a bubble of its own', async () => {
  const rt = earlierParts([
    { type: 'assistant/message', seq: 1, time: 11, data: { turn: 1, message: { content: [{ type: 'text', text: 'First.' }, { type: 'tool-call', id: 'c1' }, { type: 'text', text: '  ' }, { type: 'text', text: 'Second.' }] } } },
  ])
  const { items } = await rt.earlierPage('b2')
  assert.deepEqual(items.map(item => [item.kind, item.text, item.time]), [['bot', 'First.', 11], ['bot', 'Second.', 11]])
})

test('earlier-part rows carry seq and the turn that turn/start opened', () => {
  const rt = earlierParts([])
  const items = rt.displayItems('b1', [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'before' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 9, message: { content: [{ type: 'text', text: 'also before' }, { type: 'text', text: 'second bubble' }] } } },
    { type: 'turn/start', seq: 3, time: 3, data: { turn: 4 } },
    { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 5, time: 5, data: { turn: 99, message: { content: [{ type: 'text', text: 'working' }] } } },
    { type: 'user/message', seq: 6, time: 6, data: { content: [{ type: 'text', text: '[Message from Chief]\nsteer' }], source: replySource('request') } },
    { type: 'user/message', seq: 7, time: 7, data: { content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 8, time: 8, data: { turn: 5 } },
    { type: 'user/message', seq: 9, time: 9, data: { content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } } },
    { type: 'assistant/message', time: 10, data: { message: { content: [{ type: 'text', text: 'no seq' }] } } },
  ])
  assert.deepEqual(items.map(item => [item.kind, item.text ?? item.role, item.seq, item.turn]), [
    ['user', 'before', 1, undefined],
    ['bot', 'also before', 2, undefined],
    ['bot', 'second bubble', 2, undefined],
    ['user', 'start', 4, 4],
    ['bot', 'working', 5, 4],
    ['event', 'request', 6, 4],
    ['user', 'queued', 7, 4],
    ['user', 'next', 9, 5],
    ['bot', 'no seq', undefined, 5],
  ])
  assert.equal(items[0].time, 1)
  assert.equal('turn' in items[0], false)
  assert.equal('turn' in items[1], false)
  assert.equal('seq' in items.at(-1), false)
  assert.equal(items[4].turn, 4)
  assert.equal(items[5].botId, 'a')
  assert.equal(items[5].name, 'Chief')
})

// parts.js: an earlier group page stacks the replies of one turn. The change line must
// come from the stacked row (the wrapper carries the last reply's `changes`), not from
// the first reply of the turn.
test('an earlier group page takes the change line of the last stacked reply', () => {
  const rt = earlierParts([])
  rt.roomOf = id => (id === 'g1' ? { id: 'g1', name: 'Launch' } : undefined)
  const early = { sessionId: 'w1', seq: 3, turn: 1, total: 1, added: 1, deleted: 0, files: [{ path: 'early.js', added: 1, deleted: 0 }] }
  const last = { sessionId: 'w1', seq: 9, turn: 1, total: 1, added: 2, deleted: 1, files: [{ path: 'final.js', added: 2, deleted: 1 }] }
  rt.groupRows = () => [
    { botId: 'b', name: 'Writer', text: 'Working…', time: 5, changes: early },
    { botId: 'b', name: 'Writer', text: 'Done.', time: 6, changes: last },
  ]
  const items = rt.displayItems('g1', [
    { seq: 1, type: 'tool/call', time: 1, data: { name: 'group_relay', callId: 'c1' } },
    { seq: 2, type: 'tool/result', time: 2, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"from":1,"to":9}' }] } } },
  ])
  const post = items.find(item => item.kind === 'post')
  assert.deepEqual(post.texts, ['Working…', 'Done.'])
  assert.deepEqual(post.changes, last)
})

// One turn opened on the older page and still running on the newer one.
// The page holds 60 events, so the newer page starts after that turn/start.
test('one turn keeps its identity across two earlier pages', async (t) => {
  const log = [{ seq: 1, type: 'turn/start', time: 1, data: { turn: 6 } }]
  for (let seq = 2; seq <= 70; seq += 1) {
    log.push({ seq, type: 'user/message', time: seq, data: { content: [{ type: 'text', text: `m${seq}` }], source: { kind: 'user' } } })
  }
  const session = { id: 'cur', seq: 71, header: {}, inheritedEventCount: 0, snapshotEvents: () => log }
  const units = new Map()
  const services = {}
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-turn-page-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b'],
    revision: 1,
    bots: { b: { id: 'b', name: 'Writer', sessionId: 'cur', createdAt: 1, segments: [{ sessionId: 'old', endedAt: 50 }] } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))
  const ctx = fakeContext({ services })
  services.sessionProjections = {
    register(definition) {
      ctx.effect(() => {
        units.set(definition.key, definition)
        return () => { units.delete(definition.key) }
      }, 'sessionProjections.register()')
    },
    stateOf(target, key) {
      const definition = units.get(key)
      if (definition === undefined) return undefined
      let state = definition.init(target.header, target.inheritedEventCount)
      for (const event of target.snapshotEvents()) state = definition.apply(state, event)
      return state
    },
  }
  ctx.sessionController = {
    resolveAgent: async (sessionId) => ({ agent: { id: sessionId, session: sessionId === 'cur' ? session : { id: sessionId, seq: 1, snapshotEvents: () => [] } } }),
    page: async ({ address, throughSeq, beforeSeq, maxMessages }) => {
      if (address.sessionId !== 'cur') return { records: [], hasMore: false }
      let list = log.filter(event => event.seq <= throughSeq && (!Number.isInteger(beforeSeq) || event.seq < beforeSeq))
      const hasMore = list.length > maxMessages
      if (hasMore) list = list.slice(-maxMessages)
      return { records: list.map(event => ({ event })), hasMore }
    },
  }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint: 'chat', payload }) }))).json()
  const newer = (await call({ botId: 'b' })).value
  const older = (await call({ botId: 'b', cursor: newer.cursor })).value
  assert.equal(newer.items.length, 60)
  assert.ok(newer.items[0].seq > 1)
  assert.equal(newer.items.every(item => item.kind === 'user' && item.turn === 6), true)
  assert.equal(older.items[0].kind, 'divider')
  assert.equal(older.items[0].time, 50)
  assert.equal('seq' in older.items[0], false)
  assert.equal('turn' in older.items[0], false)
  assert.equal(older.items.slice(1).every(item => item.kind === 'user' && item.turn === 6 && item.seq < newer.items[0].seq), true)
  assert.equal(older.items.some(item => item.seq === 2 && item.turn === 6), true)
})

test('an image offload failure moves the Bot on, without its latest messages the second time; other request failures do not', async (t) => {
  const { ctx, agents, agentOf, emit, fire, stop } = await start(team())
  t.after(stop)
  let made = 0
  ctx.sessionController.create = async () => ({ sessionId: `s${++made}` })
  // Per Session, the events DS Bot reads back; only the previous turn's end matters.
  const ends = new Map()
  const endedWith = (id, code) => ends.set(id, { 9: { type: 'turn/end', data: { reason: { kind: 'error', error: { code } } } } })
  const failTurn = async (id, code) => {
    const agent = agentOf(id)
    agent.session.seq = 10
    agent.session.eventAt = seq => ends.get(id)?.[seq]
    emit(id, 'turn/start', { turn: 1 })
    emit(id, 'user/message', { content: textBlock('look at this'), source: { kind: 'user' } })
    await fire('agent/request-error', { failure: { code }, signal: AbortSignal.timeout(60_000), agent })
    emit(id, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code } } })
  }
  const handoffIn = id => agents.get(id)?.calls.find(([, message]) => message.source?.handoff === true)?.[1]
  const waitFor = async (check) => {
    for (let count = 0; count < 200 && !check(); count += 1) await delay(5)
    assert.ok(check())
  }

  await failTurn('b', 'TRANSPORT')
  endedWith('b', 'INVALID_REQUEST')
  await failTurn('b', 'INVALID_REQUEST')
  for (const code of ['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH']) await failTurn('b', code)
  await delay(30)
  assert.equal(made, 0)

  await failTurn('b', 'IMAGE_OFFLOAD_REQUIRED')
  await waitFor(() => handoffIn('s1') !== undefined)
  const first = textOf(handoffIn('s1').content)
  assert.match(first, /because a request in the previous part kept failing \(IMAGE_OFFLOAD_REQUIRED\)/)
  assert.match(first, /first tell the user in one short sentence that the last message could not be sent as it was/)

  endedWith('s1', 'IMAGE_OFFLOAD_REQUIRED')
  await failTurn('s1', 'IMAGE_OFFLOAD_REQUIRED')
  await waitFor(() => handoffIn('s2') !== undefined)
  const second = textOf(handoffIn('s2').content)
  assert.match(second, /so they are left out this time\. First tell the user/)
  assert.match(second, /## Latest messages[^#]*\(none\)/)

  // A part that already left the messages out stays where it is.
  endedWith('s2', 'IMAGE_OFFLOAD_REQUIRED')
  await failTurn('s2', 'IMAGE_OFFLOAD_REQUIRED')
  await delay(30)
  assert.equal(made, 2)
})

test('a failed turn past the hard line keeps the real error instead of switching in the background', async (t) => {
  const { ctx, agentOf, emit, stop } = await start(team())
  t.after(stop)
  let made = 0
  ctx.sessionController.create = async () => ({ sessionId: `s${++made}` })
  const get = ctx.get
  ctx.get = name => name === 'tokenMeter' ? { measure: () => ({ totalTokens: 120_000 }) } : get(name)
  ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 100_000 } })
  const agent = agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'custom', model: 'model' } })
  emit('b', 'assistant/message', assistantText('Earlier work'))
  const error = { code: 'MISSING_CREDENTIAL', message: 'No API key' }
  agent.session.seq = 2
  agent.session.eventAt = () => ({ type: 'turn/end', data: { reason: { kind: 'error', error } } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await delay(50)
  assert.equal(made, 0)
  assert.equal(agent.session.eventAt(1).data.reason.error, error)
})

// #1716: an endpoint behind a gateway or compatible proxy turns an oversized request
// down without DSH's overflow code. The part moves on the way an overflow moves it.
for (const [id, failure] of [
  ['b', { code: 'INVALID_REQUEST', message: '413 Payload Too Large' }],
  ['b', { code: 'INVALID_REQUEST', status: 413, message: 'Request failed' }],
  ['b', { code: 'INVALID_REQUEST', message: '413 status code (no body)' }],
  ['gb', { code: 'INVALID_REQUEST', message: 'failed to buffer the request body: length limit exceeded' }],
]) {
  test(`a request turned down as too large moves the part on without a model call (${id}, ${failure.status ?? failure.message})`, async (t) => {
    const { ctx, agentOf, emit, fire, stop } = await start(team({ group: true }))
    t.after(stop)
    let made = 0
    ctx.sessionController.create = async () => ({ sessionId: `s${++made}` })
    let tokens = 10_000
    const get = ctx.get
    ctx.get = name => name === 'tokenMeter' ? { measure: () => ({ totalTokens: tokens }) } : get(name)
    ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 100_000 } })
    let streamed = 0
    ctx.llm.stream = async function* () {
      streamed += 1
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const agent = agentOf(id)
    agent.session.requestHeader = () => ({ config: { provider: 'custom', model: 'model' } })
    emit(id, 'assistant/message', assistantText('Earlier work'))
    const refuse = failure => fire('agent/request-error', { agent, failure, signal: AbortSignal.timeout(60_000) })

    // A generic refusal of a part below its hard line says nothing about its size.
    await refuse({ code: 'INVALID_REQUEST', status: 400, message: 'invalid tool schema' })
    await delay(30)
    assert.equal(made, 0)

    await refuse(failure)
    for (let at = 0; at < 200 && made === 0; at += 1) await delay(5)
    assert.equal(made, 1)
    assert.equal(streamed, 0)
  })
}

test('a generic refusal of a part past its hard line moves it on; one below does not', async (t) => {
  const { ctx, agentOf, emit, fire, stop } = await start(team())
  t.after(stop)
  let made = 0
  ctx.sessionController.create = async () => ({ sessionId: `s${++made}` })
  let tokens = 10_000
  const get = ctx.get
  ctx.get = name => name === 'tokenMeter' ? { measure: () => ({ totalTokens: tokens }) } : get(name)
  ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 100_000 } })
  const agent = agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'custom', model: 'model' } })
  emit('b', 'assistant/message', assistantText('Earlier work'))
  const failure = { code: 'INVALID_REQUEST', status: 400, message: 'Bad Request' }
  await fire('agent/request-error', { agent, failure, signal: AbortSignal.timeout(60_000) })
  await delay(30)
  assert.equal(made, 0)
  tokens = 120_000
  await fire('agent/request-error', { agent, failure, signal: AbortSignal.timeout(60_000) })
  for (let at = 0; at < 200 && made === 0; at += 1) await delay(5)
  assert.equal(made, 1)
})

for (const id of ['b', 'gb']) {
  test(`model-priced images after a handoff can make room by switching (${id})`, async (t) => {
    const seed = team({ group: true })
    const segment = { sessionId: 'old', note: 'Keep working on the request.', endedAt: 1 }
    if (id === 'gb') seed.rooms.r1.segments = { b: [segment] }
    else seed.bots.b.segments = [segment]
    const { ctx, agentOf, emit, fire, stop } = await start(seed)
    t.after(stop)
    const meterCtx = new Context()
    meterCtx.provide('sessionProjections', { register() {} })
    meterCtx.provide('llm', {
      imageRequestPricing: () => ({ priceImages: images => images.map(() => ({ visualTokens: 2_000, text: '' })) }),
    })
    await meterCtx.plugin(TokenMeter)
    t.after(() => meterCtx.fiber.dispose())
    const meter = meterCtx.tokenMeter
    const get = ctx.get
    ctx.get = name => name === 'tokenMeter' ? meter : get(name)
    ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 50_000 } })
    let made = 0
    ctx.sessionController.create = async () => ({ sessionId: `s${++made}` })
    const agent = agentOf(id)
    const session = Session.create(id)
    agent.session = session
    const events = []
    const record = (type, data, surface) => {
      events.push(session.append(type, data, surface ? { surfaceOp: 'append' } : undefined))
      emit(id, type, data)
    }
    ctx.sessionController.page = async ({ address, beforeSeq }) => ({
      records: address.sessionId === id ? events.filter(event => beforeSeq === undefined || event.seq < beforeSeq).map(event => ({ event })) : [],
      hasMore: false,
    })
    const header = { config: { provider: 'custom', model: 'image-model' } }
    const system = { role: 'system', content: textBlock('System instructions. '.padEnd(36_000, 's')) }
    record('request/header', { header })
    record('system/message', { turn: 1, step: 1, message: system }, true)
    record('user/message', { source: { kind: SOURCE_KIND, handoff: true }, content: textBlock('Earlier context. '.padEnd(12_000, 'x')) }, true)
    record('step/start', { turn: 1, step: 1 })
    record('assistant/message', { turn: 1, step: 1, ...assistantText('Ready to work with the images.'), stream: [] }, true)
    record('step/end', { turn: 1, step: 1 })
    record('user/message', {
      source: { kind: 'user' },
      content: [
        ...textBlock('Inspect these images.'),
        ...Array.from({ length: 30 }, () => ({ type: 'image', attachment: { attachmentId: `sha256:${'1'.repeat(64)}`, mediaType: 'image/png', bytes: 100, width: 1600, height: 1600 } })),
      ],
    }, true)
    const before = meter.measure(session)
    const history = before.nodes.filter(node => session.eventAt(node.seq).type !== 'system/message').reduce((total, node) => total + node.tokens, 0)
    const heuristic = session.deriveMessages().filter(message => message.role !== 'system').reduce((total, message) => total + meter.estimateMessage(message), 0)
    assert.ok(before.totalTokens > 50_000)
    assert.ok(history > 60_000)
    assert.ok(before.totalTokens - heuristic > 50_000, 'structural image references cannot stand in for the removed visual tokens')

    await fire('agent/request-error', { agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000) })
    for (let count = 0; count < 200 && !agentOf('s1').calls.some(([, message]) => message.source?.handoff); count += 1) await delay(5)
    const handoff = agentOf('s1').calls.find(([, message]) => message.source?.handoff)?.[1]
    assert.ok(handoff, 'the shorter part can replace the model-priced images')
    assert.equal(made, 1)
    const replacement = Session.create('replacement')
    replacement.append('request/header', { header })
    replacement.append('system/message', { turn: 1, step: 1, message: system }, { surfaceOp: 'append' })
    replacement.append('user/message', handoff, { surfaceOp: 'append' })
    const after = meter.measure(replacement).totalTokens
    assert.ok(after < 50_000, 'the same system prompt and the real handoff fit')
    assert.ok(after < before.totalTokens)
    t.diagnostic(`pressure ${before.totalTokens} -> ${after}; replaced history ${history} (heuristic ${heuristic}); new parts ${made}`)
  })

  test(`a fresh part with oversized tools stops until the replacement context can fit (${id})`, async (t) => {
    const { ctx, agentOf, emit, fire, stop } = await start(team({ group: true }))
    t.after(stop)
    let made = 0
    let tokens = 272_000
    ctx.sessionController.create = async () => ({ sessionId: `s${++made}` })
    const get = ctx.get
    ctx.get = name => name === 'tokenMeter' ? {
      measure: () => ({ totalTokens: tokens }),
      estimateMessage: message => estimateTokens(textOf(message.content)),
    } : get(name)
    ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 192_000 } })
    const preStep = async (agent) => {
      agent.session.requestHeader = () => ({ config: { provider: 'custom', model: 'model' } })
      return ctx.listeners.get('agent/pre-step').at(-1)({ agent, messages: [], step: 1, signal: AbortSignal.timeout(60_000) }, async () => 'next')
    }
    const overflow = agent => fire('agent/request-error', { agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Tools exceed the context window' }, signal: AbortSignal.timeout(60_000) })
    const waitForHandoff = async (sessionId) => {
      for (let count = 0; count < 200 && !agentOf(sessionId).calls.some(([, message]) => message.source?.handoff); count += 1) await delay(5)
      const handoff = agentOf(sessionId).calls.find(([, message]) => message.source?.handoff)?.[1]
      assert.ok(handoff)
      emit(sessionId, 'user/message', handoff)
    }

    // A grown conversation still gets its normal overflow recovery.
    emit(id, 'assistant/message', assistantText('Earlier work'))
    await overflow(agentOf(id))
    await waitForHandoff('s1')
    assert.equal(await preStep(agentOf('s1')), 'next')
    // A larger tool set can cross the growth line without adding any conversation.
    tokens += 192_000
    assert.equal(await preStep(agentOf('s1')), 'next')
    await overflow(agentOf('s1'))
    await delay(30)
    assert.equal(made, 1, 'replacing an unchanged handoff cannot make room')

    // An idle handoff acknowledgement is synthetic, not evidence the model works.
    emit('s1', 'assistant/message', assistantText(HANDOFF_ACK))
    ctx.emit('agent/status', { agent: agentOf('s1'), status: 'idle' })
    await delay(30)
    assert.equal(made, 1)

    // A model reply alone does not fix a tool set that still exceeds the window.
    emit('s1', 'assistant/message', assistantText('A short reply'))
    await overflow(agentOf('s1'))
    await delay(30)
    assert.equal(made, 1)

    // Once the tool set fits, shortening the conversation can help again.
    tokens = 1_000
    await overflow(agentOf('s1'))
    await waitForHandoff('s2')
    assert.equal(made, 2)
  })

  for (const pending of [false, true]) {
    test(`a long ${pending ? 'pending' : 'admitted'} request after a handoff can recover without a model reply (${id})`, async (t) => {
      const seed = team({ group: true })
      const segment = { sessionId: 'old', note: 'Keep working on the request.', endedAt: 1 }
      if (id === 'gb') seed.rooms.r1.segments = { b: [segment] }
      else seed.bots.b.segments = [segment]
      const { ctx, agentOf, emit, fire, stop } = await start(seed)
      t.after(stop)
      let made = 0
      ctx.sessionController.create = async () => ({ sessionId: `s${++made}` })
      const get = ctx.get
      ctx.get = name => name === 'tokenMeter' ? {
        measure: session => ({ totalTokens: 9_000 + estimateTokens(session.deriveMessages().map(message => textOf(message.content)).join('\n')) }),
        estimateMessage: message => estimateTokens(textOf(message.content)),
      } : get(name)
      ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 50_000 } })
      ctx.llm.stream = async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Context window exceeded' } } }
      }
      const agent = agentOf(id)
      agent.session.requestHeader = () => ({ config: { provider: 'custom', model: 'model' } })
      agent.session.toolHistory = () => []
      const events = []
      const record = (type, data) => {
        events.push({ type, data, seq: events.length, time: 1 })
        agent.session.seq = events.length
        emit(id, type, data)
      }
      ctx.sessionController.page = async ({ address, beforeSeq }) => ({
        records: address.sessionId === id ? events.filter(event => beforeSeq === undefined || event.seq < beforeSeq).map(event => ({ event })) : [],
        hasMore: false,
      })
      record('user/message', { source: { kind: SOURCE_KIND, handoff: true }, content: textBlock('Earlier context. '.padEnd(120_000, 'x')) })
      record('assistant/message', assistantText(HANDOFF_ACK))
      const input = { role: 'user', source: { kind: 'user' }, content: textBlock('New request. '.padEnd(20_000, 'y')) }
      assert.ok(estimateTokens(textOf(input.content)) < 50_000, 'the new request fits on its own')
      assert.ok(ctx.get('tokenMeter').measure(agent.session).totalTokens + estimateTokens(textOf(input.content)) > 50_000, 'it overflows together with the handoff')

      if (pending) {
        const decision = await ctx.listeners.get('agent/pre-step').at(-1)({ agent, messages: [input], step: 1, signal: AbortSignal.timeout(60_000) }, async () => 'next')
        assert.deepEqual(decision, { kind: 'enter', messages: [] })
      } else {
        record('user/message', input)
        await fire('agent/request-error', { agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000) })
      }
      const ready = () => agentOf('s1').calls.some(([, message]) => message.source?.handoff)
        && (!pending || agentOf('s1').calls.some(([, message]) => textOf(message.content) === textOf(input.content)))
      for (let count = 0; count < 200 && !ready(); count += 1) await delay(5)
      assert.ok(ready(), 'the shorter part gets the handoff and any still-pending input')
      assert.equal(made, 1)
      const handoff = agentOf('s1').calls.find(([, message]) => message.source?.handoff)[1]
      assert.ok(textOf(handoff.content).length < 10_000, 'the handoff replaces the 140k-character context')
    })
  }
}

// #206: a message between Bots used to go whole into state.json, which is written whole
// on every save; an empty one started a turn on nothing.
test('message_bot turns down an empty message', async (t) => {
  const { agentOf, tool, exchanges, stop } = await start(team())
  t.after(stop)
  for (const message of ['', '   \n\t ']) assert.equal(await tool('message_bot', { to: 'Writer', message }, 'a'), 'Write a message to send.')
  assert.deepEqual(agentOf('b').calls, [])
  assert.deepEqual(await exchanges(), [])
})

// A message between Bots is in the book of the pair, whole; state.json does not hold it.
test('a long message between Bots is kept whole in the book of the pair, not in state.json', async (t) => {
  const { botCalls, tool, call, exchanges, home, stop } = await start(team())
  t.after(stop)
  const long = `${'长'.repeat(15_000)}结尾`
  await tool('message_bot', { to: 'Writer', message: long }, 'a')
  const [, delivered] = botCalls('b').find(([kind]) => kind === 'steer' || kind === 'followup')
  assert.ok(delivered.content[0].text.endsWith(long), 'the recipient gets it whole')
  const [entry] = await exchanges()
  assert.equal(entry.text.length, 2000)
  assert.equal(entry.length, long.length)
  const file = join(home, 'state.json')
  await delay(100)
  const saved = readFileSync(file, 'utf8')
  assert.ok(!saved.includes('长'.repeat(100)), 'state.json does not hold the message')
  assert.ok(!saved.includes('\n'), 'state.json is written without indentation')
  const book = readFileSync(join(home, 'ledger', 'pair-a-b.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row))
  assert.deepEqual(book.map(record => [record.event ?? record.role, record.id]), [['request', entry.id], ['delivered', entry.id]])
  assert.equal(book[0].text, long)

  // The dialog reads it whole from the book, with no Session to read back.
  assert.deepEqual((await call('exchange-text', { id: entry.id, a: 'a', b: 'b' })).value, { text: long, whole: true })
})

test('a team saved with long messages whole keeps only their start after it loads', async (t) => {
  const seed = team()
  seed.exchanges = [{ id: 'x1', from: 'a', to: 'b', text: 'y'.repeat(5000), role: 'request', time: 1 }]
  const { exchanges, stop } = await start(seed)
  t.after(stop)
  const [entry] = await exchanges()
  assert.equal(entry.text, 'y'.repeat(2000))
  assert.equal(entry.length, 5000)
})

// #206: a message past 20,000 characters went whole into every Session it reached and
// into the model's context at once. It now goes as a DSH file the recipient reads.
test('a message past 20,000 characters goes as a file, which the exchange dialog reads back', async (t) => {
  const { ctx, botCalls, tool, call, exchanges, stop } = await start(team())
  t.after(stop)
  const store = fakeAttachments()
  ctx.get = name => (name === 'attachments' ? store : undefined)
  const lines = Array.from({ length: 400 }, (_, at) => `第 ${at + 1} 行：${'长消息的一行。'.repeat(8)}`)
  const long = `${lines.join('\n')}\n结尾`
  assert.ok(long.length > 20_000)
  const answer = await tool('message_bot', { to: 'Writer', message: long }, 'a')
  assert.match(answer, /^Delivered to Writer/)
  const [, delivered] = botCalls('b').find(([kind]) => kind === 'steer' || kind === 'followup')
  const [text, file] = delivered.content
  assert.ok(text.text.startsWith(`[Message from Chief]\n[A long message: ${long.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.]\n第 1 行`))
  assert.ok(!text.text.includes('shell command'), 'no line is past what the read tool shows')
  assert.ok(text.text.length < 1200)
  assert.equal(file.type, 'file')
  assert.equal(file.attachment.name, 'Message from Chief.txt')
  assert.equal(new TextDecoder().decode(store.files.get(file.attachment.attachmentId)), long)

  const [entry] = await exchanges()
  assert.equal(entry.length, long.length)
  assert.deepEqual(entry.files, [file.attachment])
  assert.deepEqual((await call('exchange-text', { id: entry.id, a: entry.from, b: entry.to })).value, { text: long, whole: true })
  assert.deepEqual((await call('file-text', { file: file.attachment })).value, { text: long, whole: true })
})

test('a long message with a line past what the read tool shows says how to read it', async (t) => {
  const { ctx, botCalls, tool, stop } = await start(team())
  t.after(stop)
  ctx.get = name => (name === 'attachments' ? fakeAttachments() : undefined)
  await tool('message_bot', { to: 'Writer', message: 'x'.repeat(25_000) }, 'a')
  const [, delivered] = botCalls('b').find(([kind]) => kind === 'steer' || kind === 'followup')
  assert.match(delivered.content[0].text, /Some lines are longer than the 2000 characters the read tool shows of a line; read those with a shell command\./)
})

test('without file storage a message past 20,000 characters is not sent', async (t) => {
  const { botCalls, tool, exchanges, stop } = await start(team())
  t.after(stop)
  const answer = await tool('message_bot', { to: 'Writer', message: 'x'.repeat(20_001) }, 'a')
  assert.equal(answer, 'Not sent: the message has 20001 characters, more than 20000, and this DeepSeek Harness cannot send it as a file. Write it to a file in your working folder and send its path instead.')
  assert.deepEqual(botCalls('b'), [])
  assert.deepEqual(await exchanges(), [])
  // 20,000 characters still go as they are.
  await tool('message_bot', { to: 'Writer', message: 'x'.repeat(20_000) }, 'a')
  assert.equal(botCalls('b').length, 1)
})

// A request merged with another the recipient had not read goes out under the same id. If
// the merged text never reaches the recipient, the dialog keeps the text that did.
test('a merged request that does not go out leaves the delivered text in the dialog', async (t) => {
  const { ctx, exchanges, stop } = await start(team())
  t.after(stop)
  await rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'Draft the plan', exchangeId: 'x-merge' })
  const flush = ctx.sessions.flush
  ctx.sessions.flush = async () => { throw new Error('Session is gone') }
  await assert.rejects(rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'Draft the plan\n\nAnd the budget', exchangeId: 'x-merge', merged: true }), /Session is gone/)
  ctx.sessions.flush = flush
  assert.deepEqual((await exchanges()).map(entry => [entry.id, entry.text]), [['x-merge', 'Draft the plan']])
})

// The book is written before the message goes out: one it cannot keep is not sent.
test('a message between Bots that the book cannot keep is not sent', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const { botCalls, tool, exchanges, home, stop } = await start(team())
  t.after(stop)
  mkdirSync(join(home, 'ledger'), { recursive: true })
  chmodSync(join(home, 'ledger'), 0o500)
  try {
    await assert.rejects(tool('message_bot', { to: 'Writer', message: 'Hello' }, 'a'))
    assert.equal(botCalls('b').filter(([kind]) => kind === 'steer' || kind === 'followup').length, 0)
  } finally {
    chmodSync(join(home, 'ledger'), 0o700)
  }
  assert.deepEqual(await exchanges(), [])
})


// ── Work model W1 (docs/plans/2026-11-24-work-model.md): one record per work, the Bot that handed work on waits, and
// it goes on ONCE, in its own conversation, with everything that came back. Every case runs real turns
// (turn/start → user/message → assistant/message → turn/end); nothing closes a work by hand.

test('W1-1 a user turn that hands work to two Bots is resumed once, with both results, after the second is back', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'get the plan written and tested')
  await tool('message_bot', { to: 'Writer', message: 'write the plan' }, 'a')
  await tool('message_bot', { to: 'Tester', message: 'prepare the tests' }, 'a')
  turns.end('a', 'Writer and Tester are on it.')
  turns.take('b')
  turns.end('b', 'the plan is written')
  await delay(30)
  assert.deepEqual(callsOf(agents, 'a'), [], 'Tester is still out: Chief is not woken for one of two')
  turns.take('c')
  turns.end('c', 'the tests are ready')
  await settled(() => callsOf(agents, 'a').length === 1)
  await delay(30)
  assert.equal(callsOf(agents, 'a').length, 1, 'one resume, not one wake per result')
  const [kind, resume] = callsOf(agents, 'a')[0]
  assert.equal(kind, 'followup', 'never steered')
  assert.equal(resume.source.kind, SOURCE_KIND, 'a Bot message, never the user\'s input')
  assert.equal(resume.source.role, 'results')
  assert.deepEqual([...resume.source.resultFrom].sort(), ['b', 'c'])
  assert.equal(textOf(resume.content), '[Work handed back to you · from Writer, Tester · everything you handed on is back]\nWriter:\nthe plan is written\n\nTester:\nthe tests are ready')
  // Chief goes on with it; the work is done, and nothing is left open.
  turns.take('a')
  turns.end('a', 'Plan and tests are ready.')
  assert.deepEqual(await worksIn(team), {})
  assert.deepEqual((await exchanges()).map(entry => [entry.role, entry.text]), [['request', 'write the plan'], ['reply', 'the plan is written']], 'the pair keeps the answer')

  async function exchanges() { return (await team.call('exchange', { a: 'a', b: 'b' })).value ?? [] }
})

test('W1-2 what comes back while the Bot is in another turn never steers into it', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'write the plan' }, 'a')
  turns.end('a', 'asked Writer')
  // The user talks to Chief about something else; Writer answers meanwhile.
  turns.userTurn('a', 'what time is it?')
  turns.take('b')
  turns.end('b', 'the plan is written')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.deepEqual(callsOf(agents, 'a').map(([kind, message]) => [kind, message.source.role]), [['followup', 'results']])
  turns.end('a', 'noon')
})

// Changed by the maintainer 2026-11-25: a Bot that goes on with other things after handing work on got what came
// back minutes late (only once its turn ended); it is now steered into that running turn.
test('W1-3 what comes back while the turn doing that work still runs is steered into that turn at once, read there, and not resumed again', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'write the plan' }, 'a')
  // Writer answers while Chief's turn is still running.
  turns.take('b')
  turns.end('b', 'the plan is written')
  await settled(() => callsOf(agents, 'a').length === 1)
  const [kind, message] = callsOf(agents, 'a')[0]
  assert.equal(kind, 'steer', 'into the running turn, not after it')
  assert.equal(message.source.role, 'results')
  assert.match(message.content[0].text, /Writer:\nthe plan is written/)
  // The running turn reads it at its next step, and ends.
  emit('a', 'user/message', { content: message.content, source: message.source })
  turns.end('a', 'Writer wrote the plan')
  await delay(30)
  assert.equal(callsOf(agents, 'a').length, 1, 'read once: nothing resumes it after the turn')
})

test('W1-3b a steer that finds the turn already over goes the ordinary way: one resume once the conversation is idle', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'write the plan' }, 'a')
  // The turn ends between "it is running" and the steer: the steer is refused.
  const agent = agents.get('a')
  const steer = agent.steer
  agent.steer = () => { agent.steer = steer; turns.end('a', 'asked Writer'); throw new Error('no turn is running') }
  turns.take('b')
  turns.end('b', 'the plan is written')
  await settled(() => callsOf(agents, 'a').some(([kind]) => kind === 'followup'))
  const resumed = callsOf(agents, 'a').filter(([kind]) => kind === 'followup')
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0][1].source.role, 'results')
})

test('W1-4 no clock runs on a work: an unanswered request stays open, and nobody is told it timed out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'write the plan' }, 'a')
  turns.end('a', 'asked Writer')
  const before = callsOf(agents, 'b').length
  t.mock.timers.tick(3 * 60 * 60 * 1000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(callsOf(agents, 'a'), [], 'no timeout notice')
  assert.equal(callsOf(agents, 'b').length, before, 'no reminder')
  const open = Object.values(await worksIn(team)).find(work => work.to === 'b')
  assert.ok(open !== undefined, 'still waiting for Writer')
})

// ── Work model W2: one standing work thread per (recipient, asker, the asker's conversation). Real turns only.

test('W2-1 three rounds of one pair run in one work thread, and the user\'s chat with the recipient stays untouched', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { rt, agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  const sessions = []
  for (const round of [1, 2, 3]) {
    turns.userTurn('a', `round ${round}`)
    await tool('message_bot', { to: 'Writer', message: `part ${round}` }, 'a')
    turns.end('a', `asked Writer for part ${round}`)
    const request = turns.take('b')
    sessions.push(turns.sessionOf('b'))
    assert.equal(textOf(request.content), `[Message from Chief]\npart ${round}`)
    turns.end('b', `part ${round} done`)
    await settled(() => callsOf(agents, 'a').length === round)
    turns.take('a')
    turns.end('a', `part ${round} is in`)
  }
  assert.equal(new Set(sessions).size, 1, 'one Session for the pair')
  assert.notEqual(sessions[0], 'b', 'not the user\'s chat with Writer')
  assert.equal(agents.get('b'), undefined, 'nothing was written into the chat the user reads')
  const threads = rt.botOf('b').tasks.filter(task => task.origin === 'bot-work')
  assert.deepEqual(threads.map(task => [task.status, task.title]), [['standing', '@Chief · 工作']])
  assert.deepEqual(await worksIn(team), {})
})

test('W2-2 what Writer hands on from its work thread comes back to that thread, once', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents } = team
  const { take, end, sessionOf } = await handedOn(team)
  const writerThread = sessionOf('b')
  end('b', 'handed it to Tester')
  take('c')
  end('c', 'two things to fix')
  await settled(() => callsOf(agents, 'b').length === 2)
  const resume = callsOf(agents, 'b')[1]
  assert.equal(resume.sessionId, writerThread)
  assert.equal(resume[1].source.role, 'results')
})

test('W2-3 a Bot keeps at most ten work threads: the one idle longest makes room', async (t) => {
  const seed = team()
  for (let at = 0; at < 11; at += 1) seed.bots[`x${at}`] = { id: `x${at}`, name: `Asker ${at}`, role: 'Ask', sessionId: `x${at}`, createdAt: 10 + at }
  const { rt, agents, emit, tool, stop } = await start(seed)
  t.after(stop)
  for (let at = 0; at < 10; at += 1) await tool('message_bot', { to: 'Writer', message: `from ${at}` }, `x${at}`)
  const threads = () => rt.botOf('b').tasks.filter(task => task.origin === 'bot-work' && task.status !== 'completed')
  assert.equal(threads().length, 10)
  // Writer answers each in its thread; all ten go idle, the first one idle longest.
  for (const [at, task] of threads().entries()) {
    const [, request] = agents.get(task.sessionId).calls.at(-1)
    emit(task.sessionId, 'turn/start', { turn: 1 })
    emit(task.sessionId, 'user/message', { content: request.content, source: request.source })
    emit(task.sessionId, 'assistant/message', assistantText(`answer ${at}`))
    emit(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await settled(() => task.status === 'standing')
    task.updatedAt = 1000 + at
  }
  await tool('message_bot', { to: 'Writer', message: 'from 10' }, 'x10')
  assert.equal(threads().length, 10)
  assert.equal(threads().some(task => task.workFor.botId === 'x0'), false, 'Asker 0\'s thread made room')
  assert.ok(threads().some(task => task.workFor.botId === 'x10'))
})

test('W2-4 the user stopping a work thread ends it; the next request of the pair opens a new one', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { rt, agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'go')
  await tool('message_bot', { to: 'Writer', message: 'part 1' }, 'a')
  turns.end('a', 'asked')
  turns.take('b')
  turns.end('b', 'done')
  const first = rt.botOf('b').tasks.find(task => task.origin === 'bot-work')
  await settled(() => first.status === 'standing')
  await rt.stopTask('b', first.id)
  assert.equal(first.status, 'stopped')
  await tool('message_bot', { to: 'Writer', message: 'part 2' }, 'a')
  const open = rt.botOf('b').tasks.filter(task => task.origin === 'bot-work' && task.status !== 'stopped')
  assert.equal(open.length, 1)
  assert.notEqual(open[0].sessionId, first.sessionId)
})

test('W2-5 the user stopping a work thread in the middle of a work tells the asker, and nothing goes into the user\'s chat', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { rt, agents, emit, tool } = team
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'go')
  await tool('message_bot', { to: 'Writer', message: 'part 1' }, 'a')
  turns.end('a', 'asked')
  turns.take('b')
  const thread = rt.botOf('b').tasks.find(task => task.origin === 'bot-work')
  await rt.stopTask('b', thread.id)
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.match(textOf(callsOf(agents, 'a')[0][1].content), /Writer was stopped before it could answer your message\./)
  assert.equal(agents.get('b'), undefined, 'no task report in the user\'s chat with Writer')
})
