// A Bot that runs on another machine has no local Session on this machine. message_bot used to
// resolve `rt.chatOf(target.id)` + `rt.resolveAgent(...)` before delivery.js could route the
// request, so the send failed with `session "…" not found` and never reached the joined /
// remote-worker branches. These tests drive the real runtime, real tools and real delivery,
// with the same "no such local session" refusal the core gives.
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installJoinedTurn } from '../src/host/joined-turn.js'

const { Session } = await import('@deepseek-ai/dsh-session')

const settle = async (times = 6) => { for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve)) }

function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      'joined:n1:rb1': {
        id: 'joined:n1:rb1', name: 'Remote', origin: 'joined', type: 'remote-worker',
        worker: { nodeId: 'n1', remoteBotId: 'rb1', hostname: 'box-1', home: 'remote', online: true },
        createdAt: 2,
      },
      w1: {
        id: 'w1', name: 'Worker', origin: 'local', type: 'remote-worker',
        worker: { nodeId: 'n2', hostname: 'box-2' }, createdAt: 3,
      },
    },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
}

async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-delivery-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const sessions = new Map()
  const resolved = []
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined, deriveMessages: () => [] },
        id: sessionId, status: 'idle',
        followup() {}, steer() {}, inject() {}, cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'mirror-j' }),
      resolveAgent: async (sessionId) => {
        resolved.push(sessionId)
        // The core's answer for an id that is not a live Session on this machine.
        if (!sessions.has(sessionId) && sessionId !== 'a' && sessionId !== 'b') throw new Error(`session "${sessionId}" not found`)
        return { agent: sessions.get(sessionId) ? { session: sessions.get(sessionId), id: sessionId, status: 'idle', followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove: () => false } } : agentOf(sessionId) }
      },
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  const registry = new EventEmitter()
  const frames = []
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true }
  const get = ctx.get.bind(ctx)
  ctx.get = key => (key === 'remote-agent:registry' ? registry : get(key))
  // The mirror Session is created on demand; ensureMirrorSession resolves it after create().
  rt.createSession = async () => {
    const sid = 'mirror-j'
    if (!sessions.has(sid)) sessions.set(sid, new Session(sid))
    return sid
  }
  const realResolve = ctx.sessionController.resolveAgent
  ctx.sessionController.resolveAgent = async (sessionId) => {
    if (sessions.has(sessionId)) return realResolve(sessionId)
    return realResolve(sessionId)
  }
  installJoinedTurn(rt)
  const tool = (name, args, sessionId) => rt.teamTools.find(def => def.name === name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  const stop = async () => {
    // A delivered request opens a work whose 30-minute delegate timer is a ref'd timeout
    // (handoffs.js openWork). Production clears it by the reply or by the timer itself; a
    // test home has no later reply, so the timer would be the one handle keeping this
    // process alive. Dropping the works clears those timers before the runtime is disposed.
    for (const id of Object.keys(rt.state?.works ?? {})) rt.dropWork(id)
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, registry, frames, sessions, resolved, tool, stop }
}

test('message_bot to a joined Bot on another machine sends bot/turn without a local session', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  let reply
  try {
  reply = await w.tool('message_bot', { to: 'Remote', message: 'please run one turn' }, 'a')
  assert.equal(reply, 'Delivered to Remote on box-1. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(w.frames.map(frame => frame.type), ['bot/turn'])
  assert.equal(w.frames[0].nodeId, 'n1')
  assert.equal(w.frames[0].payload.remoteBotId, 'rb1')
  assert.equal(w.frames[0].payload.text, 'please run one turn')
  assert.ok(!w.resolved.includes('joined:n1:rb1'), 'the shadow id was never resolved as a local Session')
  const session = w.sessions.get('mirror-j')
  assert.deepEqual(session.log.filter(event => event.type === 'user/message').map(event => event.data.content.map(part => part.text).join('')), ['please run one turn'])

  w.registry.emit('botTurnResult', { exchangeId: w.frames[0].payload.exchangeId, ok: true, text: 'one turn done', seq: 1 })
  await settle()
  assert.deepEqual(
    session.log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content.map(part => part.text).join('')),
    ['one turn done'],
  )
  assert.equal(w.rt.state.exchanges.at(-1)?.text, 'one turn done')
  } finally {
    // Clear any wait left by a failed assertion so the test process can exit.
    for (const frame of w.frames) w.registry.emit('botTurnResult', { exchangeId: frame.payload.exchangeId, ok: false, error: 'test-over', seq: 99 })
    await settle()
  }
})

test('message_bot to a remote worker goes through the remote-worker branch of deliver', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  const calls = []
  w.rt.handleRemoteTurn = async (msg) => { calls.push(msg); return 'ex-worker' }
  const reply = await w.tool('message_bot', { to: 'Worker', message: 'do the work' }, 'a')
  assert.equal(reply, 'Delivered to Worker on box-2. Its reply will arrive later as a new message; do not wait for it.')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].toId, 'w1')
  assert.equal(calls[0].text, 'do the work')
  assert.ok(!w.resolved.includes('w1'), 'the worker id was never resolved as a local Session')
})
