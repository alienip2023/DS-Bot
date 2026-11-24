// Bot Home takeover (S2-4): a prompt aimed at a joined Bot's mirror Session goes to the node,
// everything else goes to the original prompt. Real install(rt) + real Session events.
// The page is a copy of the node Bot's chat (W4, conv-replica.js): the takeover only controls what is sent.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeWorld as makeBaseWorld, textRequest, types } from './joined-world.js'
import { mirrorTurnStart, mirrorTurnFinish, mirrorTurnFail, mirrorLateReply } from '../src/host/mirror.js'
import { stopPageTurn } from '../src/host/executor.js'
import { createJoinedEnsureRoute } from '../src/host/channel.js'
import { AC_NEEDED } from '../src/host/node-compat.js'

const { Session } = await import('@deepseek-ai/dsh-session')

// The composer waits REFUSAL_WAIT_MS for an immediate node refusal; these worlds keep that window short
// (a test that answers inside the window sets it longer itself).
const makeWorld = (options) => {
  const w = makeBaseWorld(options)
  w.rt.joinedRefusalWaitMs = 5
  return w
}

async function rejection(promise) {
  try { await promise } catch (error) { return error }
  assert.fail('expected the prompt to be rejected')
}

const ticks = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)) }
const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const turnFrames = w => w.frames.filter(frame => frame.type === 'bot/turn')

describe('S24: joined Bot page prompt takeover', () => {
  it('S24-a joined mirror prompt: original prompt never, bot/turn once, the hub turn id maps back to the requestId, nothing written on the page', async () => {
    const w = makeWorld()
    const ack = await w.prompt(textRequest('hello node'))
    assert.deepEqual(ack, { accepted: true })
    assert.equal(w.originalCalls.length, 0, 'the original prompt must not run (no local model turn)')
    assert.equal(w.frames.filter(f => f.type === 'bot/turn').length, 1)
    assert.equal(w.frames[0].payload.text, 'hello node')
    // The page is a copy of the node Bot's chat (W4): nothing is written here. The copy maps the node's message
    // back to the composer's requestId through this table (conv-replica.js).
    assert.equal(w.rt.joinedRequestOf(w.frames[0].payload.exchangeId), 'req-1', 'rpcId = requestId retires the client echo')
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), true, 'the page message is in flight')
    const session = w.sessionOf('mirror-1')
    assert.deepEqual(types(session), [])
    w.reply(0)
    await w.idle()
    assert.equal(w.rt.joinedInFlight.size, 0, 'the answer frees the slot')
    assert.deepEqual(types(session), [], 'the hub writes no answer either')
    assert.equal(w.warnings.length, 0)
  })

  it('S24-b timeout: past the soft deadline the message stays in flight, without an error or a page line', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('anyone there?'))
    await wait(30)
    // The page is a copy of the node Bot's chat (W4): no progress line; the hub keeps waiting.
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), true, 'no clock ends a page message')
    assert.equal(w.emitter.listenerCount('botTurnResult'), 1, 'still listening for the answer')
    assert.equal(w.warnings.length, 0)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
    await w.cancel()
    await w.idle()
    assert.equal(w.rt.joinedInFlight.size, 0)
  })

  it('S24-b2 the node rejects the turn: an immediate refusal is the composer\'s error (E_REJECTED); a later one only frees the slot', async () => {
    const w = makeWorld()
    w.rt.joinedRefusalWaitMs = 1000
    const pending = w.prompt(textRequest('hi'))
    await until(() => w.frames.length === 1)
    w.reply(0, { ok: false, text: undefined, error: 'bot-busy-on-node' })
    // What the node refused at once is the composer's error (W4): nothing is written on the page.
    const error = await rejection(pending)
    assert.equal(error.isDSHRemoteError, true)
    assert.equal(error.code, 'session/agent-unavailable')
    assert.equal(error.details.reason, 'JOINED_NODE_E_REJECTED')
    assert.match(error.message, /^无法送达节点：.*E_REJECTED/)
    await w.idle()
    assert.equal(w.rt.joinedInFlight.size, 0)
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])

    // After the window the prompt was already accepted: the refusal frees the slot and is logged.
    const late = makeWorld()
    assert.deepEqual(await late.prompt(textRequest('hi')), { accepted: true })
    late.reply(0, { ok: false, text: undefined, error: 'bot-busy-on-node' })
    await late.idle()
    assert.equal(late.rt.joinedInFlight.size, 0)
    assert.equal(late.warnings.length, 1)
    assert.deepEqual(types(late.sessionOf('mirror-1')), [])
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

  it('S24-b4 the node does not take the frame (offline): the prompt is refused with E_OFFLINE, nothing is written, the Bot is free again', async () => {
    for (const world of [{ sendResult: false }, { sendThrows: true }]) {
      const w = makeWorld(world)
      // A send failure is the composer's error (W4): the page is a copy of the node Bot's chat and gets nothing.
      const error = await rejection(w.prompt(textRequest('hi')))
      assert.equal(error.isDSHRemoteError, true)
      assert.equal(error.code, 'session/agent-unavailable')
      assert.equal(error.details.reason, 'JOINED_NODE_E_OFFLINE')
      assert.match(error.message, /^无法送达节点：.*E_OFFLINE/)
      await w.idle()
      assert.deepEqual(types(w.sessionOf('mirror-1')), [])
      assert.equal(w.frames.length, 0)
      assert.equal(w.rt.joinedInFlight.size, 0, 'the in-flight claim is released')
      assert.equal(w.emitter.listenerCount('botTurnResult'), 0, 'the result listener is dropped')
      // and the Bot is usable again: the next message is tried at once (not held as busy)
      const again = await rejection(w.prompt(textRequest('again', 'req-2')))
      assert.equal(again.details.reason, 'JOINED_NODE_E_OFFLINE')
      assert.equal(w.rt.joinedUserQueue?.get(w.bot.id)?.length ?? 0, 0)
      await w.idle()
    }
  })

  it('S24-b5 a result after the soft timeout finishes the original message and frees the slot', async () => {
    const w = makeWorld({ timeoutMs: 20, tracker: true })
    await w.prompt(textRequest('slow?'))
    await wait(30)
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
    w.reply(0)
    await w.idle()
    // The page is a copy of the node Bot's chat (W4): the control state says it finished, the page gets nothing.
    assert.equal(w.rt.joinedInFlight.size, 0)
    assert.equal(w.rt.turnTracker.get(w.frames[0].payload.exchangeId).status, 'done')
    assert.equal(w.warnings.length, 0)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
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

  it('S24-d what cannot go to the node is refused with a structured, visible error and nothing is written or sent', async () => {
    const w = makeWorld()
    // A node whose AC has no bot-attach/1 cannot take an image; a part that is neither text, image nor file, or a file
    // the hub cannot read, is refused for what it is.
    const cases = [
      [{ type: 'audio', url: 'x' }, '节点 Bot 只能收文字、图片和文件'],
      // no `fileUploads` service in this world: said as such, not as a receipt that went stale
      [{ type: 'file', receiptId: 'r1' }, '主控的文件上传服务暂时不可用，请稍后重新发送'],
      [{ type: 'file', name: 'x' }, '这台主控读不了已上传的文件'],
    ]
    for (const [part, message] of cases) {
      const error = await rejection(w.prompt({ requestId: 'req-a', sessionId: 'mirror-1', content: [{ type: 'text', text: 'look' }, part] }))
      assert.equal(error.isDSHRemoteError, true)
      // The composer sends session/attachment-invalid through attachmentErrorText(), which would print
      // "image send failed (JOINED_ATTACHMENT_UNSUPPORTED)"; our own code gets the generic toast.
      assert.notEqual(error.code, 'session/attachment-invalid')
      assert.notEqual(error.code, 'subagent/attachment-invalid')
      assert.equal(error.code, 'session/joined-attachment-unsupported')
      assert.equal(error.message, message)
      assert.equal(error.details.reason, 'JOINED_ATTACHMENT_UNSUPPORTED')
    }
    w.rt.ctx.get = name => (name === 'remote-agent:registry' ? { send: () => true, on() {}, off() {}, getNode: () => ({ hello: { caps: ['bot-turn-mode/1'] } }) } : undefined)
    const old = await rejection(w.prompt({ requestId: 'req-b', sessionId: 'mirror-1', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] }))
    assert.equal(old.code, 'session/joined-attachment-unsupported')
    // The AC release a node needs for attachments (node-compat.js AC_NEEDED).
    assert.ok(old.message.includes(`AC ${AC_NEEDED}`), old.message)
    assert.equal(w.frames.length, 0)
    assert.equal(w.originalCalls.length, 0)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  })

  const steerRequest = (text, requestId) => ({ ...textRequest(text, requestId), mode: 'steer' })

  it('S24-e a queued prompt while a turn is in flight waits on the hub and runs after the first turn ends', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('first', 'req-1'))
    const ack = await w.prompt(textRequest('second', 'req-2'))
    assert.deepEqual(ack, { accepted: true }, 'accepted at once: the user is never blocked')
    assert.equal(w.frames.length, 1, 'queue means wait: the message is not sent while the first turn runs')
    assert.deepEqual(w.rt.joinedUserQueue.get(w.bot.id), [{ text: 'second', requestId: 'req-2' }])
    assert.equal(w.originalCalls.length, 0)
    w.reply(0)
    await w.idle()
    assert.equal(w.frames.length, 2, 'the queued message goes to the node once the first turn ends')
    assert.equal(w.frames[1].payload.text, 'second')
    assert.equal(w.frames[1].payload.mode, undefined, 'a plain turn carries no mode')
    assert.equal(w.rt.joinedInFlight.get(w.bot.id).requestId, 'req-2', 'the queued message holds the slot now')
    assert.equal(w.rt.joinedUserQueue.has(w.bot.id), false)
    w.reply(1)
    await w.idle()
    // The page is a copy of the node Bot's chat (W4): nothing is written here.
    assert.equal(w.rt.joinedInFlight.size, 0)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  })

  it('S24-e2 a steer while a turn is in flight goes to the node at once as a bot/turn with mode steer; its slot frees when the node answers it', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('first', 'req-1'))
    const ack = await w.prompt(steerRequest('second', 'req-2'))
    assert.deepEqual(ack, { accepted: true })
    assert.equal(w.frames.filter(f => f.type === 'bot/steer').length, 0, 'no separate steer frame: the node takes it as a turn')
    assert.equal(w.frames.length, 2, 'the steer is not held back')
    assert.equal(w.frames[1].payload.text, 'second')
    assert.equal(w.frames[1].payload.mode, 'steer')
    assert.equal(w.originalCalls.length, 0)
    assert.equal(w.rt.joinedUserQueue?.get(w.bot.id)?.length ?? 0, 0, 'nothing waits on the hub')
    assert.equal(w.rt.joinedSide.get(w.bot.id).size, 1, 'the steer runs next to the page message')
    w.reply(1)   // the steer answers first
    await ticks()
    assert.equal(w.rt.joinedSide?.size ?? 0, 0, 'no side turn is left')
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), true, 'the page message is still running')
    w.reply(0)
    await ticks()
    assert.equal(w.rt.joinedInFlight.size, 0)
    // The page is a copy of the node Bot's chat (W4): nothing is written here.
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  })

  it('S24-e3 more steers than the limit wait on the hub; Stop ends the page turn and the side turns', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('m0', 'req-0'))
    for (let i = 1; i <= 5; i += 1) await w.prompt(steerRequest(`m${i}`, `req-${i}`))
    assert.equal(w.frames.length, 5, 'one page turn and four side turns are out; the fifth message waits')
    assert.equal(w.rt.joinedUserQueue.get(w.bot.id).length, 1)
    await w.rt.ctx.sessionController.cancel({ sessionId: 'mirror-1' })
    await ticks()
    assert.equal(w.rt.joinedSide?.size ?? 0, 0, 'Stop released every side turn')
    const turns = w.frames.filter(frame => frame.type === 'bot/turn')
    assert.equal(turns.length, 6, 'the waiting message started once the slots were free')
    assert.equal(turns[5].payload.text, 'm5')
    w.reply(5)
    await w.idle()
    assert.equal(w.rt.joinedInFlight.size, 0)
  })

  it('S24-f a repeated requestId is acknowledged and never sent to the node twice', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('once', 'req-dup'))
    // The page is a copy of the node Bot's chat (W4): the copy brings the message back with the composer's requestId.
    const rpcId = w.rt.joinedRequestOf(w.frames[0].payload.exchangeId)
    assert.equal(rpcId, 'req-dup')
    // In flight, before the node's copy of it came back: acknowledged, not queued, not sent again.
    assert.deepEqual(await w.prompt(textRequest('once', 'req-dup')), { accepted: true }, 'in flight: acknowledged, not busy')
    assert.equal(w.rt.joinedUserQueue?.get(w.bot.id)?.length ?? 0, 0)
    mirrorTurnStart(w.sessionOf('mirror-1'), { turn: 1, userText: 'once', rpcId })
    // A message waiting behind it is not queued twice either.
    await w.prompt(textRequest('next', 'req-next'))
    assert.deepEqual(await w.prompt(textRequest('next', 'req-next')), { accepted: true })
    assert.equal(w.rt.joinedUserQueue.get(w.bot.id).length, 1)
    w.reply(0)
    await w.idle()
    assert.deepEqual(await w.prompt(textRequest('once', 'req-dup')), { accepted: true }, 'finished: acknowledged')
    assert.deepEqual(turnFrames(w).map(frame => frame.payload.text), ['once', 'next'])
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

describe('S30-seen: a late write is remembered by (bot, nodeSeq)', () => {
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
})

describe('S30-unload: unloading the plugin ends what the page is waiting for', () => {
  it('S30-unload-b: unload stops an active page message: the slot is free and no listener is left', async () => {
    const w = makeWorld({ timeoutMs: 20 })
    await w.prompt(textRequest('slow'))
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
    for (const dispose of w.disposers) dispose()
    await w.idle()
    // The page is a copy of the node Bot's chat (W4): unload only ends the wait; nothing is written here.
    assert.equal(w.rt.joinedInFlight.size, 0)
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  })
})

describe('S30-stop: the page\'s Stop ends the wait and frees the Bot', () => {
  it('S30-stop-a: Stop on an open page message — the core cancel is not called, the node is told, the slot is free, nothing is written', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('slow tool run'))
    const ack = await w.cancel()
    assert.deepEqual(ack, { accepted: true })
    assert.equal(w.cancelCalls.length, 0, 'the core cancel would throw session/not-found on a mirror Session')
    // The page is a copy of the node Bot's chat (W4): no "stopped" line here; the node is told to stop.
    assert.equal(w.rt.joinedInFlight.size, 0)
    assert.deepEqual(w.frames.filter(frame => frame.type === 'bot/stop').map(frame => frame.payload.remoteBotId), ['rb1'])
    await w.idle()
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
    assert.equal(w.warnings.length, 0, 'a stop is not a failure')
  })

  it('S30-stop-b: the slot is free at once — the next message goes out (no agent-busy)', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('stuck', 'req-1'))
    await w.cancel()
    const ack = await w.prompt(textRequest('again', 'req-2'))
    assert.deepEqual(ack, { accepted: true })
    const sent = w.frames.filter(f => f.type === 'bot/turn')
    assert.equal(sent.length, 2)
    assert.equal(sent[1].payload.text, 'again')
    // The new message holds the slot (W4: the page itself is the node Bot's chat).
    assert.equal(w.rt.joinedInFlight.get(w.bot.id).requestId, 'req-2')
    assert.equal(w.rt.joinedUserQueue?.get(w.bot.id)?.length ?? 0, 0)
  })

  it('S30-stop-b2: released synchronously — stopPageTurn frees the in-flight table before it returns', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('stuck'))
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), true)
    assert.equal(stopPageTurn(w.rt, w.bot.id), true)
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), false)
    assert.equal(stopPageTurn(w.rt, w.bot.id), false, 'nothing left to stop')
  })

  it('S30-stop-d: Stop with nothing in flight (never sent, already finished, pressed twice) is acknowledged and changes nothing', async () => {
    const w = makeWorld()
    assert.deepEqual(await w.cancel(), { accepted: true })
    await w.prompt(textRequest('hi'))
    w.reply(0)
    await w.idle()
    assert.deepEqual(await w.cancel(), { accepted: true })
    assert.equal(w.rt.joinedInFlight.size, 0, 'a finished message is not touched')
    await w.prompt(textRequest('again', 'req-2'))
    await w.cancel()
    assert.equal(w.rt.joinedInFlight.size, 0)
    assert.deepEqual(await w.cancel(), { accepted: true }, 'the second Stop is acknowledged too')
    assert.equal(stopPageTurn(w.rt, w.bot.id), false, 'nothing left to stop')
    // The page is a copy of the node Bot's chat (W4): nothing is written here.
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
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

  it('S30-stop-f: the stopped wait leaves no listener and no timer, and the tracker says stopped — not offline', async () => {
    const w = makeWorld({ timeoutMs: 30, tracker: true })
    await w.prompt(textRequest('stuck'))
    await w.cancel()
    // No late listener any more (W4): the node Bot's own chat reaches the page as its copy.
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
    await wait(90)
    await w.idle()
    assert.equal(w.warnings.length, 0, 'the 30ms timer is gone')
    assert.equal(w.rt.joinedInFlight.size, 0)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
    assert.equal(w.rt.turnTracker.get(w.frames[0].payload.exchangeId).error, 'E_ABORTED')
  })
})

describe('queued messages and failed steers are never lost', () => {
  const steer = (text, requestId) => ({ ...textRequest(text, requestId), mode: 'steer' })

  it('three queued messages are sent one after the other, each after the turn before it ends', async () => {
    const w = makeWorld({ tracker: true })
    await w.prompt(textRequest('first', 'req-1'))
    await w.prompt(textRequest('second', 'req-2'))
    await w.prompt(textRequest('third', 'req-3'))
    const turns = () => w.frames.filter(frame => frame.type === 'bot/turn').map(frame => frame.payload.text)
    assert.deepEqual(turns(), ['first'], 'queue means wait')
    w.reply(0); await ticks()
    assert.deepEqual(turns(), ['first', 'second'])
    w.reply(1); await ticks()
    assert.deepEqual(turns(), ['first', 'second', 'third'], 'the third was not lost behind the second')
    w.reply(2); await ticks()
    // The page is a copy of the node Bot's chat (W4): each message finished on the tracker, nothing is written here.
    assert.deepEqual(turnFrames(w).map(frame => w.rt.turnTracker.get(frame.payload.exchangeId).status), ['done', 'done', 'done'])
    assert.equal(w.rt.joinedInFlight.size, 0)
    assert.equal(w.rt.joinedUserQueue?.has(w.bot.id) ?? false, false)
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  })

  it('a steer the node never got is the composer\'s error: it is not silently dropped', async () => {
    const w = makeWorld({ tracker: true })
    await w.prompt(textRequest('first', 'req-1'))
    const registry = w.rt.ctx.get('remote-agent:registry')
    const send = registry.send
    let allow = true
    registry.send = (...args) => (allow ? send(...args) : false)
    allow = false
    // What could not reach the node is the composer's error (W4), not a line on the page.
    const error = await rejection(w.prompt(steer('and this', 'req-2')))
    assert.equal(error.code, 'session/agent-unavailable')
    assert.match(error.message, /^无法送达节点：.*E_OFFLINE/)
    await ticks()
    assert.equal(w.rt.joinedSide?.size ?? 0, 0, 'the failed steer holds no slot')
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), true, 'the message in flight is untouched')
    assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  })
})
