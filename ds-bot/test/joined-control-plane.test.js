// The control plane for a Bot that runs on another machine: stop_bot must reach the node
// (bot/stop) instead of answering "not running" from a local live table, and run-stats must
// report the remote turn state instead of resolving a mirror Session that may not exist.
// Everything here drives the real runtime, the real tools and the real channel endpoint.
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installJoinedTurn, createBotStopReceiver, BRIDGE_DOWN_TEXT, STOPPED_TEXT } from '../src/host/joined-turn.js'

const { Session } = await import('@deepseek-ai/dsh-session')

const settle = async (times = 6) => { for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve)) }

const REMOTE = 'joined:n1:rb1'

function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      [REMOTE]: {
        id: REMOTE, name: 'Remote', origin: 'joined', type: 'remote-worker',
        worker: { nodeId: 'n1', remoteBotId: 'rb1', hostname: 'box-1', home: 'remote', online: true },
        createdAt: 2,
      },
      'peer:h1:pb1': {
        id: 'peer:h1:pb1', name: 'Peer', origin: 'peer', type: 'remote-worker',
        readonly: true, worker: { hubId: 'h1', home: 'hub' }, createdAt: 3,
      },
      b: { id: 'b', name: 'Local', role: 'Help', sessionId: 'b', createdAt: 4 },
      w: {
        id: 'w', name: 'Bridge', type: 'remote-worker', sessionId: 'w',
        worker: { nodeId: 'n2', remoteBotId: 'rw1', hostname: 'box-2', home: 'remote', online: true },
        createdAt: 5,
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, works: {}, questions: {}, prefs: {}, revision: 0,
  }
}

async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-control-plane-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const sessions = new Map()
  const resolved = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'mirror-j' }),
      resolveAgent: async (sessionId) => {
        resolved.push(sessionId)
        // A Bot's own chat is not a Session this fixture created, but a reply still has to land there.
        if (!sessions.has(sessionId) && sessionId !== 'a' && sessionId !== 'b') throw new Error(`session "${sessionId}" not found`)
        const session = sessions.get(sessionId)
        return { agent: { session, id: sessionId, status: 'idle', followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove: () => false } } }
      },
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { ctx.route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  const registry = new EventEmitter()
  const frames = []
  let queue = true
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return queue }
  const get = ctx.get.bind(ctx)
  ctx.get = key => (key === 'remote-agent:registry' ? registry : get(key))
  rt.createSession = async () => {
    const sid = 'mirror-j'
    if (!sessions.has(sid)) sessions.set(sid, new Session(sid))
    return sid
  }
  installJoinedTurn(rt)
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => rt.teamTools.find(def => def.name === name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  const stop = async () => {
    for (const id of Object.keys(rt.state?.works ?? {})) rt.dropWork(id)
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, registry, frames, sessions, resolved, call, tool, stop, setQueue: (v) => { queue = v } }
}

test('stop_bot on a joined Bot sends bot/stop and reports the node\'s answer', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  const pending = w.tool('stop_bot', { bot: 'Remote', reason: 'stop now' }, 'a')
  await settle()
  const frame = w.frames.find(f => f.type === 'bot/stop')
  assert.ok(frame, 'bot/stop must go to the node')
  assert.equal(frame.nodeId, 'n1')
  assert.equal(frame.payload.remoteBotId, 'rb1')
  assert.equal(typeof frame.payload.requestId, 'string')
  assert.ok(!w.resolved.includes(REMOTE), 'the shadow id is never resolved as a local Session')

  w.registry.emit('botStopResult', { requestId: frame.payload.requestId, ok: true, stopped: true })
  const reply = await pending
  assert.equal(reply, 'Stopped Remote on box-1. It is told why in a new turn, whose reply comes back to you.')
  const told = w.frames.find(f => f.type === 'bot/turn')
  assert.ok(told, 'the stopped Bot is told why through the existing turn path')
  assert.equal(told.payload.text, 'stop now')
})

test('stop_bot on a joined Bot that is not running refuses with the node\'s answer', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  const pending = w.tool('stop_bot', { bot: 'Remote' }, 'a')
  await settle()
  const frame = w.frames.find(f => f.type === 'bot/stop')
  w.registry.emit('botStopResult', { requestId: frame.payload.requestId, ok: true, stopped: false })
  await assert.rejects(pending, /is not running right now on box-1/)
})

test('stop_bot on a joined Bot with the bridge down does not pretend it stopped', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  w.setQueue(false)
  await assert.rejects(w.tool('stop_bot', { bot: 'Remote' }, 'a'), /bridge to that machine is down/)
  assert.equal(w.frames.filter(f => f.type === 'bot/stop').length, 1)
})

test('stop_bot refuses a peer row instead of sending a frame', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  // The load drops peer rows while federation is off; put one back to reach the guard.
  w.rt.state.bots['peer:h1:pb1'] = {
    id: 'peer:h1:pb1', name: 'Peer', origin: 'peer', type: 'remote-worker',
    readonly: true, worker: { hubId: 'h1', home: 'hub' }, createdAt: 3,
  }
  await assert.rejects(w.tool('stop_bot', { bot: 'Peer' }, 'a'), /read-only here/)
  assert.equal(w.frames.length, 0)
})

// The stop has to reach the exchange through the tool, not through a direct call to
// settleStoppedTurns. Deleting the call in tools.js must turn this red.
test('stop_bot settles the exchange still in flight, and a late nodeOffline writes nothing', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  // The shadow has no mirror session yet, and this fixture's createSession only resolves
  // once something asks for it. Without that, the dispatch waits forever before the frame.
  const mirrorReady = w.rt.createSession(REMOTE + ' (mirror)')
  const inflight = w.rt.deliver({ fromId: 'a', toId: REMOTE, text: 'keep going', role: 'request' })
  await mirrorReady
  await settle(40)
  const turn = w.frames.find(f => f.type === 'bot/turn')
  assert.ok(turn, 'the exchange reached the node before it was stopped')

  const exchangeId = turn.payload.exchangeId
  const pending = w.tool('stop_bot', { bot: 'Remote', reason: 'stop now' }, 'a')
  await settle()
  const frame = w.frames.find(f => f.type === 'bot/stop')
  w.registry.emit('botStopResult', { requestId: frame.payload.requestId, ok: true, stopped: true })
  await pending
  // The late frames arrive after the stop. For the exchange the stop settled they are dropped.
  // The deliver after the settle opens a new exchange, the notice that tells the Bot why, and a
  // node drop before that notice is answered is a bridge-down for the new exchange only.
  w.registry.emit('nodeOffline', { nodeId: 'n1' })
  w.registry.emit('botTurnResult', { exchangeId, ok: true, text: 'late result the stop already closed', seq: 4 })
  await settle(40)

  assert.deepEqual(await inflight, { ok: false, error: 'stopped' }, 'the exchange still in flight ends as stopped')
  const replies = w.rt.state.exchanges.filter(row => row.replyTo === exchangeId)
  assert.equal(replies.length, 1, 'the sender is told once, and the late frames add nothing for this exchange')
  assert.equal(replies[0].text, STOPPED_TEXT, 'the receipt says it was stopped')
  assert.equal(replies.some(row => row.text === BRIDGE_DOWN_TEXT), false, 'the bridge-down line is not written for the exchange the stop settled')
  assert.equal(w.rt.state.exchanges.some(row => row.text === 'late result the stop already closed'), false, 'the late result is not delivered')

  const mirror = w.sessions.get('mirror-j')
  const assistant = mirror.log.filter(event => event.type === 'assistant/message')
    .map(event => event.data.message?.content?.map(part => part.text ?? '').join('') ?? '')
  assert.ok(assistant.some(text => text.includes('已停止等待节点')), 'the mirror shows the stop card')
  assert.ok(mirror.log.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'aborted'), 'the mirror closes the stopped turn as aborted, not failed')
})

test('the node receiver stops the local turn and reports whether one was running', async () => {
  const ran = []
  const stopped = createBotStopReceiver({ stopChat: async (id) => { ran.push(id); return true } })
  assert.deepEqual(await stopped({ remoteBotId: 'session-x' }), { ok: true, stopped: true })
  const idle = createBotStopReceiver({ stopChat: async () => false })
  assert.deepEqual(await idle({ remoteBotId: 'session-x' }), { ok: true, stopped: false })
  const broken = createBotStopReceiver({ stopChat: async () => { throw new Error('nope') } })
  const failed = await broken({ remoteBotId: 'session-x' })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /nope/)
  assert.deepEqual(ran, ['session-x'])
})

test('run-stats on a joined Bot reports the remote turn state without a mirror Session', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  const result = await w.call('run-stats', { botId: REMOTE })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { remote: true, nodeId: 'n1', hostname: 'box-1', running: false, startedAt: null })
  assert.ok(!w.resolved.includes(REMOTE), 'no local Session was resolved for the shadow')

  w.rt.joinedInFlight = new Map([[REMOTE, { requestId: 'r1', abort() {}, startedAt: 1234 }]])
  const running = await w.call('run-stats', { botId: REMOTE })
  assert.equal(running.value.running, true)
  assert.equal(running.value.startedAt, 1234)
})

test('run-stats leaves a worker-bridge Bot on its local projection path', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  const result = await w.call('run-stats', { botId: 'w' })
  assert.equal(result.ok, true)
  assert.equal(result.value, null, 'no projections service → the local answer, not the remote structure')
  assert.equal(result.value?.remote, undefined)
  assert.deepEqual(w.resolved, [], 'the local path without projections resolves no Session')
})

test('run-stats keeps the local projection path for a local Bot', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  const result = await w.call('run-stats', { botId: 'b' })
  assert.equal(result.ok, true)
  assert.equal(result.value, null, 'no projections service in this harness → the local answer is null')
  assert.deepEqual(w.resolved, [], 'a local Bot with no projections service is not resolved either')
})
