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

test('message_bot to a joined Bot on another machine needs the work link: without it nothing is sent, nothing is written into its page here (W3)', async (t) => {
  const w = await start(team())
  t.after(w.stop)
  // This fixture has no AC bot-network with the reliable link (no `post`): the work cannot leave.
  await assert.rejects(w.tool('message_bot', { to: 'Remote', message: 'please run one turn' }, 'a'), /cross-machine work is not available on this machine/)
  assert.deepEqual(w.frames.map(frame => frame.type), [], 'no bot/turn')
  assert.ok(!w.resolved.includes('joined:n1:rb1'), 'the shadow id was never resolved as a local Session')
  const session = w.sessions.get('mirror-j')
  assert.equal((session?.log ?? []).filter(event => event.type === 'user/message').length, 0, 'nothing written into the mirror as if the user had said it')
  assert.equal(Object.values(w.rt.state.works ?? {}).some(work => work.to === 'joined:n1:rb1'), false, 'no wait is left open')
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
