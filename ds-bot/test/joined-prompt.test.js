// Bot Home takeover (S2-4): a prompt aimed at a joined Bot's mirror Session goes to the node,
// everything else goes to the original prompt. Real install(rt) + real Session events.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import EventEmitter from 'node:events'
import { install } from '../src/host/joined-prompt.js'
import { createJoinedEnsureRoute } from '../src/host/channel.js'

const { Session } = await import('@deepseek-ai/dsh-session')

function makeWorld({ sessionId = 'mirror-1', bot: botOverrides = {}, sendResult = true, timeoutMs, botHomeEnabled } = {}) {
  const emitter = new EventEmitter()
  const frames = []
  const sessions = new Map()
  const created = []
  const bySession = new Map()
  const originalCalls = []
  let seq = 0
  const registry = {
    send: (nodeId, type, payload) => {
      if (sendResult !== true) return false
      frames.push({ nodeId, type, payload })
      return true
    },
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
  }
  const bot = {
    id: 'joined:n1:rb1', name: 'Joined', origin: 'joined', type: 'remote-worker',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true },
    ...(sessionId === null ? {} : { sessionId }),
    ...botOverrides,
  }
  const sessionOf = (sid) => { if (!sessions.has(sid)) sessions.set(sid, new Session(sid)); return sessions.get(sid) }
  if (bot.sessionId) bySession.set(bot.sessionId, bot)
  const originalResult = { accepted: true, from: 'original' }
  const disposers = []
  const rt = {
    ...(botHomeEnabled === undefined ? {} : { botHomeEnabled }),
    ctx: {
      get: key => (key === 'remote-agent:registry' ? registry : undefined),
      sessionController: { prompt: async (...args) => { originalCalls.push(args); return originalResult } },
      effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    },
    state: { revision: 1, bots: { [bot.id]: bot } },
    botOf: id => (id === bot.id ? bot : undefined),
    bySessionId: sid => bySession.get(sid),
    updateBySessionId: (botId, oldSid, newSid) => { if (oldSid) bySession.delete(oldSid); if (newSid) bySession.set(newSid, bot) },
    chatOf: botId => (botId === bot.id ? bot.sessionId ?? botId : botId),
    createSession: async () => { const sid = `mirror-new-${created.length}`; created.push(sid); sessionOf(sid); return sid },
    resolveAgent: async sid => ({ session: sessionOf(sid) }),
    load: async () => {},
    save: async () => {},
    warn: () => {},
    ...(timeoutMs === undefined ? {} : { joinedTurnTimeoutMs: timeoutMs }),
  }
  install(rt)
  const reply = (index, patch = {}) => emitter.emit('botTurnResult', { exchangeId: frames[index].payload.exchangeId, ok: true, text: 'node says hi', seq: seq++, ...patch })
  const idle = () => Promise.all([...(rt.joinedPromptTasks ?? [])])
  const prompt = (request, signal = new AbortController().signal) => rt.ctx.sessionController.prompt(request, signal)
  return { rt, bot, frames, created, originalCalls, originalResult, reply, idle, prompt, sessionOf, emitter, disposers }
}

const textRequest = (text, requestId = 'req-1', sessionId = 'mirror-1') => ({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] })
const types = session => session.log.map(event => event.type)

async function rejection(promise) {
  try { await promise } catch (error) { return error }
  assert.fail('expected the prompt to be rejected')
}

describe('S24: joined Bot page prompt takeover', () => {
  it('S24-a joined mirror prompt: original prompt never, bot/turn once, user message (with rpcId) on the page BEFORE the node answers', async () => {
    const w = makeWorld()
    const ack = await w.prompt(textRequest('hello node'))
    assert.deepEqual(ack, { accepted: true })
    assert.equal(w.originalCalls.length, 0, 'the original prompt must not run (no local model turn)')
    assert.equal(w.frames.filter(f => f.type === 'bot/turn').length, 1)
    assert.equal(w.frames[0].payload.text, 'hello node')
    // The node has not answered yet: the page already shows the user's message.
    const session = w.sessionOf('mirror-1')
    assert.deepEqual(types(session), ['turn/start', 'step/start', 'user/message'])
    const userEvent = session.log.find(event => event.type === 'user/message')
    assert.equal(userEvent.data.source.kind, 'user')
    assert.equal(userEvent.data.source.rpcId, 'req-1', 'rpcId = requestId retires the client echo')
    assert.equal(userEvent.data.content[0].text, 'hello node')
    w.reply(0)
    await w.idle()
    assert.deepEqual(types(session), ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
    const assistant = session.log.find(event => event.type === 'assistant/message')
    assert.equal(assistant.data.message.content[0].text, 'node says hi')
    assert.ok(Array.isArray(assistant.data.stream))
    assert.equal(session.log.at(-1).data.reason.kind, 'completed')
  })

  it('S24-b timeout: the page shows a visible error message and the turn closes with the error code', async () => {
    const w = makeWorld({ timeoutMs: 30 })
    await w.prompt(textRequest('anyone there?'))
    await w.idle()
    const session = w.sessionOf('mirror-1')
    assert.deepEqual(types(session), ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
    const text = session.log.find(event => event.type === 'assistant/message').data.message.content[0].text
    assert.match(text, /^⚠ 无法送达节点：/)
    assert.match(text, /E_TIMEOUT/)
    const end = session.log.at(-1).data.reason
    assert.equal(end.kind, 'error')
    assert.equal(end.error.code, 'E_TIMEOUT')
  })

  it('S24-b2 the node rejects the turn: visible error, E_REJECTED, turn closed once', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('hi'))
    w.reply(0, { ok: false, text: undefined, error: 'bot-busy-on-node' })
    await w.idle()
    const session = w.sessionOf('mirror-1')
    assert.equal(types(session).filter(t => t === 'turn/end').length, 1)
    assert.match(session.log.find(event => event.type === 'assistant/message').data.message.content[0].text, /^⚠ 无法送达节点：.*E_REJECTED/)
    assert.equal(session.log.at(-1).data.reason.error.code, 'E_REJECTED')
  })

  it('S24-b3 node offline at dispatch: the prompt is refused (structured error) and the page gets no half turn', async () => {
    const w = makeWorld({ sendResult: false })
    const error = await rejection(w.prompt(textRequest('hi')))
    assert.equal(error.isDSHRemoteError, true)
    assert.equal(error.code, 'session/agent-busy')
    assert.match(error.message, /无法送达节点/)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [], 'nothing written for a dispatch that never left')
    assert.equal(w.rt.joinedInFlight.size, 0, 'the in-flight claim is released')
  })

  it('S24-c ordinary Bot / group / unknown Session: the original prompt gets the very same arguments and its own result', async () => {
    const w = makeWorld()
    for (const sessionId of ['ordinary-bot-session', 'room-session', 'mirror-1-old-part']) {
      const request = textRequest('hello', `req-${sessionId}`, sessionId)
      const signal = new AbortController().signal
      const result = await w.prompt(request, signal)
      assert.equal(result, w.originalResult)
      const call = w.originalCalls.at(-1)
      assert.equal(call[0], request, 'same request object')
      assert.equal(call[1], signal, 'same signal')
    }
    assert.equal(w.originalCalls.length, 3)
    assert.equal(w.frames.length, 0, 'nothing goes to a node')
  })

  it('S24-c2 a joined Bot not living on a remote node, or whose current session differs, is not taken over', async () => {
    const local = makeWorld({ bot: { worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'local' } } })
    await local.prompt(textRequest('x'))
    assert.equal(local.originalCalls.length, 1)
    const stale = makeWorld()
    stale.rt.bySessionId = () => ({ ...stale.bot, sessionId: 'a-newer-mirror' })
    await stale.prompt(textRequest('x'))
    assert.equal(stale.originalCalls.length, 1)
  })

  it('S24-d attachments are refused with a structured, visible error and nothing is written or sent', async () => {
    const w = makeWorld()
    for (const part of [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }, { type: 'file', receiptId: 'r1' }]) {
      const error = await rejection(w.prompt({ requestId: 'req-a', sessionId: 'mirror-1', content: [{ type: 'text', text: 'look' }, part] }))
      assert.equal(error.isDSHRemoteError, true)
      assert.equal(error.code, 'session/attachment-invalid')
      assert.match(error.message, /不支持附件/)
      assert.equal(error.details.reason, 'JOINED_ATTACHMENT_UNSUPPORTED')
    }
    assert.equal(w.frames.length, 0)
    assert.equal(w.originalCalls.length, 0)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  })

  it('S24-e a second prompt while a turn is in flight is refused with session/agent-busy; after it ends the next one goes through', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('first', 'req-1'))
    const error = await rejection(w.prompt(textRequest('second', 'req-2')))
    assert.equal(error.isDSHRemoteError, true)
    assert.equal(error.code, 'session/agent-busy')
    assert.equal(error.details.reason, 'JOINED_TURN_IN_FLIGHT')
    assert.equal(w.frames.length, 1, 'the refused message never reaches the node')
    assert.equal(w.originalCalls.length, 0)
    w.reply(0)
    await w.idle()
    await w.prompt(textRequest('third', 'req-3'))
    assert.equal(w.frames.length, 2)
    w.reply(1)
    await w.idle()
    const session = w.sessionOf('mirror-1')
    assert.deepEqual(session.log.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2])
    assert.deepEqual(session.log.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), ['completed', 'completed'])
  })

  it('S24-f a repeated requestId is acknowledged and never sent to the node twice', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('once', 'req-dup'))
    assert.deepEqual(await w.prompt(textRequest('once', 'req-dup')), { accepted: true }, 'in flight: acknowledged, not busy')
    w.reply(0)
    await w.idle()
    assert.deepEqual(await w.prompt(textRequest('once', 'req-dup')), { accepted: true }, 'finished: acknowledged')
    assert.equal(w.frames.length, 1)
  })

  it('S24-g slash commands are plain text for the node; a missing mode is fine; the flag does not gate the takeover', async () => {
    const w = makeWorld({ botHomeEnabled: false })
    await w.prompt({ requestId: 'req-s', sessionId: 'mirror-1', content: [{ type: 'text', text: '/help me' }] })
    assert.equal(w.frames[0].payload.text, '/help me')
    assert.equal(w.originalCalls.length, 0)
    w.reply(0)
    await w.idle()
  })

  it('S24-h a Bot with no mirror session yet is not taken over (nothing to match); install restores prompt on dispose', async () => {
    const w = makeWorld({ sessionId: null })
    await w.prompt(textRequest('x', 'req-n', 'joined:n1:rb1'))
    assert.equal(w.originalCalls.length, 1)
    const wrapped = w.rt.ctx.sessionController.prompt
    w.disposers.forEach(dispose => dispose())
    assert.notEqual(w.rt.ctx.sessionController.prompt, wrapped)
  })
})

describe('S24: joined-ensure route', () => {
  it('S24-ensure creates the mirror session once for a Bot without one, and reuses it afterwards', async () => {
    const w = makeWorld({ sessionId: null })
    const route = createJoinedEnsureRoute(w.rt)
    const first = await route({ botId: w.bot.id })
    assert.equal(first.ok, true)
    assert.equal(first.value.sessionId, 'mirror-new-0')
    assert.equal(w.bot.sessionId, 'mirror-new-0')
    const second = await route({ botId: w.bot.id })
    assert.equal(second.value.sessionId, 'mirror-new-0')
    assert.equal(w.created.length, 1, 'the second call must not create another session')
    assert.equal(w.rt.bySessionId('mirror-new-0'), w.bot, 'bySessionId finds the Bot so the takeover matches')
  })

  it('S24-ensure-refuses a non-joined Bot and reports a creation failure', async () => {
    const w = makeWorld({ sessionId: null })
    const refused = await createJoinedEnsureRoute(w.rt)({ botId: 'no-such-bot' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'bot/refused')
    w.rt.createSession = async () => { throw new Error('disk full') }
    const failed = await createJoinedEnsureRoute(w.rt)({ botId: w.bot.id })
    assert.equal(failed.ok, false)
    assert.match(failed.error.message, /disk full/)
  })
})
