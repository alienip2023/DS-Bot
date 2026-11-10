// s50 / merge plan I3 (R5): upstream v0.3.2 adds `abandon-work` (channel.js → rt.abandonWork): giving up
// a wait closes the sub-work and then DELIVERS a "no reply came back" message to the Bot that waited
// (handoffs.js abandonWork → rt.deliver({ role: 'reply', abandoned: true, recordExchange: false })).
// If that waiting Bot is a joined (remote) shadow, the message must not become a local turn, must not
// be written into the mirror Session, and must not reach a live Agent attached to the mirror Session.
// Written BEFORE the merge: on fork.76 there is no abandon-work endpoint, so the cases are red until
// the merged delivery.js / channel.js carry it AND our interception still sits in front.
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRuntime } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'
import { realAgentWorld, REAL_AGENT_SKIP } from './real-agent.js'

const { Session } = await import('@deepseek-ai/dsh-session')

const JOINED = 'joined:n1:rb1'
const LOCAL_A = 'local-a'
const LOCAL_B = 'local-b'

function world() {
  const emitter = new EventEmitter()
  const frames = []
  const registry = { send: (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true }, on: (e, f) => emitter.on(e, f), off: (e, f) => emitter.off(e, f) }
  const ctx = fakeContext({ services: { 'remote-agent:registry': registry } })
  const registered = []
  const baseOn = ctx.on
  ctx.on = (name, listener, options) => { registered.push({ name, listener, options }); return baseOn(name, listener, options) }
  ctx.sessionController = {
    prompt: async () => ({ accepted: true }),
    list: async () => ({ items: [] }),
    cancel: async () => ({ accepted: true }),
  }
  const routes = []
  ctx.connection.fetch.register = route => { routes.push(route); return () => {} }
  const rt = createRuntime(ctx, { home: mkdtempSync(join(tmpdir(), 'ds-bot-abandon-')) })
  rt.state.bots[JOINED] = { id: JOINED, name: 'Joined', origin: 'joined', type: 'remote-worker', sessionId: 'mirror-1', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true } }
  rt.state.bots[LOCAL_A] = { id: LOCAL_A, name: 'Local A', sessionId: 'sess-a' }
  rt.state.bots[LOCAL_B] = { id: LOCAL_B, name: 'Local B', sessionId: 'sess-b' }
  const sessions = new Map()
  const sessionOf = sid => { if (!sessions.has(sid)) sessions.set(sid, new Session(sid)); return sessions.get(sid) }
  rt.createSession = async () => 'mirror-1'
  rt.resolveAgent = async sid => ({ session: sessionOf(sid) })
  sessionOf('mirror-1')
  const call = async (endpoint, payload) => {
    const route = routes.find(r => r.path === ROUTE)
    const response = await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })
    return JSON.parse(await response.text())
  }
  // The delivery the abandon sends, recorded WITH its real outcome (the real deliver still runs).
  const delivered = []
  const realDeliver = rt.deliver
  rt.deliver = async (args) => {
    const entry = { args, outcome: undefined, error: undefined }
    delivered.push(entry)
    try { entry.outcome = await realDeliver(args); return entry.outcome } catch (error) { entry.error = error; throw error }
  }
  return { ctx, rt, registered, frames, sessionOf, call, delivered }
}

// A wait: `waiter` handed work `parent` to `parentTo`, and is waiting for `sub`, which `from`→`to` was given.
function openWait(w, { waiter, sub = 'sub-1', parent = 'parent-1', subTo = LOCAL_B }) {
  const at = Date.now()
  w.rt.state.works = {
    [parent]: { from: LOCAL_B === waiter ? LOCAL_A : LOCAL_B, to: waiter, open: [sub], results: [], at },
    [sub]: { from: waiter, to: subTo, parent, open: [], results: [], at },
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('S50-abandon: abandon-work with a joined shadow', () => {
  it('J-wired: abandon-work is a real endpoint of the assembled runtime and gives up an open wait', async () => {
    const w = world()
    openWait(w, { waiter: LOCAL_A })
    assert.equal(typeof w.rt.abandonWork, 'function')
    const result = await w.call('abandon-work', { id: 'sub-1' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(w.rt.state.works['sub-1'], undefined, 'the sub-work closed')
    assert.deepEqual(w.rt.state.works['parent-1'].open, [], 'the wait is over for the parent')
    const again = await w.call('abandon-work', { id: 'sub-1' })
    assert.equal(again.ok, false, 'a second give-up finds nothing open')
  })

  it('J-control: a LOCAL waiting Bot is told (the interception is not a global switch-off)', async () => {
    const w = world()
    openWait(w, { waiter: LOCAL_A })
    await w.call('abandon-work', { id: 'sub-1' })
    await settle()
    assert.equal(w.delivered.length, 1)
    assert.equal(w.delivered[0].args.toId, LOCAL_A)
    assert.equal(w.delivered[0].args.role, 'reply')
  })

  it('J-refused: when the Bot that waited is a joined shadow, the delivery is refused — no local turn, nothing written to the mirror Session, nothing sent to the node', async () => {
    const w = world()
    openWait(w, { waiter: JOINED })
    const mirror = w.sessionOf('mirror-1')
    const before = mirror.log.length
    const result = await w.call('abandon-work', { id: 'sub-1' })
    assert.equal(result.ok, true, JSON.stringify(result))
    await settle()
    assert.equal(w.delivered.length, 1, 'the abandon delivered once')
    const sent = w.delivered[0]
    assert.equal(sent.args.toId, JOINED)
    assert.equal(sent.error, undefined, 'the refusal is an outcome, not a crash')
    assert.deepEqual(sent.outcome, { ok: false, error: 'joined shadow cannot dispatch' }, 'the delivery interception answered')
    assert.equal(mirror.log.length, before, 'the mirror Session got no event')
    assert.deepEqual(w.frames, [], 'nothing was sent to the node')
    assert.equal(w.rt.mirrorGuardRefused ?? 0, 0, 'refused at the delivery, before it reached the guard')
    assert.equal(w.rt.state.bots[JOINED].sessionId, 'mirror-1')
  })

  it('J-real-agent: with a REAL Agent attached to the mirror Session, the abandon starts no native turn on it', { skip: REAL_AGENT_SKIP }, async () => {
    const w = world()
    openWait(w, { waiter: JOINED })
    const real = await realAgentWorld()
    try {
      const announce = async agent => { for (const entry of w.registered) if (entry.name === 'agent/created' && entry.options?.prepend === true) await entry.listener({ agent }) }
      const mirror = await real.create('mirror-1')
      await announce(mirror)
      w.rt.resolveAgent = async sid => (sid === 'mirror-1' ? mirror : { session: w.sessionOf(sid) })
      const result = await w.call('abandon-work', { id: 'sub-1' })
      assert.equal(result.ok, true, `the abandon really ran: ${JSON.stringify(result)}`)
      await settle()
      assert.equal(w.delivered.length, 1, 'and it delivered to the joined Bot')
      await mirror.whenIdle()
      const types = real.types(mirror)
      assert.equal(types.includes('turn/start'), false, `no native turn: ${types}`)
      assert.equal(types.includes('agent/inbox/spliced'), false)
      assert.equal(mirror.inbox.hasPending, false)
    } finally { await real.dispose() }
  })

  it('J-gone: the startup sweep that abandons waits on deleted Bots never reaches a shadow either', async () => {
    const w = world()
    openWait(w, { waiter: JOINED, subTo: 'deleted-bot' })
    const mirror = w.sessionOf('mirror-1')
    const before = mirror.log.length
    assert.equal(w.rt.abandonWork?.('sub-1', 'gone'), true)
    await settle()
    assert.equal(mirror.log.length, before)
    assert.deepEqual(w.frames, [])
  })
})
