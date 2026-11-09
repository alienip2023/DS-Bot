// Bot Home takeover (S2-4): a prompt aimed at a joined Bot's mirror Session goes to the node,
// everything else goes to the original prompt. Real install(rt) + real Session events.
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import EventEmitter from 'node:events'
import { install } from '../src/host/joined-prompt.js'
import { mirrorTurnStart, mirrorTurnFinish, mirrorTurnFail, mirrorLateReply, importHistory, LATE_REPLY_MARK, STOPPED_TEXT, mirrorStateOf } from '../src/host/mirror.js'
import { stopPageTurn } from '../src/host/executor.js'
import { createTurnTracker } from '../src/host/turn-tracker.js'
import { JOINED_TURN_TIMEOUT_MS } from '../src/host/joined-turn.js'
import { createJoinedEnsureRoute } from '../src/host/channel.js'

const { Session } = await import('@deepseek-ai/dsh-session')

function makeWorld({ sessionId = 'mirror-1', bot: botOverrides = {}, sendResult = true, sendThrows = false, noRegistry = false, failAppendOn, timeoutMs, botHomeEnabled, tracker = false } = {}) {
  const emitter = new EventEmitter()
  const frames = []
  const sessions = new Map()
  const created = []
  const bySession = new Map()
  const originalCalls = []
  const cancelCalls = []
  const warnings = []
  let seq = 0
  const registry = {
    send: (nodeId, type, payload) => {
      if (sendThrows) throw new Error('socket closed')
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
  const sessionOf = (sid) => {
    if (!sessions.has(sid)) {
      const created = new Session(sid)
      if (failAppendOn !== undefined) {
        const append = created.append.bind(created)
        created.append = (type, ...rest) => { if (type === failAppendOn) throw new Error('disk full'); return append(type, ...rest) }
      }
      sessions.set(sid, created)
    }
    return sessions.get(sid)
  }
  if (bot.sessionId) bySession.set(bot.sessionId, bot)
  const originalResult = { accepted: true, from: 'original' }
  const disposers = []
  const rt = {
    ...(botHomeEnabled === undefined ? {} : { botHomeEnabled }),
    ctx: {
      get: key => (key === 'remote-agent:registry' && !noRegistry ? registry : undefined),
      sessionController: {
        prompt: async (...args) => { originalCalls.push(args); return originalResult },
        // the core's cancel throws session/not-found for a Session with no live Agent (a mirror Session)
        cancel: async (...args) => { cancelCalls.push(args); return { accepted: true, from: 'original-cancel' } },
      },
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
    warn: (...args) => { warnings.push(args) },
    ...(tracker ? { turnTracker: createTurnTracker() } : {}),
    ...(timeoutMs === undefined ? {} : { joinedTurnTimeoutMs: timeoutMs }),
  }
  install(rt)
  const reply = (index, patch = {}) => emitter.emit('botTurnResult', { exchangeId: frames[index].payload.exchangeId, ok: true, text: 'node says hi', seq: seq++, ...patch })
  const idle = () => Promise.all([...(rt.joinedPromptTasks ?? [])])
  const prompt = (request, signal = new AbortController().signal) => rt.ctx.sessionController.prompt(request, signal)
  const cancel = (sessionId = 'mirror-1') => rt.ctx.sessionController.cancel({ sessionId })
  return { rt, bot, frames, created, originalCalls, originalResult, cancelCalls, warnings, reply, idle, prompt, cancel, sessionOf, emitter, disposers }
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

  it('S24-b3 no registry at all (nothing can be sent): the prompt is refused with a structured non-busy error and the page gets no half turn', async () => {
    const w = makeWorld({ noRegistry: true })
    const error = await rejection(w.prompt(textRequest('hi')))
    assert.equal(error.isDSHRemoteError, true)
    // An unreachable node is not "the agent is busy": the toast's trailing code must say so.
    assert.notEqual(error.code, 'session/agent-busy')
    assert.equal(error.code, 'session/agent-unavailable')
    assert.equal(error.details.reason, 'JOINED_NODE_E_OFFLINE')
    assert.match(error.message, /无法送达节点/)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [], 'nothing written for a dispatch that never left')
    assert.equal(w.rt.joinedInFlight.size, 0, 'the in-flight claim is released')
  })

  it('S24-b4 the node does not take the frame (offline): the user message is on the page, then a visible E_OFFLINE failure; the prompt itself was accepted', async () => {
    for (const world of [{ sendResult: false }, { sendThrows: true }]) {
      const w = makeWorld(world)
      assert.deepEqual(await w.prompt(textRequest('hi')), { accepted: true })
      await w.idle()
      const session = w.sessionOf('mirror-1')
      assert.deepEqual(types(session), ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
      assert.match(session.log.find(event => event.type === 'assistant/message').data.message.content[0].text, /^⚠ 无法送达节点：.*E_OFFLINE/)
      assert.equal(session.log.at(-1).data.reason.error.code, 'E_OFFLINE')
      assert.equal(w.frames.length, 0)
      assert.equal(w.rt.joinedInFlight.size, 0, 'the in-flight claim is released')
      assert.equal(w.emitter.listenerCount('botTurnResult'), 0, 'the result listener is dropped')
      // and the Bot is usable again
      assert.deepEqual(await w.prompt(textRequest('again', 'req-2')), { accepted: true })
      await w.idle()
    }
  })

  it('S24-b5 a node result after the timeout is not dropped: the page turn stays ended with E_TIMEOUT and the reply is written as a new turn (S27-late has the details)', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow?'))
    await w.idle()
    const session = w.sessionOf('mirror-1')
    assert.equal(session.log.at(-1).data.reason.error.code, 'E_TIMEOUT')
    const before = session.log.length
    w.reply(0)
    assert.ok(session.log.length > before, 'the late answer is written')
    assert.equal(types(session).filter(t => t === 'turn/end').length, 2, 'one per turn')
  })

  it('S24-b6 the page turn cannot be written: nothing is sent to the node, the prompt is refused with a code, the claim and listener are released', async () => {
    const w = makeWorld({ failAppendOn: 'user/message' })
    const error = await rejection(w.prompt(textRequest('hello')))
    assert.equal(error.isDSHRemoteError, true)
    assert.equal(error.code, 'session/agent-unavailable')
    assert.equal(error.details.reason, 'JOINED_NODE_E_MIRROR_WRITE')
    assert.match(error.message, /无法送达节点/)
    assert.equal(w.frames.length, 0, 'a message the page does not show must not reach the node')
    assert.equal(w.rt.joinedInFlight.size, 0)
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
    assert.equal(types(w.sessionOf('mirror-1')).filter(t => t === 'turn/end').length, 1, 'the half-written turn is closed')
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
      // The composer sends session/attachment-invalid through attachmentErrorText(), which
      // would print "image send failed (JOINED_ATTACHMENT_UNSUPPORTED)"; our own code gets the
      // generic toast. composerToast mirrors dsh-client-ui-conversation lib/client.js:21754.
      assert.notEqual(error.code, 'session/attachment-invalid')
      assert.notEqual(error.code, 'subagent/attachment-invalid')
      assert.equal(error.code, 'session/joined-attachment-unsupported')
      assert.equal(error.message, '副机 Bot 暂不支持附件，请改为文字发送')
      assert.equal(error.details.reason, 'JOINED_ATTACHMENT_UNSUPPORTED')
      const composerToast = e => (e.code === 'session/attachment-invalid' || e.code === 'subagent/attachment-invalid' ? `image send failed: ${e.details.reason}` : `${e.message} (${e.code})`)
      assert.equal(composerToast(error), '副机 Bot 暂不支持附件，请改为文字发送 (session/joined-attachment-unsupported)')
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

  it('S24-e2 mode:steer while a turn is in flight is refused the same way (no second frame)', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('first', 'req-1'))
    const error = await rejection(w.prompt({ ...textRequest('steer it', 'req-2'), mode: 'steer' }))
    assert.equal(error.code, 'session/agent-busy')
    assert.equal(error.details.reason, 'JOINED_TURN_IN_FLIGHT')
    assert.equal(w.frames.length, 1)
    assert.equal(w.originalCalls.length, 0)
    w.reply(0)
    await w.idle()
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

describe('S24: one turn/end per Start (closedTurns)', () => {
  it('S24-closed Finish, Fail, Finish on the same turn leave exactly one turn/end and one answer', () => {
    const session = new Session('closed-1')
    const closedTurns = new Set()
    mirrorTurnStart(session, { turn: 1, userText: 'q', rpcId: 'r1' })
    const first = mirrorTurnFinish(session, { turn: 1, botText: 'a1', closedTurns })
    const fail = mirrorTurnFail(session, { turn: 1, code: 'E_TIMEOUT', message: 'late', closedTurns })
    const second = mirrorTurnFinish(session, { turn: 1, botText: 'a2', closedTurns })
    assert.equal(first.skipped, false)
    assert.equal(fail.skipped, true)
    assert.equal(second.skipped, true)
    assert.equal(types(session).filter(t => t === 'turn/end').length, 1)
    assert.equal(types(session).filter(t => t === 'assistant/message').length, 1)
    assert.equal(session.log.find(event => event.type === 'assistant/message').data.message.content[0].text, 'a1')
  })

  it('S24-closed Fail then Finish: the failure stays the only ending', () => {
    const session = new Session('closed-2')
    const closedTurns = new Set()
    mirrorTurnStart(session, { turn: 1, userText: 'q', rpcId: 'r1' })
    mirrorTurnFail(session, { turn: 1, code: 'E_TIMEOUT', message: 'timeout', closedTurns })
    mirrorTurnFinish(session, { turn: 1, botText: 'late', closedTurns })
    assert.equal(types(session).filter(t => t === 'turn/end').length, 1)
    assert.equal(session.log.at(-1).data.reason.error.code, 'E_TIMEOUT')
    assert.equal(types(session).filter(t => t === 'assistant/message').length, 1)
  })
})

const turnsOf = session => session.log.filter(event => event.type === 'turn/start').map(event => event.data.turn)
const assistantTexts = session => session.log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('S27-late: the node answers after the page turn timed out', () => {
  it('S27-late-a: the answer becomes a NEW turn — allocateTurn number, no user message, marked, stream:[], one turn/end', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow tool run'))
    await w.idle()
    const session = w.sessionOf('mirror-1')
    const afterTimeout = session.log.length
    w.reply(0, { text: 'finally done', seq: 7 })
    const late = session.log.slice(afterTimeout)
    assert.deepEqual(late.map(event => event.type), ['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
    assert.equal(late[0].data.turn, 2, 'numbered from the log, after the closed turn 1')
    assert.equal(late.some(event => event.type === 'user/message'), false, 'the original user message is not repeated')
    const text = late[2].data.message.content[0].text
    assert.ok(text.startsWith(LATE_REPLY_MARK), text)
    assert.ok(text.includes('finally done'))
    assert.deepEqual(late[2].data.stream, [])
    assert.equal(late.at(-1).data.reason.kind, 'completed')
    assert.deepEqual(turnsOf(session), [1, 2])
  })

  it('S27-late-b: a repeated delivery writes nothing (one-shot listener) and a seq the history import already wrote writes nothing (idempotent)', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow'))
    await w.idle()
    const session = w.sessionOf('mirror-1')
    w.reply(0, { seq: 3 })
    const written = session.log.length
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0, 'the listener ended with the first delivery')
    w.reply(0, { seq: 3 })
    assert.equal(session.log.length, written, 'second delivery: nothing')

    // (bot, nodeSeq) already known: the same node turn written by the S2-3 import is not written again
    const w2 = makeWorld({ timeoutMs: 20 })
    await w2.prompt(textRequest('slow'))
    await w2.idle()
    mirrorStateOf(w2.rt, w2.bot.id).seenKeys.add(`${w2.bot.id}:9`)
    const before = w2.sessionOf('mirror-1').log.length
    w2.reply(0, { seq: 9 })
    assert.equal(w2.sessionOf('mirror-1').log.length, before, 'imported already: skipped')
  })

  it('S27-late-c: while the Bot has a newer page turn open, the late reply waits — that turn is not closed under it — and is written after it', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('first (slow)', 'req-1'))
    await w.idle()
    w.rt.joinedTurnTimeoutMs = 5000
    await w.prompt(textRequest('second', 'req-2'))
    const session = w.sessionOf('mirror-1')
    assert.deepEqual(turnsOf(session), [1, 2])
    const open = session.log.length
    w.reply(0, { text: 'answer to first', seq: 1 })
    assert.equal(session.log.length, open, 'nothing written while turn 2 is open')
    w.reply(1, { text: 'answer to second', seq: 2 })
    await w.idle()
    const ends = session.log.filter(event => event.type === 'turn/end').map(event => [event.data.turn, event.data.reason.kind])
    assert.deepEqual(ends, [[1, 'error'], [2, 'completed'], [3, 'completed']], 'turn 2 completed (never aborted), the late reply is turn 3')
    assert.ok(assistantTexts(session).at(-1).startsWith(LATE_REPLY_MARK))
    assert.ok(assistantTexts(session).at(-1).includes('answer to first'))
  })

  it('S27-late-d: a late result that is a rejection or has no usable seq writes nothing', async () => {
    for (const patch of [{ ok: false, error: 'node-error' }, { seq: undefined }, { seq: -1 }]) {
      const w = makeWorld({ timeoutMs: 20 })
      await w.prompt(textRequest('slow'))
      await w.idle()
      const before = w.sessionOf('mirror-1').log.length
      w.reply(0, patch)
      assert.equal(w.sessionOf('mirror-1').log.length, before, JSON.stringify(patch))
    }
  })

  it('S27-late-e: the window is bounded — after it the listener is gone and a later result writes nothing', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    w.rt.joinedLateWindowMs = 40
    await w.prompt(textRequest('slow'))
    await w.idle()
    assert.equal(w.emitter.listenerCount('botTurnResult'), 1, 'listening during the window')
    await wait(120)
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0, 'window over')
    const before = w.sessionOf('mirror-1').log.length
    w.reply(0)
    assert.equal(w.sessionOf('mirror-1').log.length, before)
  })

  it('S27-late-f: unloading the plugin ends the late listeners', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow'))
    await w.idle()
    assert.equal(w.emitter.listenerCount('botTurnResult'), 1)
    for (const dispose of w.disposers) dispose()
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
  })

  it('S27-late-g: only a timeout waits for a late reply — an offline node (send refused) leaves no listener', async () => {
    const w = makeWorld({ sendResult: false })
    await w.prompt(textRequest('hi')).catch(() => {})
    await w.idle()
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
  })

  it('S27-late-h: the page says a reply will follow (the timeout line promises it)', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow'))
    await w.idle()
    assert.match(assistantTexts(w.sessionOf('mirror-1'))[0], /回复会补到这里/)
  })
})

describe('S27-timeout: the wait is long enough for a tool turn and configurable', () => {
  it('S27-timeout-a: by default the page turn is still open one millisecond before JOINED_TURN_TIMEOUT_MS and times out at it', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const w = makeWorld()
      await w.prompt(textRequest('a long tool run'))
      const session = w.sessionOf('mirror-1')
      mock.timers.tick(JOINED_TURN_TIMEOUT_MS - 1)
      await Promise.resolve()
      assert.equal(types(session).includes('turn/end'), false, 'still waiting')
      mock.timers.tick(1)
      await w.idle()
      assert.equal(session.log.at(-1).data.reason.error.code, 'E_TIMEOUT')
      assert.ok(JOINED_TURN_TIMEOUT_MS >= 600_000, 'covers a tool turn of several minutes')
    } finally { mock.timers.reset() }
  })
})

// ── fork.69 ─────────────────────────────────────────────────────────────────────────────────
const lateTurns = session => session.log.filter(event => event.type === 'turn/end').map(event => [event.data.turn, event.data.reason.kind])

describe('S30-late: a late listener only follows a timeout', () => {
  it('S30-late-a: a node rejection, a result without seq and a node that went offline end the turn with their own code and leave NO listener — a later result for the exchange writes nothing', async () => {
    for (const [name, trigger, code] of [
      ['rejected', w => w.reply(0, { ok: false, text: undefined, error: 'bot-busy-on-node' }), 'E_REJECTED'],
      ['no-seq', w => w.reply(0, { seq: undefined }), 'E_REJECTED'],
      ['bridge-down', w => w.emitter.emit('nodeOffline', { nodeId: 'n1' }), 'E_OFFLINE'],
    ]) {
      const w = makeWorld()
      await w.prompt(textRequest('hi'))
      trigger(w)
      await w.idle()
      const session = w.sessionOf('mirror-1')
      assert.equal(session.log.at(-1).data.reason.error.code, code, name)
      assert.equal(w.emitter.listenerCount('botTurnResult'), 0, `${name}: nobody waits for a late reply`)
      const before = session.log.length
      w.reply(0, { text: 'too late', seq: 11 })
      assert.equal(session.log.length, before, `${name}: a result after a non-timeout failure writes nothing`)
    }
  })

  it('S30-late-a2: the same turn that DOES time out keeps one listener (the contrast the test above relies on)', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow'))
    await w.idle()
    assert.equal(w.emitter.listenerCount('botTurnResult'), 1)
  })
})

describe('S30-seen: a late write is remembered by (bot, nodeSeq)', () => {
  const lateBy = async (seq) => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow'))
    await w.idle()
    w.reply(0, { text: 'finally', seq })
    return w
  }

  it('S30-seen-a: after the late write the Bot\'s state holds the key in seenKeys AND closedKeys', async () => {
    const w = await lateBy(7)
    const state = mirrorStateOf(w.rt, w.bot.id)
    assert.equal(state.seenKeys.has(`${w.bot.id}:7`), true)
    assert.equal(state.closedKeys.has(`${w.bot.id}:7`), true)
  })

  it('S30-seen-b: a writer that only has seenKeys (the older deliverTurn path) writes the node turn once — the second delivery is skipped', () => {
    const session = new Session('s')
    const seenKeys = new Set()
    const first = mirrorLateReply(session, { botText: 'a', botId: 'b1', nodeSeq: 4, seenKeys })
    const written = session.log.length
    const second = mirrorLateReply(session, { botText: 'a', botId: 'b1', nodeSeq: 4, seenKeys })
    assert.equal(first.skipped, false)
    assert.deepEqual(second, { skipped: true, reason: 'already-written:nodeSeq' })
    assert.equal(session.log.length, written)
    assert.equal(seenKeys.has('b1:4'), true)
  })

  it('S30-seen-c: the history import does not write that node turn again — through seenKeys alone and through closedKeys alone', async () => {
    const w = await lateBy(7)
    const state = mirrorStateOf(w.rt, w.bot.id)
    const session = w.sessionOf('mirror-1')
    const item = { userText: 'slow', botText: 'finally', turn: 1, seq: 7 }
    const before = session.log.length
    const bySeen = await importHistory(session, [item], { seenKeys: state.seenKeys, botId: w.bot.id, gapMode: 'none' })
    assert.deepEqual([bySeen.imported, bySeen.skipped], [0, 1], 'seenKeys alone')
    const byClosed = await importHistory(session, [item], { seenKeys: new Set(), closedKeys: state.closedKeys, botId: w.bot.id, gapMode: 'none' })
    assert.deepEqual([byClosed.imported, byClosed.skipped], [0, 1], 'closedKeys alone')
    assert.equal(session.log.length, before)
  })

  it('S30-seen-d: and the other way round — a seq the import wrote first is not written again as a late reply (seen via the real state)', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow'))
    await w.idle()
    const state = mirrorStateOf(w.rt, w.bot.id)
    const session = w.sessionOf('mirror-1')
    await importHistory(session, [{ userText: 'u', botText: 'b', turn: 9, seq: 5 }], { ...state, botId: w.bot.id, gapMode: 'none' })
    const before = session.log.length
    w.reply(0, { text: 'dup', seq: 5 })
    assert.equal(session.log.length, before)
  })
})

describe('S30-unload: unloading the plugin ends everything late', () => {
  it('S30-unload-a: a late reply waiting for an open page turn is dropped on unload — the turn ends afterwards and nothing late is written', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('first (slow)', 'req-1'))
    await w.idle()
    w.rt.joinedTurnTimeoutMs = 5000
    await w.prompt(textRequest('second', 'req-2'))
    w.reply(0, { text: 'answer to first', seq: 1 })
    assert.equal(w.rt.joinedLateQueue.get(w.bot.id).length, 1, 'queued behind the open turn')
    for (const dispose of w.disposers) dispose()
    w.reply(1, { text: 'answer to second', seq: 2 })
    await w.idle()
    const session = w.sessionOf('mirror-1')
    assert.equal(assistantTexts(session).some(text => text.includes('answer to first')), false)
    assert.equal(assistantTexts(session).some(text => text.startsWith(LATE_REPLY_MARK)), false)
    assert.deepEqual(lateTurns(session), [[1, 'error'], [2, 'completed']])
  })

  it('S30-unload-b: after unload a page turn that times out arms no new late listener', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow'))
    for (const dispose of w.disposers) dispose()
    await w.idle()
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
    const before = w.sessionOf('mirror-1').log.length
    w.reply(0, { seq: 3 })
    assert.equal(w.sessionOf('mirror-1').log.length, before)
  })
})

describe('S30-stop: the page\'s Stop ends the wait and frees the Bot', () => {
  it('S30-stop-a: Stop on an open page turn — the core cancel is not called, the page shows one "已停止等待节点" line and the turn ends aborted, once', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('slow tool run'))
    const ack = await w.cancel()
    assert.deepEqual(ack, { accepted: true })
    assert.equal(w.cancelCalls.length, 0, 'the core cancel would throw session/not-found on a mirror Session')
    const session = w.sessionOf('mirror-1')
    assert.deepEqual(types(session), ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
    assert.ok(assistantTexts(session)[0].includes(STOPPED_TEXT), assistantTexts(session)[0])
    assert.equal(session.log.at(-1).data.reason.kind, 'aborted')
    assert.deepEqual(session.log.find(event => event.type === 'assistant/message').data.stream, [])
    await w.idle()
    assert.equal(types(session).filter(type => type === 'turn/end').length, 1, 'still one turn/end after the wait settled')
    assert.equal(w.warnings.length, 0, 'a stop is not a failure')
  })

  it('S30-stop-b: the slot is free at once — the next message goes out (no agent-busy), as turn 2 on the page', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('stuck', 'req-1'))
    await w.cancel()
    const ack = await w.prompt(textRequest('again', 'req-2'))
    assert.deepEqual(ack, { accepted: true })
    assert.equal(w.frames.filter(f => f.type === 'bot/turn').length, 2)
    assert.equal(w.frames[1].payload.text, 'again')
    assert.deepEqual(turnsOf(w.sessionOf('mirror-1')), [1, 2])
  })

  it('S30-stop-b2: released synchronously — stopPageTurn frees the in-flight table before it returns', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('stuck'))
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
    assert.equal(stopPageTurn(w.rt, w.bot.id), true)
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), false)
    assert.equal(stopPageTurn(w.rt, w.bot.id), false, 'nothing left to stop')
  })

  it('S30-stop-c: the node answers after the Stop — written as a late reply (new turn, marked, no user message); with a newer turn open it waits for it', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('stuck', 'req-1'))
    await w.cancel()
    const session = w.sessionOf('mirror-1')
    const stopped = session.log.length
    w.reply(0, { text: 'finally done', seq: 4 })
    const late = session.log.slice(stopped)
    assert.deepEqual(late.map(event => event.type), ['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
    assert.ok(late[2].data.message.content[0].text.startsWith(LATE_REPLY_MARK))
    assert.ok(late[2].data.message.content[0].text.includes('finally done'))
    assert.equal(late.some(event => event.type === 'user/message'), false)

    const w2 = makeWorld()
    await w2.prompt(textRequest('stuck', 'req-1'))
    await w2.cancel()
    await w2.prompt(textRequest('second', 'req-2'))
    const s2 = w2.sessionOf('mirror-1')
    const open = s2.log.length
    w2.reply(0, { text: 'answer to stopped', seq: 1 })
    assert.equal(s2.log.length, open, 'turn 2 is open: not closed under it')
    w2.reply(1, { text: 'answer to second', seq: 2 })
    await w2.idle()
    assert.deepEqual(lateTurns(s2), [[1, 'aborted'], [2, 'completed'], [3, 'completed']])
    assert.ok(assistantTexts(s2).at(-1).includes('answer to stopped'))
  })

  it('S30-stop-d: Stop with nothing in flight (never sent, already finished, pressed twice) is acknowledged and writes nothing', async () => {
    const w = makeWorld()
    assert.deepEqual(await w.cancel(), { accepted: true })
    await w.prompt(textRequest('hi'))
    w.reply(0)
    await w.idle()
    const done = w.sessionOf('mirror-1').log.length
    assert.deepEqual(await w.cancel(), { accepted: true })
    assert.equal(w.sessionOf('mirror-1').log.length, done, 'a finished turn is not touched')
    await w.prompt(textRequest('again', 'req-2'))
    await w.cancel()
    const stopped = w.sessionOf('mirror-1').log.length
    await w.cancel()
    assert.equal(w.sessionOf('mirror-1').log.length, stopped, 'the second Stop adds nothing')
    assert.equal(w.cancelCalls.length, 0)
  })

  it('S30-stop-e: any other Session\'s cancel goes to the original cancel untouched', async () => {
    const w = makeWorld()
    const request = { sessionId: 'ordinary-session' }
    const result = await w.rt.ctx.sessionController.cancel(request)
    assert.equal(result.from, 'original-cancel')
    assert.equal(w.cancelCalls.length, 1)
    assert.equal(w.cancelCalls[0][0], request)
  })

  it('S30-stop-f: the stopped wait leaves exactly one listener (the late one), no timeout line later, and the tracker says stopped — not offline', async () => {
    const w = makeWorld({ timeoutMs: 30, tracker: true })
    await w.prompt(textRequest('stuck'))
    await w.cancel()
    assert.equal(w.emitter.listenerCount('botTurnResult'), 1, 'only the late listener')
    await wait(90)
    await w.idle()
    const session = w.sessionOf('mirror-1')
    assert.equal(assistantTexts(session).some(text => text.includes('E_TIMEOUT')), false, 'the 30ms timer is gone')
    assert.equal(types(session).filter(type => type === 'turn/end').length, 1)
    assert.equal(w.warnings.length, 0)
    assert.equal(w.rt.turnTracker.get(w.frames[0].payload.exchangeId).error, 'E_ABORTED')
  })

  it('S30-stop-g: the late listener of a stopped turn ends with the plugin', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('stuck'))
    await w.cancel()
    assert.equal(w.emitter.listenerCount('botTurnResult'), 1)
    for (const dispose of w.disposers) dispose()
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
  })
})
