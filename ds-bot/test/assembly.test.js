// Assembly-level checks: the REAL createRuntime (every module installed in index.js order)
// on one ctx.sessionController, and the REAL route handler registered on the connection.
// Unit tests of joined-prompt.js and createJoinedEnsureRoute cannot see a module that was
// never installed or a route case that was never wired; these can.
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRuntime, MODULES } from '../index.js'
import * as turns from '../src/host/turns.js'
import * as channel from '../src/host/channel.js'
import * as joinedPrompt from '../src/host/joined-prompt.js'
import * as mirrorGuard from '../src/host/mirror-guard.js'
import { realAgentWorld, REAL_AGENT_SKIP } from './real-agent.js'
import { ROUTE } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'
import { JOINED_TURN_TIMEOUT_MS } from '../src/host/joined-turn.js'

const { Session } = await import('@deepseek-ai/dsh-session')

function world({ withPrompt = true, config = {} } = {}) {
  const emitter = new EventEmitter()
  const frames = []
  const registry = {
    send: (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true },
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
  }
  const ctx = fakeContext({ services: { 'remote-agent:registry': registry } })
  // Every ctx.on registration with its options, so a test can tell which listener is the prepended one.
  const registered = []
  const baseOn = ctx.on
  ctx.on = (name, listener, options) => { registered.push({ name, listener, options }); return baseOn(name, listener, options) }
  const originalCalls = []
  if (withPrompt) ctx.sessionController = { prompt: async (...args) => { originalCalls.push(args); return { accepted: true, from: 'original' } } }
  const routes = []
  ctx.connection.fetch.register = route => { routes.push(route); return () => {} }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-assembly-'))
  const rt = createRuntime(ctx, { home, ...config })
  const bot = {
    id: 'joined:n1:rb1', name: 'Joined', origin: 'joined', type: 'remote-worker',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true },
  }
  rt.state.bots[bot.id] = bot
  const sessions = new Map()
  const created = []
  const sessionOf = sid => { if (!sessions.has(sid)) sessions.set(sid, new Session(sid)); return sessions.get(sid) }
  // The Session host (workspace registry) is the only thing stood in for.
  rt.createSession = async () => { const sid = `mirror-${created.length + 1}`; created.push(sid); sessionOf(sid); return sid }
  rt.resolveAgent = async sid => ({ session: sessionOf(sid) })
  // What ensureMirrorSession leaves behind: the Bot's sessionId, indexed by the real save().
  const mirror = async (sid = 'mirror-1') => { bot.sessionId = sid; sessionOf(sid); await rt.save() }
  const call = async (endpoint, payload) => {
    const route = routes.find(r => r.path === ROUTE)
    assert.ok(route, 'the api route is registered')
    const response = await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })
    return JSON.parse(await response.text())
  }
  const prompt = request => ctx.sessionController.prompt(request, new AbortController().signal)
  return { ctx, rt, bot, registered, frames, originalCalls, routes, created, sessionOf, mirror, call, prompt, emitter }
}

const textRequest = (sessionId, text = 'hi', requestId = 'req-1') => ({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] })

describe('S24-asm: the takeover is installed in the running chain', () => {
  it('S24-asm-order: MODULES lists joinedPrompt after turns (outermost prompt wrapper) and after channel', () => {
    const at = module => MODULES.indexOf(module)
    assert.ok(at(joinedPrompt) >= 0, 'joinedPrompt is installed')
    assert.ok(at(turns) >= 0 && at(channel) >= 0)
    assert.ok(at(joinedPrompt) > at(turns), 'joinedPrompt wraps turns\' prompt, not the other way round')
    assert.ok(at(joinedPrompt) > at(channel), 'joinedPrompt installs after channel')
    assert.equal(MODULES.filter(module => module === joinedPrompt).length, 1)
  })

  it('S24-asm-joined: on the real chain a joined mirror prompt never reaches the original prompt and goes to the node once', async () => {
    const w = world()
    await w.mirror()
    const ack = await w.prompt(textRequest('mirror-1', 'to the node'))
    assert.deepEqual(ack, { accepted: true })
    assert.equal(w.originalCalls.length, 0, 'no local model turn')
    assert.equal(w.frames.filter(f => f.type === 'bot/turn').length, 1)
    assert.equal(w.frames[0].payload.text, 'to the node')
    const user = w.sessionOf('mirror-1').log.find(event => event.type === 'user/message')
    assert.equal(user.data.source.rpcId, 'req-1')
  })

  it('S24-asm-ordinary: on the real chain an ordinary Session reaches the original prompt once with the same arguments', async () => {
    const w = world()
    await w.mirror()
    const request = textRequest('ordinary-session')
    const signal = new AbortController().signal
    const result = await w.ctx.sessionController.prompt(request, signal)
    assert.equal(result.from, 'original')
    assert.equal(w.originalCalls.length, 1)
    assert.equal(w.originalCalls[0][0], request)
    assert.equal(w.originalCalls[0][1], signal)
    assert.equal(w.frames.length, 0)
  })

  it('S24-asm-outermost: a takeover refusal leaves the chain untouched — the turns wrapper does not re-word it', async () => {
    const w = world()
    await w.mirror()
    // The turns wrapper rewrites rejections of Bot Sessions (message + details.reason + a noted failure).
    // The takeover's own refusals must come out exactly as joined-prompt wrote them, so it sits outside it.
    assert.equal(w.rt.isBotSession('mirror-1'), true, 'the turns wrapper would treat this Session as a Bot Session')
    const noted = []
    const original = w.rt.noteFailure
    w.rt.noteFailure = (...args) => { noted.push(args); return original?.(...args) }
    await w.prompt(textRequest('mirror-1', 'first', 'req-1'))
    const error = await w.prompt(textRequest('mirror-1', 'second', 'req-2')).then(() => assert.fail('busy expected'), e => e)
    assert.equal(error.code, 'session/agent-busy')
    assert.equal(error.message, '副机 Bot 正在回复上一条，请稍候再发', 'message not suffixed by the turns wrapper')
    assert.equal(noted.length, 0, 'the turns wrapper never saw the refusal')
  })
})

describe('S24-asm-route: the joined-ensure case is wired in the real route switch', () => {
  it('S24-asm-ensure: POST joined-ensure creates the mirror once, returns its id, and a second call creates nothing', async () => {
    const w = world()
    const first = await w.call('joined-ensure', { botId: w.bot.id })
    assert.deepEqual(first, { ok: true, value: { sessionId: 'mirror-1' } })
    assert.equal(w.created.length, 1)
    assert.equal(w.bot.sessionId, 'mirror-1')
    const second = await w.call('joined-ensure', { botId: w.bot.id })
    assert.deepEqual(second, { ok: true, value: { sessionId: 'mirror-1' } })
    assert.equal(w.created.length, 1, 'already there: not created again')
  })

  it('S24-asm-ensure-refuse: a Bot that is not a joined one is refused through the same route (body reaches the handler)', async () => {
    const w = world()
    w.rt.state.bots.local = { id: 'local', name: 'Local', sessionId: 'local-session' }
    const result = await w.call('joined-ensure', { botId: 'local' })
    assert.equal(result.ok, false)
    assert.equal(result.error.message, 'Not a joined Bot')
    assert.equal(w.created.length, 0)
  })
})

describe('S27-asm: the mirror guard is installed in the running chain', () => {
  it('S27-asm-guard-listed: MODULES lists mirrorGuard once and the real install registers its two prepended listeners', () => {
    assert.equal(MODULES.filter(module => module === mirrorGuard).length, 1)
    const w = world()
    const prepended = name => w.registered.filter(entry => entry.name === name && entry.options?.prepend === true)
    assert.ok(prepended('agent/created').length >= 1, 'agent/created listener, prepended')
    assert.ok(prepended('agent/inbox/inserted').length >= 1, 'inbox net, prepended')
  })

  it('S27-asm-guard-agent: through the real createRuntime and a REAL Agent, an auto-continue style followup on the mirror Session starts no turn; an ordinary Session\'s Agent still runs', { skip: REAL_AGENT_SKIP }, async () => {
    const w = world()
    await w.mirror()
    const real = await realAgentWorld()
    try {
      // The listeners this assembly really registered for creation, in registration order, prepended ones only
      // (the others belong to unrelated modules and need a full DSH around them).
      const announce = async agent => { for (const entry of w.registered) if (entry.name === 'agent/created' && entry.options?.prepend === true) await entry.listener({ agent }) }
      const mirror = await real.create('mirror-1')
      await announce(mirror)
      mirror.followup(real.message('继续'))
      await mirror.whenIdle()
      assert.equal(real.types(mirror).includes('turn/start'), false, 'no local turn on the joined Bot\'s page')
      assert.equal(real.types(mirror).includes('agent/inbox/spliced'), false)
      assert.ok((w.rt.mirrorGuardRefused ?? 0) >= 1)

      const ordinary = await real.create('ordinary-1')
      await announce(ordinary)
      ordinary.followup(real.message('继续'))
      await ordinary.whenIdle()
      assert.ok(real.types(ordinary).includes('turn/start'), 'every other Session is left alone')
    } finally { await real.dispose() }
  })
})

describe('S27-asm-timeout: config.joinedTurnTimeoutMs reaches the running page turn', () => {
  it('S27-asm-timeout-config: the real createRuntime reads it; out-of-range values fall back to the default', () => {
    assert.equal(world({ config: { joinedTurnTimeoutMs: 45_000 } }).rt.joinedTurnTimeoutMs, 45_000)
    for (const bad of [0, 999, -5, 1.5, '600000', null, 2 ** 31, Infinity]) {
      assert.equal(world({ config: { joinedTurnTimeoutMs: bad } }).rt.joinedTurnTimeoutMs, JOINED_TURN_TIMEOUT_MS, String(bad))
    }
    assert.equal(world().rt.joinedTurnTimeoutMs, JOINED_TURN_TIMEOUT_MS)
  })

  it('S27-asm-timeout-effect: with the configured value a silent node ends the page turn with E_TIMEOUT after that long, not before', async () => {
    const w = world({ config: { joinedTurnTimeoutMs: 1000 } })
    await w.mirror()
    const started = Date.now()
    await w.prompt(textRequest('mirror-1', 'anyone?', 'req-t'))
    const session = w.sessionOf('mirror-1')
    const ended = () => session.log.some(event => event.type === 'turn/end')
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.equal(ended(), false, 'not at 600ms')
    while (!ended() && Date.now() - started < 3000) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(session.log.at(-1).data.reason.error.code, 'E_TIMEOUT')
    assert.ok(Date.now() - started >= 950, 'and not earlier than the configured second')
  })
})
