import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createRuntime } from '../index.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { install as installLedger, bookFile, parseBook } from '../src/host/ledger.js'
import weixin from '../src/host/im/platforms/weixin.js'
import { fakeContext } from './fake-ctx.js'

const textOf = content => (Array.isArray(content) ? content.map(block => block?.text ?? '').join('\n') : String(content ?? ''))
const textBlock = text => [{ type: 'text', text }]
const assistantText = text => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } })

const settle = async (check, ms = 4000, label = 'condition not reached') => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await realDelay(10)
  assert.ok(check(), label)
}

function makeTeam(over = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Dev', sessionId: 'dm-b', createdAt: 2 },
      c: { id: 'c', name: 'Reviewer', role: 'QA', sessionId: 'dm-c', createdAt: 3 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    prefs: {},
    revision: 0,
    ...over,
  }
}

async function startHost(t, { home: existingHome, team, logs = new Map(), flushImpl, archiveCalls = [] } = {}) {
  const ownsHome = existingHome === undefined
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-durability-'))
  const workDir = join(home, 'workspace')
  mkdirSync(workDir, { recursive: true })
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const ctx = fakeContext()
  const agents = new Map()
  let seq = 0
  let nextCreated = 0

  const makeAgent = (id) => {
    const calls = []
    const events = []
    const session = {
      id,
      get seq() { return events.length },
      header: { cwd: workDir },
      requestHeader: () => ({ cwd: workDir, config: { provider: 'mock', model: 'mock-1' } }),
      snapshotEvents: () => [...events],
    }
    const inbox = {
      nextStep: [],
      nextTurn: [],
      prepend(queue, msg) {
        if (msg?.id !== undefined && [...this.nextStep, ...this.nextTurn].some(item => item?.id === msg.id)) {
          throw new Error(`message "${msg.id}" is already pending`)
        }
        ;(queue === 'next-step' ? this.nextStep : this.nextTurn).unshift(msg)
      },
      append(queue, msg) {
        if (msg?.id !== undefined && [...this.nextStep, ...this.nextTurn].some(item => item?.id === msg.id)) {
          throw new Error(`message "${msg.id}" is already pending`)
        }
        ;(queue === 'next-step' ? this.nextStep : this.nextTurn).push(msg)
      },
      remove(msgId) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const at = list.findIndex(item => item?.id === msgId)
          if (at !== -1) {
            const [removed] = list.splice(at, 1)
            for (const listener of ctx.listeners.get('agent/inbox/discarded') ?? []) listener({ agent, message: removed })
            return true
          }
        }
        return false
      },
    }
    const agent = {
      id,
      session,
      status: 'idle',
      calls,
      inbox,
      send(message, target = 'next-turn', wake = true) {
        calls.push([wake ? (target === 'next-step' ? 'steer' : 'followup') : 'inject', message])
        inbox.append(target, message)
      },
      followup(message) {
        calls.push(['followup', message])
        inbox.append('next-turn', message)
      },
      steer(message) {
        calls.push(['steer', message])
        inbox.append('next-step', message)
      },
      inject(message) {
        calls.push(['inject', message])
        inbox.append('next-step', message)
      },
      cancel(cause) { calls.push(['cancel', cause]) },
      async whenIdle() {},
      async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
    }
    agents.set(id, agent)
    return agent
  }

  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }

  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: workDir }),
      resolveByPath: async () => ({ id: 'w1', path: workDir }),
      create: async path => ({ id: 'w1', path }),
      archiveSession: async (sid, opts) => { archiveCalls.push({ sid, opts }) },
    },
    sessionController: {
      create: async () => {
        const sid = `created-${++nextCreated}`
        makeAgent(sid)
        return { sessionId: sid }
      },
      fork: async () => {
        const sid = `fork-${++nextCreated}`
        makeAgent(sid)
        return { sessionId: sid }
      },
      resolveAgent: async sessionId => ({ agent: agents.get(sessionId) ?? makeAgent(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      inspect: async sessionId => ({ events: logs.get(sessionId) ?? agents.get(sessionId)?.session?.snapshotEvents?.() ?? [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: {
      flush: async session => (flushImpl ? flushImpl(session) : undefined),
      get: id => (agents.get(id) ?? makeAgent(id)).session,
    },
  })
  ctx.get = key => (key === 'agents' ? agents : undefined)

  const rt = createRuntime(ctx, { home })
  const stop = async () => {
    await ctx.dispose()
    if (ownsHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  t.after(stop)

  const emit = (id, type, data) => {
    const agent = agents.get(id) ?? makeAgent(id)
    const event = { type, seq: ++seq, time: Date.now(), data }
    agent.session.snapshotEvents = ((prev, ev) => () => [...prev(), ev])(agent.session.snapshotEvents, event)
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(agent.session, event)
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  await rt.load()
  return { home, workDir, ctx, rt, agents, makeAgent, emit, tool, call, routes, stop }
}

// Real DSH ReactLoopAgent rig for testing agent/pre-step deterministic ordering.
async function createRealAgentRig(t, { streamHandler, team = makeTeam(), hasDshClock = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-durability-real-'))
  const workDir = join(home, 'workspace')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const root = new Context()
  await mountAgentLoopTestDependencies(root)

  class TestAdapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100_000 } }
    }
    async *stream(options) {
      yield* streamHandler(options)
    }
  }

  root.llm.registerAdapter(['test'], new TestAdapter())
  await mountAgentLoopTestHarness(root)

  const agents = new Map()
  let nextCreated = 0
  const registerSession = async (sid) => {
    const agent = await root.agentLoop.create(SessionId(sid), {
      provider: 'test',
      model: 'mock',
      cwd: workDir,
    })
    agents.set(sid, agent)
    return agent
  }
  for (const bot of Object.values(team.bots)) await registerSession(bot.sessionId ?? bot.id)

  const ctx = fakeContext({
    services: {
      agents: root.agents,
      llm: root.llm,
      sessions: root.sessions,
      tools: root.tools,
      workspaceRegistry: {
        get: () => ({ id: 'w1', path: workDir }),
        list: () => [{ id: 'w1', path: workDir }],
        resolveByPath: async () => ({ id: 'w1', path: workDir }),
        create: async path => ({ id: 'w1', path }),
        archiveSession: async () => {},
      },
      sessionController: {
        create: async () => {
          const sid = `created-${++nextCreated}`
          await registerSession(sid)
          return { sessionId: sid }
        },
        fork: async () => {
          const sid = `fork-${++nextCreated}`
          await registerSession(sid)
          return { sessionId: sid }
        },
        resolveAgent: async sid => ({ agent: agents.get(sid) ?? root.agents.get(sid) ?? await registerSession(sid) }),
        selectModel: async () => {},
        page: async () => ({ records: [], hasMore: false }),
        inspect: async sid => ({ events: (agents.get(sid) ?? root.agents.get(sid))?.session?.snapshotEvents?.() ?? [] }),
      },
      sessionTitle: { rename: async () => {} },
      ...(hasDshClock ? { sessionProjections: { stateOf: (_session, key) => (key === 'timeContext' ? {} : undefined) } } : {}),
    },
  })
  Object.assign(ctx, {
    agents: root.agents,
    llm: root.llm,
    sessions: root.sessions,
    tools: root.tools,
    workspaceRegistry: ctx.get('workspaceRegistry'),
    sessionController: ctx.get('sessionController'),
    sessionTitle: ctx.get('sessionTitle'),
  })

  root.on('session/event', (session, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, event)
    }
  })
  for (const evName of ['agent/inbox/inserted', 'agent/inbox/claimed', 'agent/inbox/discarded']) {
    root.on(evName, (payload) => {
      for (const listener of ctx.listeners.get(evName) ?? []) listener(payload)
    })
  }
  root.on('agent/pre-step', async (payload, next) => {
    const chain = ctx.listeners.get('agent/pre-step') ?? []
    const run = index => (index < chain.length ? chain[index](payload, () => run(index + 1)) : next())
    return run(0)
  })

  const rt = createRuntime(ctx, { home })
  for (const def of rt.teamTools) root.tools.register(def)

  t.after(async () => {
    await ctx.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rt.load()

  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: agents.get(sessionId) })
  return { home, root, ctx, rt, agents, registerSession, tool }
}

test('F4 (turns.js): deferred later/joined preserve attachments and defer takenWork until owning turn consumes reply', async (t) => {
  const { rt, agents, emit } = await startHost(t, {
    team: makeTeam({
      works: {
        w_parent: { from: 'a', to: 'b', open: ['w_child'], results: [], at: 1 },
        w_child: { from: 'b', to: 'c', parent: 'w_parent', open: [], results: [], at: 2 },
        w_joined: { from: 'a', to: 'b', open: [], results: [], at: 3 },
      },
    }),
  })
  const img = { attachmentId: 'att-img-1', mediaType: 'image/png', name: 'chart.png' }
  const file = { attachmentId: 'att-file-1', mediaType: 'text/plain', name: 'report.txt' }

  // Writer is running an unrelated user turn.
  emit('dm-b', 'turn/start', { turn: 1 })
  emit('dm-b', 'user/message', { content: textBlock('help me with something else'), source: { kind: 'user' } })

  // A child reply for w_parent arrives mid-turn with both image and file attachments -> pushed to entry.later.
  emit('dm-b', 'user/message', {
    content: [
      { type: 'text', text: '[Work completed by Reviewer · closed]\nReview details' },
      { type: 'image', attachment: img },
      { type: 'file', attachment: file },
    ],
    source: { kind: SOURCE_KIND, role: 'reply', exchangeId: 'ex-reply-1', senderSessionId: 'c', senderName: 'Reviewer', work: 'w_parent', replyTo: 'w_child' },
  })
  // takenWork MUST NOT have cleared w_parent.open while deferred inside an unrelated busy turn!
  assert.deepEqual(rt.state.works.w_parent.open, ['w_child'], 'takenWork must stay deferred while reply sits in entry.later')

  // A peer request w_joined also steers into the same unrelated turn with an attachment -> pushed to entry.joined.
  emit('dm-b', 'user/message', {
    content: [
      { type: 'text', text: '[Work from Chief]\nInspect attachment' },
      { type: 'file', attachment: file },
    ],
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'w_joined', senderSessionId: 'a', senderName: 'Chief' },
  })

  // Unrelated user turn ends -> both later and joined redeliver with attachments preserved!
  emit('dm-b', 'assistant/message', assistantText('Done with user request.'))
  emit('dm-b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => (agents.get('dm-b')?.calls.length ?? 0) >= 2, 2000, 'deferred later and joined deliveries must land')

  const calls = agents.get('dm-b').calls.map(([, msg]) => msg)
  const deferredReply = calls.find(m => m.source?.exchangeId === 'ex-reply-1' && m.source?.deferred === true)
  const deferredReq = calls.find(m => m.source?.exchangeId === 'w_joined' && m.source?.deferred === true)
  assert.ok(deferredReply, 'deferred reply must be delivered')
  assert.deepEqual(deferredReply.content.filter(b => b.type === 'image').map(b => b.attachment), [img], 'deferred later must preserve images')
  assert.deepEqual(deferredReply.content.filter(b => b.type === 'file').map(b => b.attachment), [file], 'deferred later must preserve files')
  assert.ok(deferredReq, 'deferred joined request must be delivered')
  assert.deepEqual(deferredReq.content.filter(b => b.type === 'file').map(b => b.attachment), [file], 'deferred joined must preserve files')

  // Only when the deferred reply opens its own turn does takenWork clear w_parent.open.
  emit('dm-b', 'turn/start', { turn: 2 })
  emit('dm-b', 'user/message', { content: deferredReply.content, source: deferredReply.source })
  assert.deepEqual(rt.state.works.w_parent.open, [], 'takenWork must clear open once owning turn consumes deferred reply')
})

test('G-08 & G-09: unseen completed/failed group turns reconcile once, double-interrupt resets tasks, aborted turn keeps non-stopped joined room call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-g08-g09-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  const team = makeTeam({
    rooms: {
      r1: {
        id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true,
        sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {},
        tasks: { gt1: { id: 'gt1', botId: 'c', goal: 'Check metrics', status: 'active', startedAt: 1, updatedAt: 5, progress: '' } },
        goal: {
          id: 'g1', title: 'Ship', status: 'active', current: 0, revision: 0,
          stages: [{ id: 's1', title: 'Stage 1', status: 'active', tasks: [{ id: 'gtask1', botId: 'c', title: 'Verify', status: 'working' }] }],
        },
      },
    },
  })
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: {
      // gb finished with a reply while DS Bot was offline -> reconcileEndedGroupTurn -> lateRoomReply.
      gb: { botId: 'b', roomId: 'r1', turn: 1, since: 10, trigger: { role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'room-ex-1' } },
      // ga failed with an error while DS Bot was offline -> reconcileEndedGroupTurn -> lateRoomFailure.
      ga: { botId: 'a', roomId: 'r1', turn: 1, since: 10, trigger: { role: 'room', roomId: 'r1', exchangeId: 'room-ex-2' } },
      // gc was already resumed once and interrupted again -> goalTaskReset + blockTasks!
      gc: { botId: 'c', roomId: 'r1', turn: 2, since: 10, resumed: true, trigger: { role: 'room', roomId: 'r1', exchangeId: 'room-ex-3' } },
    },
    queued: {},
  }))

  const logs = new Map([
    ['gb', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'room-ex-1' }, content: textBlock('[Group chat "Ops"]\nGive status') } },
      { type: 'tool/call', seq: 3, data: { callId: 't1', name: 'bash', arguments: '{}' } },
      { type: 'assistant/message', seq: 4, data: { message: { content: textBlock('Deployment verified green.') } } },
      { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
    ['ga', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'room-ex-2' }, content: textBlock('[Group chat "Ops"]\nCoordinate') } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 throttled' } } } },
    ]],
    ['gc', []],
  ])

  const host = await startHost(t, { home, team, logs })
  t.mock.timers.tick(3000)
  await settle(() => (host.agents.get('r1')?.calls.length ?? 0) >= 3, 2000, 'all three group turns must post to r1')

  const roomPosts = host.agents.get('r1').calls.map(([, m]) => m)
  assert.ok(roomPosts.some(m => m.source?.senderSessionId === 'b' && textOf(m.content).includes('Deployment verified green.')), 'G-08: unseen completed group turn must post via lateRoomReply')
  assert.ok(roomPosts.some(m => m.source?.senderSessionId === 'a' && m.source?.failed?.code === 'RATE_LIMIT'), 'G-08: unseen failed group turn must post via lateRoomFailure')
  assert.ok(roomPosts.some(m => m.source?.senderSessionId === 'c' && m.source?.resumed === true && m.source?.again === true))
  // Double-interrupt reset gc's goal task to pending and blocked its group task!
  assert.equal(host.rt.state.rooms.r1.goal.stages[0].tasks[0].status, 'pending', 'G-08: double-interrupt must call goalTaskReset')
  assert.equal(host.rt.state.rooms.r1.tasks.gt1.status, 'blocked', 'G-08: double-interrupt must call blockTasks')
  assert.equal(host.rt.state.rooms.r1.tasks.gt1.blocked?.cause, 'restarted')

  // G-09: On an aborted unrelated primary turn, a non-stopped joined `role: 'room'` call is redelivered (not dropped),
  // while a disposed abort does NOT redeliver.
  const gbBefore = host.agents.get('gb')?.calls.length ?? 0
  host.emit('gb', 'turn/start', { turn: 10 })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nOld task'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'old-room-1' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nNew non-stopped call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'joined-room-keep' } })
  host.emit('gb', 'turn/end', { turn: 10, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await settle(() => (host.agents.get('gb')?.calls.length ?? 0) > gbBefore, 1000, 'G-09: non-stopped joined room call must be redelivered on aborted primary turn')
  const redelivered = host.agents.get('gb').calls.at(-1)[1]
  assert.equal(redelivered.source.exchangeId, 'joined-room-keep')
  assert.equal(redelivered.source.deferred, true)

  const gbBeforeDisposed = host.agents.get('gb').calls.length
  host.emit('gb', 'turn/start', { turn: 11 })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nOld task 2'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'old-room-2' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nShutdown call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'joined-room-disposed' } })
  host.emit('gb', 'turn/end', { turn: 11, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await realDelay(30)
  assert.equal(host.agents.get('gb').calls.length, gbBeforeDisposed, 'G-09: disposed abort must not redeliver during shutdown')

  // P1-4 & P2-2: reconcileEndedGroupTurn dedups against real groups.js:noteFailure ledger rows
  // (`{ kind: 'notice', reason: 'failed', about: member.id }`) AND own-name-prefixed replies (`Writer: ...`)!
  const homeDedup = mkdtempSync(join(tmpdir(), 'ds-bot-g08-dedup-'))
  t.after(() => rmSync(homeDedup, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(homeDedup, 'ledger'), { recursive: true })
  writeFileSync(join(homeDedup, 'ledger', bookFile('group-r1')), [
    JSON.stringify({ seq: 1, who: 'DS Bot', kind: 'notice', reason: 'failed', names: ['Chief'], about: 'a', code: 'RATE_LIMIT', message: '429', time: 20 }),
    JSON.stringify({ seq: 2, botId: 'b', name: 'Writer', text: 'Deployment verified green.', time: 20 }),
  ].join('\n') + '\n', 'utf8')
  writeFileSync(join(homeDedup, 'inflight.json'), JSON.stringify({
    turns: {
      ga: { botId: 'a', roomId: 'r1', turn: 1, since: 10, trigger: { role: 'room', roomId: 'r1', exchangeId: 'room-dedup-err' } },
      gb: { botId: 'b', roomId: 'r1', turn: 1, since: 10, trigger: { role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'room-dedup-ok' } },
    },
    queued: {},
  }))
  const dedupTeam = makeTeam({
    rooms: {
      r1: {
        id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true,
        sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 2, seen: {},
        goal: {
          id: 'g1', title: 'Ship', status: 'active', current: 0, revision: 0,
          stages: [{ id: 's1', title: 'Stage 1', status: 'active', tasks: [{ id: 'gtask1', botId: 'a', title: 'Check', status: 'working' }] }],
        },
      },
    },
  })
  const dedupLogs = new Map([
    ['ga', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'room-dedup-err' }, content: textBlock('[Group chat "Ops"]\nCoordinate') } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429' } } } },
    ]],
    ['gb', [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'room-dedup-ok' }, content: textBlock('[Group chat "Ops"]\nGive status') } },
      { type: 'assistant/message', seq: 3, data: { message: { content: textBlock('Writer: Deployment verified green.') } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]],
  ])
  const hostDedup = await startHost(t, { home: homeDedup, team: dedupTeam, logs: dedupLogs })
  t.mock.timers.tick(3000)
  await realDelay(40)
  assert.equal(hostDedup.agents.get('r1')?.calls.length ?? 0, 0, 'real noteFailure ledger row and own-name-prefixed reply must dedup cleanly without double posting')
  assert.equal(hostDedup.rt.state.rooms.r1.goal.stages[0].tasks[0].status, 'working', 'deduped failure must not re-run goalTaskReset')
})

test('F9 (ledger.js, delivery.js, handoffs.js): torn newline & prepend race fixes, drop clears lastWrite, incremental pairCache, disposed resolveAgent, async dropResults + orphan sweep', async (t) => {
  // 1) ledger.js: failed append sets entry.torn = true -> next queued append prepends `\n`,
  //    prepend queued behind a failed append does NOT resurrect the rolled-back record, and drop() clears lastWrite!
  const ledgerHome = mkdtempSync(join(tmpdir(), 'ds-bot-f9-ledger-'))
  t.after(() => rmSync(ledgerHome, { recursive: true, force: true, maxRetries: 5 }))
  const lrt = { home: ledgerHome, readOnly: () => undefined, warn() {} }
  installLedger(lrt)
  const bookPath = join(ledgerHome, 'ledger', bookFile('pair-a-b'))
  mkdirSync(join(ledgerHome, 'ledger'), { recursive: true })
  writeFileSync(bookPath, '{"id":"ok1","seq":2,"text":"good"}\n', 'utf8')
  assert.equal(lrt.ledger.records('pair-a-b').length, 1)

  // Make book path read-only (0o444) so appendFile fails while temp+rename prepend can still proceed.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(bookPath, 0o444)
    lrt.ledger.append('pair-a-b', { id: 'fail1', seq: 3, text: 'failed' })
    const fail1Write = lrt.ledger.written('pair-a-b')
    // Queue prepend synchronously behind the failing append!
    lrt.ledger.prepend('pair-a-b', [{ id: 'pre1', seq: 1, text: 'earlier' }])
    await assert.rejects(fail1Write)
    await lrt.ledger.flush('pair-a-b')
    chmodSync(bookPath, 0o644)
    const parsed = parseBook(readFileSync(bookPath, 'utf8'))
    assert.deepEqual(parsed.map(r => r.id), ['pre1', 'ok1'], 'failed append must never be resurrected by queued prepend')

    // Simulate a partial torn line left on disk after a failed append: queued append must start with `\n`!
    writeFileSync(bookPath, `${readFileSync(bookPath, 'utf8')}{"id":"torn-half"`, 'utf8')
    chmodSync(bookPath, 0o444)
    lrt.ledger.append('pair-a-b', { id: 'fail2', seq: 4, text: 'boom' })
    const fail2Write = lrt.ledger.written('pair-a-b')
    // Restore write permission only AFTER fail2 fails (before queued ok2 runs inside serialized chain).
    const restored = fail2Write.catch(() => { chmodSync(bookPath, 0o644) })
    lrt.ledger.append('pair-a-b', { id: 'ok2', seq: 5, text: 'recovered' })
    await assert.rejects(fail2Write)
    await restored
    await lrt.ledger.flush('pair-a-b')
    const afterTorn = parseBook(readFileSync(bookPath, 'utf8'))
    assert.deepEqual(afterTorn.map(r => r.id), ['pre1', 'ok1', 'ok2'], 'queued append after failed append must prepend newline so it is not fused onto torn bytes')

    // drop() must clear stale rejected lastWrite so subsequent written() resolves!
    chmodSync(bookPath, 0o444)
    lrt.ledger.append('pair-a-b', { id: 'fail3', seq: 6, text: 'fail-before-drop' })
    await assert.rejects(lrt.ledger.written('pair-a-b'))
    chmodSync(bookPath, 0o644)
    lrt.ledger.drop('pair-a-b')
    await assert.doesNotReject(() => lrt.ledger.written('pair-a-b'))
  }

  // 2) delivery.js incremental pairCache + disposed resolveAgent guard.
  const host = await startHost(t, { team: makeTeam() })
  await host.rt.deliver({ fromId: 'a', toId: 'b', text: 'hello 1', role: 'request', exchangeId: 'ex-1' })
  await host.rt.deliver({ fromId: 'b', toId: 'a', text: 'answer 1', role: 'reply', replyTo: 'ex-1', exchangeId: 'ex-2' })
  assert.equal(host.rt.wasReplyDelivered('b', 'a', 'ex-1'), true)
  assert.equal(host.rt.exchangeOf('ex-2', 'a', 'b')?.text, 'answer 1')
  await host.rt.deliver({ fromId: 'b', toId: 'a', text: 'fail notice', role: 'reply', replyTo: 'ex-1', exchangeId: 'ex-3', failureRequestId: 'req-err-1', work: 'w-parent' })
  assert.equal(host.rt.wasFailureRequestDelivered('b', 'a', 'req-err-1', 'dm-a', 'w-parent'), true)
  host.ctx.fiber = { uid: null }
  await assert.rejects(() => host.rt.resolveAgent('dm-a'), error => error.code === 'plugin/disposed')

  // 3) handoffs.js startup orphan handoff-results/*.txt sweep keeps referenced files and removes orphans.
  const orphanHome = mkdtempSync(join(tmpdir(), 'ds-bot-f9-orphans-'))
  t.after(() => rmSync(orphanHome, { recursive: true, force: true, maxRetries: 5 }))
  mkdirSync(join(orphanHome, 'handoff-results'), { recursive: true })
  writeFileSync(join(orphanHome, 'handoff-results', 'kept-1.txt'), 'x'.repeat(2500), 'utf8')
  writeFileSync(join(orphanHome, 'handoff-results', 'orphan-old.txt'), 'stale orphan', 'utf8')
  await startHost(t, {
    home: orphanHome,
    team: makeTeam({
      works: {
        w1: { from: 'a', to: 'b', open: [], results: [{ id: 'kept-1', name: 'Reviewer', text: 'x'.repeat(2000), length: 2500, file: 'kept-1.txt' }], at: 1 },
      },
    }),
  })
  await settle(() => !existsSync(join(orphanHome, 'handoff-results', 'orphan-old.txt')), 2000, 'startup sweep must remove orphaned result files')
  assert.equal(existsSync(join(orphanHome, 'handoff-results', 'kept-1.txt')), true, 'referenced result file must be kept')
})

test('F10 + State Hygiene + Weixin: deleteBot/startup prune requests & pair ledgers, pruneSettledTasks archives sessions, feed/tails suppress tasks & silent [PASS], weixin coalesces poll warnings', async (t) => {
  // 1) requests.js + roster.js + bot-tasks.js pruneSettledTasks archiving.
  const archiveCalls = []
  const host = await startHost(t, {
    archiveCalls,
    team: makeTeam({
      requests: {
        'a\u0000chat\u0000keep-me': { fingerprint: 'f1', outcome: 'delivered', receipt: 'ok', at: 1 },
        'c\u0000chat\u0000drop-on-delete': { fingerprint: 'f2', outcome: 'delivered', receipt: 'ok', at: 1 },
        'ghost\u0000chat\u0000orphan': { fingerprint: 'f3', outcome: 'delivered', receipt: 'ok', at: 1 },
      },
    }),
  })
  // Startup orphan request sweep cleans ghost caller while keeping living Bots' requests!
  await settle(() => host.rt.state.requests['ghost\u0000chat\u0000orphan'] === undefined, 2000, 'startup pruneOrphanRequests must remove deleted-Bot requests')
  assert.ok(host.rt.state.requests['a\u0000chat\u0000keep-me'], 'living Bot request must remain')
  assert.ok(host.rt.state.requests['c\u0000chat\u0000drop-on-delete'], 'living Bot request must remain before deleteBot')

  // Create a pair ledger with Reviewer ('c') then delete Reviewer -> both its requests and pair ledger drop!
  await host.rt.deliver({ fromId: 'a', toId: 'c', text: 'bye', role: 'request' })
  await host.rt.ledger.flush('pair-a-c')
  assert.equal(existsSync(join(host.home, 'ledger', 'pair-a-c.jsonl')), true)
  await host.rt.deleteBot('c')
  await host.rt.ledger.flush('pair-a-c')
  assert.equal(host.rt.state.requests['c\u0000chat\u0000drop-on-delete'], undefined, 'deleteBot must clean deleted Bot requests')
  assert.equal(existsSync(join(host.home, 'ledger', 'pair-a-c.jsonl')), false, 'deleteBot must drop deleted Bot pair ledgers')

  // pruneSettledTasks archives pruned settled task sessions when > MAX_SETTLED_TASKS (50).
  const chief = host.rt.botOf('a')
  chief.tasks = Array.from({ length: 50 }, (_, idx) => ({
    id: `k_old_${idx}`, title: `Old ${idx}`, brief: 'old', from: 'dm-a', sessionId: `old-task-sess-${idx}`,
    segments: idx === 0 ? [{ sessionId: 'old-task-seg-0', endedAt: 1 }] : [],
    origin: 'task-start', status: 'completed', startedAt: idx + 1, updatedAt: idx + 1, endedAt: idx + 2,
  }))
  const startRes = await host.tool('task_start', { title: 'Task 51', brief: 'triggers prune' }, 'dm-a')
  assert.match(startRes, /^Started background task/, `task_start failed: ${startRes}`)
  const newestTask = chief.tasks.at(-1)
  host.agents.get(newestTask.sessionId).inbox.nextTurn.length = 0
  host.emit(newestTask.sessionId, 'turn/start', { turn: 1 })
  host.emit(newestTask.sessionId, 'assistant/message', assistantText('Done 51'))
  host.emit(newestTask.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => archiveCalls.some(c => c.sid === 'old-task-sess-0'), 2000, 'pruneSettledTasks must archive pruned task session')
  await settle(() => archiveCalls.some(c => c.sid === 'old-task-seg-0'), 2000, 'pruneSettledTasks must archive pruned task segments too')
  assert.equal(archiveCalls.find(c => c.sid === 'old-task-seg-0').opts?.stopActivity, undefined, 'archiving a pruned task must not forcibly stop Session activity')

  // 2) F10: feed.js skips taskOwners events & streams, and displayItems/feed/tails suppress silent [PASS] on Bot-triggered own-chat turns!
  const abort = new AbortController()
  t.after(() => abort.abort())
  const feedRes = await host.routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: abort.signal }))
  const reader = feedRes.body.getReader()
  const decoder = new TextDecoder()
  const received = []
  void (async () => {
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }))
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (let idx = buf.indexOf('\n\n'); idx >= 0; idx = buf.indexOf('\n\n')) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = block.split('\n').find(l => l.startsWith('event: '))?.slice(7)
        const dataLine = block.split('\n').find(l => l.startsWith('data: '))?.slice(6)
        if (ev && dataLine) received.push({ event: ev, data: JSON.parse(dataLine) })
      }
    }
  })()
  await settle(() => received.some(e => e.event === 'hello'), 1000)

  // Prime chatTail for dm-a.
  host.rt.chatTail('dm-a')
  await realDelay(20)

  // Start an active task on Chief and emit assistant/message + stream -> MUST NOT appear in foreground SSE feed!
  await host.tool('task_start', { title: 'Hidden task', brief: 'bg work' }, 'dm-a')
  const activeTask = host.rt.botOf('a').tasks.find(item => item.title === 'Hidden task')
  host.emit(activeTask.sessionId, 'turn/start', { turn: 1 })
  host.emit(activeTask.sessionId, 'assistant/message', assistantText('raw background task output'))
  for (const fn of host.ctx.listeners.get('agent/assistant-stream') ?? []) {
    fn({ agent: { id: activeTask.sessionId }, frame: { type: 'start', attemptId: 'att-task', turn: 1 } })
    fn({ agent: { id: activeTask.sessionId }, frame: { type: 'chunk', attemptId: 'att-task', chunk: { type: 'text-delta', text: 'raw task stream' } } })
  }

  // Emit a Bot-triggered own-chat reply turn outputting [PASS] -> suppressed in feed AND chatTail BEFORE turn/end!
  host.emit('dm-a', 'turn/start', { turn: 20 })
  host.emit('dm-a', 'user/message', { content: textBlock('[Work completed by Writer · closed]\ndone'), source: { kind: SOURCE_KIND, role: 'reply', senderSessionId: 'b', exchangeId: 'rep-pass-1' } })
  host.emit('dm-a', 'assistant/message', assistantText('[PASS]'))

  // Emit a user-triggered turn outputting （收工。） -> MUST stay visible in feed and chatTail!
  host.emit('dm-a', 'turn/start', { turn: 21 })
  host.emit('dm-a', 'user/message', { content: textBlock('收工了吗'), source: { kind: 'user' } })
  host.emit('dm-a', 'assistant/message', assistantText('（收工。）'))
  host.emit('dm-a', 'turn/end', { turn: 21, reason: { kind: 'completed' } })

  await settle(() => received.some(e => e.event === 'message' && e.data?.item?.text === '（收工。）'), 1500)
  assert.equal(received.some(e => e.data?.sessionId === activeTask.sessionId), false, 'feed.js must never publish taskOwners events or streams')
  assert.equal(received.some(e => e.event === 'message' && e.data?.item?.text === '[PASS]'), false, 'feed.js must never flash silent [PASS] on Bot-triggered turn')
  assert.equal(host.rt.chatTail('dm-a')?.preview, '（收工。）', 'sidebar tail must show real user turn, never [PASS]')

  // P2-1: displayItems with seedTurn (historical mid-turn slice whose assistant/message omits event.data.turn)
  // must NOT be misclassified as live Bot-triggered turn when live.turn !== seedTurn!
  host.rt.live.set('dm-a', { turn: 30, info: { kind: SOURCE_KIND, role: 'reply', senderSessionId: 'b' } })
  const histItems = host.rt.displayItems('dm-a', [{ type: 'assistant/message', seq: 5, time: 1, data: assistantText('[PASS]') }], undefined, 1)
  assert.equal(histItems.length, 1, 'historical mid-turn slice with seedTurn !== live.turn must not be suppressed by live Bot turn')
  host.rt.live.delete('dm-a')

  // 3) weixin.js: repeated consecutive identical transient poll failures coalesce and log recovery count.
  let pollCalls = 0
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.url === '/ilink/bot/msg/notifystart') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ret: 0 }))
        return
      }
      if (req.url === '/ilink/bot/getupdates') {
        pollCalls += 1
        if (pollCalls <= 5) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ret: 500 }))
          return
        }
        if (pollCalls <= 7) {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html>gateway error</html>')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'ok-1' }))
      }
    })
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  const warns = []
  const base = `http://127.0.0.1:${srv.address().port}/`
  const runtime = {}
  const handle = weixin.connect(
    { token: 'tok', baseUrl: '' },
    {
      fetch: globalThis.fetch,
      WebSocket: globalThis.WebSocket,
      config: { api: base, qr: base, cdn: `${base}cdn`, startRetryDelaysMs: [5], pollRetryMs: 5 },
      runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) },
      log: { warn: (...args) => warns.push(format(...args)) },
    },
    { onMessage: () => {}, onAction: () => {}, onStatus: () => {} },
  )
  t.after(() => { handle.stop(); srv.closeAllConnections?.(); srv.close() })
  await settle(() => runtime.cursor === 'ok-1', 3000, 'weixin poll must recover after transient errors')
  handle.stop()

  // 5 identical ret=500 errors logged ONCE (plus 1 summary when error changed), 2 unreadable logged ONCE, then 1 recovery log!
  assert.equal(warns.filter(w => w.includes('getupdates answered 500')).length, 1, `ret=500 must be coalesced: ${JSON.stringify(warns)}`)
  assert.ok(warns.some(w => /previous error repeated 5 times/.test(w)), `error change must report prior repeat count: ${JSON.stringify(warns)}`)
  assert.equal(warns.filter(w => w.includes('poll failed: WeChat answered an unreadable response')).length, 1, `unreadable repeats must be coalesced: ${JSON.stringify(warns)}`)
  assert.ok(warns.some(w => /recovered after 2 consecutive failures/.test(w)), `recovery must report suppressed count: ${JSON.stringify(warns)}`)
})

test('P1 merge regression (turns.js): aborted turn settles live roomWaiter without falsely coalescing away waiterless room calls in same room/scope', async (t) => {
  const host = await startHost(t, {
    team: makeTeam({
      rooms: {
        r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {} },
      },
    }),
  })
  // 1) Same (roomId, askedBy) scope: live waiter settles with null, waiterless call STILL redelivers.
  const callsBefore1 = host.agents.get('gb')?.calls.length ?? 0
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nPrimary work'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'primary-abort-1' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nLive waiter call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'joined-live-scoped' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nWaiterless same-scope call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', askedBy: 'a', exchangeId: 'joined-waiterless-scoped' } })
  let scopedWaiterResult = 'pending'
  host.rt.roomWaiters.set('joined-live-scoped', {
    sessionId: 'gb', botId: 'b', roomId: 'r1',
    resolve: value => { scopedWaiterResult = value },
    fail: failure => { scopedWaiterResult = { failure } },
    touch() {}, work() {}, say() {}, approval() {},
  })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal(scopedWaiterResult, null, 'live roomWaiter must settle immediately with null on abort')
  assert.equal(host.rt.roomWaiters.has('joined-live-scoped'), false)
  await settle(() => (host.agents.get('gb')?.calls.length ?? 0) > callsBefore1, 1500, 'waiterless same-scope call must not be coalesced away by aborted live waiter')
  const added1 = host.agents.get('gb').calls.slice(callsBefore1).map(([, msg]) => msg)
  assert.deepEqual(added1.map(m => m.source?.exchangeId), ['joined-waiterless-scoped'])
  assert.equal(added1[0].source?.deferred, true)

  // 2) Room-wide (askedBy undefined): live waiter settles with null, room-wide waiterless call STILL redelivers.
  const callsBefore2 = host.agents.get('gb')?.calls.length ?? 0
  host.emit('gb', 'turn/start', { turn: 2 })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nPrimary work 2'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'primary-abort-2' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nLive waiter call 2'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'joined-live-room' } })
  host.emit('gb', 'user/message', { content: textBlock('[Group chat "Ops"]\nWaiterless room-wide call'), source: { kind: SOURCE_KIND, role: 'room', roomId: 'r1', exchangeId: 'joined-waiterless-room' } })
  let roomWaiterResult = 'pending'
  host.rt.roomWaiters.set('joined-live-room', {
    sessionId: 'gb', botId: 'b', roomId: 'r1',
    resolve: value => { roomWaiterResult = value },
    fail: failure => { roomWaiterResult = { failure } },
    touch() {}, work() {}, say() {}, approval() {},
  })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal(roomWaiterResult, null, 'room-wide live roomWaiter must settle immediately with null on abort')
  assert.equal(host.rt.roomWaiters.has('joined-live-room'), false)
  await settle(() => (host.agents.get('gb')?.calls.length ?? 0) > callsBefore2, 1500, 'room-wide waiterless call must not be coalesced away by aborted live waiter')
  const added2 = host.agents.get('gb').calls.slice(callsBefore2).map(([, msg]) => msg)
  assert.deepEqual(added2.map(m => m.source?.exchangeId), ['joined-waiterless-room'])
  assert.equal(added2[0].source?.deferred, true)
})
