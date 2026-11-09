// fork.70: a joined Bot's page turn shows as running (so the composer offers Stop), Stop never
// loses an answer that already arrived, the phone's Stop reaches the page turn, unloading restores
// the controller. Real install(rt) (joined-world.js) + real Session events.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeWorld, textRequest, types } from './joined-world.js'
import { mirrorTurnStart, mirrorTurnFinish, mirrorTurnFail, mirrorTurnAbort, STOPPED_TEXT } from '../src/host/mirror.js'

const { Session } = await import('@deepseek-ai/dsh-session')
const assistantTexts = session => session.log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text)
const MIRROR = 'mirror-1'

describe('S33-run: the mirror Session reports running while its page turn is in flight', () => {
  it('S33-run-a: the status event goes out once with true when the user message is on the page, and once with false when the answer is written', async () => {
    const w = makeWorld()
    assert.deepEqual(w.statuses(), [])
    await w.prompt(textRequest('hello'))
    assert.deepEqual(w.statuses(), [[MIRROR, true]], 'running from the moment the turn starts')
    assert.equal(types(w.sessionOf(MIRROR)).includes('user/message'), true, 'the message is already on the page')
    w.reply(0)
    await w.idle()
    assert.deepEqual(w.statuses(), [[MIRROR, true], [MIRROR, false]])
  })

  it('S33-run-b: every way the turn ends brings running back to false — timeout, rejection, node offline, Stop — exactly once', async () => {
    for (const [name, setup, trigger] of [
      ['timeout', () => makeWorld({ timeoutMs: 20 }), async () => {}],
      ['rejection', () => makeWorld(), async w => { w.reply(0, { ok: false, text: undefined, error: 'busy' }) }],
      ['offline', () => makeWorld(), async w => { w.emitter.emit('nodeOffline', { nodeId: 'n1' }) }],
      ['stop', () => makeWorld(), async w => { await w.cancel() }],
      ['send refused', () => makeWorld({ sendResult: false }), async () => {}],
    ]) {
      const w = setup()
      await w.prompt(textRequest('x'))
      await trigger(w)
      await w.idle()
      assert.deepEqual(w.statuses(), [[MIRROR, true], [MIRROR, false]], name)
    }
  })

  it('S33-run-c: a page that could not be written says nothing about running (no true, no false), and nothing was sent', async () => {
    const w = makeWorld({ failAppendOn: 'user/message' })
    await w.prompt(textRequest('x')).catch(() => {})
    assert.deepEqual(w.statuses(), [])
    assert.equal(w.frames.length, 0)
    assert.equal(w.rt.joinedInFlight.size, 0)
  })

  it('S33-run-d: the session list marks the in-flight mirror Session running:true and returns every other item as the same object', async () => {
    const w = makeWorld()
    const idle = await w.controller.list({}, new AbortController().signal)
    assert.equal(idle, w.listResult, 'idle: the original result, untouched')
    await w.prompt(textRequest('x'))
    const busy = await w.controller.list({}, new AbortController().signal)
    assert.equal(busy.items.find(item => item.sessionId === MIRROR).running, true)
    assert.deepEqual(busy.items.find(item => item.sessionId === MIRROR), { ...w.listItems[0], running: true }, 'only running changed')
    assert.equal(busy.items[1], w.listItems[1], 'an ordinary item is the very same object')
    assert.equal(busy.items[2], w.listItems[2])
    assert.equal(w.listItems[0].running, false, 'the original item was not mutated')
    w.reply(0)
    await w.idle()
    assert.equal(await w.controller.list({}, new AbortController().signal), w.listResult, 'finished: untouched again')
  })

  it('S33-run-e: only a joined Session that is in flight is touched — another joined Bot\'s page stays as it is, and arguments reach the original list', async () => {
    const w = makeWorld({ listItems: [{ sessionId: 'mirror-1', running: false }, { sessionId: 'other-joined', running: false }] })
    await w.prompt(textRequest('x'))
    const signal = new AbortController().signal
    const result = await w.controller.list({ q: 1 }, signal)
    assert.deepEqual(result.items.map(item => item.running), [true, false])
    assert.deepEqual(w.listCalls.at(-1), [{ q: 1 }, signal])
  })

  it('S33-run-e2: a turn is in flight but the list holds nothing to change — the original result object comes back, not a copy', async () => {
    const w = makeWorld({ listItems: [{ sessionId: 'ordinary-1', running: false }, { sessionId: 'ordinary-2', running: true }] })
    await w.prompt(textRequest('x'))
    assert.equal(await w.controller.list({}, new AbortController().signal), w.listResult)
  })

  it('S33-run-f: the core re-sends a summary with running:false (an Agent came or went) — the bit is asserted again; an ordinary Session or an idle Bot is left alone', async () => {
    const w = makeWorld()
    w.added({ sessionId: MIRROR, running: false })
    assert.deepEqual(w.statuses(), [], 'idle joined Session: nothing')
    await w.prompt(textRequest('x'))
    const before = w.statuses().length
    w.added({ sessionId: 'ordinary-1', running: false })
    w.added({ sessionId: MIRROR, running: true })
    assert.equal(w.statuses().length, before, 'ordinary Session / already running: nothing')
    w.added({ sessionId: MIRROR, running: false })
    assert.deepEqual(w.statuses().slice(before), [[MIRROR, true]])
    w.reply(0)
    await w.idle()
    const done = w.statuses().length
    w.added({ sessionId: MIRROR, running: false })
    assert.equal(w.statuses().length, done, 'finished: not asserted any more')
  })

  it('S33-run-g: no live Agent is created for the mirror Session — the page turn does not touch the Agent surface', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('x'))
    assert.equal(w.originalCalls.length, 0)
    assert.equal(w.cancelCalls.length, 0)
  })
})

describe('S33-unload: unloading restores the controller methods', () => {
  it('S33-unload-a: prompt, cancel and list are the original functions again after the effects are disposed', async () => {
    const w = makeWorld()
    for (const name of ['prompt', 'cancel', 'list']) assert.notEqual(w.controller[name], w.originals[name], `${name} is wrapped while installed`)
    for (const dispose of w.disposers) dispose()
    for (const name of ['prompt', 'cancel', 'list']) assert.equal(w.controller[name], w.originals[name], `${name} restored`)
    const result = await w.controller.cancel({ sessionId: MIRROR })
    assert.equal(result.from, 'original-cancel', 'a Stop after unload reaches the core again')
  })

  it('S33-unload-b: a wrapper another plugin put on top is not torn down by our dispose', async () => {
    const w = makeWorld()
    const outer = async (...args) => w.controller.cancel.call(null, ...args)
    const ours = w.controller.cancel
    w.controller.cancel = outer
    for (const dispose of w.disposers) dispose()
    assert.equal(w.controller.cancel, outer, 'only our own wrapper is restored')
    assert.notEqual(ours, w.originals.cancel)
  })
})

describe('S33-stop-received: Stop does not throw away an answer that has already arrived', () => {
  it('S33-stop-h: the node answers and Stop comes in the same tick — the answer is written as a normal completed turn, no "已停止" line', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('x'))
    w.reply(0, { text: 'the real answer', seq: 5 })
    const ack = await w.cancel()   // same tick: settle() has not run yet
    assert.deepEqual(ack, { accepted: true })
    await w.idle()
    const session = w.sessionOf(MIRROR)
    assert.deepEqual(assistantTexts(session), ['the real answer'])
    assert.equal(session.log.at(-1).data.reason.kind, 'completed')
    assert.equal(types(session).filter(type => type === 'turn/end').length, 1)
    assert.equal(assistantTexts(session).some(text => text.includes(STOPPED_TEXT)), false)
    assert.equal(w.emitter.listenerCount('botTurnResult'), 0)
  })

  it('S33-stop-h2: a rejection that has already arrived is written as the rejection, not as a Stop', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('x'))
    w.reply(0, { ok: false, text: undefined, error: 'node-said-no' })
    await w.cancel()
    await w.idle()
    const session = w.sessionOf(MIRROR)
    assert.equal(session.log.at(-1).data.reason.error.code, 'E_REJECTED')
    assert.equal(assistantTexts(session).some(text => text.includes(STOPPED_TEXT)), false)
  })

  it('S33-stop-h3: the contrast — Stop before the node answers still stops (and the answer is then a late reply)', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('x'))
    await w.cancel()
    assert.equal(w.sessionOf(MIRROR).log.at(-1).data.reason.kind, 'aborted')
  })
})

describe('S33-abort-guard: one turn/end per turn, whichever of Finish / Fail / Abort comes first', () => {
  const opened = () => {
    const session = new Session('guard-1')
    mirrorTurnStart(session, { turn: 1, userText: 'q', rpcId: 'r1' })
    return { session, closedTurns: new Set() }
  }
  const ends = session => session.log.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)

  it('S33-abort-guard-a: Abort twice → one aborted turn/end and one stopped line; the second call reports it was skipped', () => {
    const { session, closedTurns } = opened()
    assert.deepEqual(mirrorTurnAbort(session, { turn: 1, closedTurns }), { skipped: false })
    const before = session.log.length
    assert.deepEqual(mirrorTurnAbort(session, { turn: 1, closedTurns }), { skipped: true, reason: 'already-closed:turn' })
    assert.equal(session.log.length, before)
    assert.deepEqual(ends(session), ['aborted'])
  })

  it('S33-abort-guard-b: Fail then Abort, and Finish then Abort — the Abort writes nothing', () => {
    for (const first of [
      ({ session, closedTurns }) => mirrorTurnFail(session, { turn: 1, code: 'E_TIMEOUT', message: 'late', closedTurns }),
      ({ session, closedTurns }) => mirrorTurnFinish(session, { turn: 1, botText: 'ok', closedTurns }),
    ]) {
      const world = opened()
      first(world)
      const before = world.session.log.length
      assert.equal(mirrorTurnAbort(world.session, { turn: 1, closedTurns: world.closedTurns }).skipped, true)
      assert.equal(world.session.log.length, before)
      assert.equal(ends(world.session).length, 1)
    }
  })

  it('S33-abort-guard-c: Abort then Fail, and Abort then Finish — the late writer writes nothing', () => {
    for (const second of [
      ({ session, closedTurns }) => mirrorTurnFail(session, { turn: 1, code: 'E_TIMEOUT', message: 'late', closedTurns }),
      ({ session, closedTurns }) => mirrorTurnFinish(session, { turn: 1, botText: 'ok', closedTurns }),
    ]) {
      const world = opened()
      mirrorTurnAbort(world.session, { turn: 1, closedTurns: world.closedTurns })
      const before = world.session.log.length
      second(world)
      assert.equal(world.session.log.length, before)
      assert.deepEqual(ends(world.session), ['aborted'])
    }
  })

  it('S33-abort-guard-d: a different turn is not blocked by the first one\'s closure', () => {
    const { session, closedTurns } = opened()
    mirrorTurnAbort(session, { turn: 1, closedTurns })
    mirrorTurnStart(session, { turn: 2, userText: 'q2', rpcId: 'r2' })
    assert.equal(mirrorTurnAbort(session, { turn: 2, closedTurns }).skipped, false)
    assert.deepEqual(ends(session), ['aborted', 'aborted'])
  })
})

describe('S33-phone: the phone\'s Stop reaches a joined Bot\'s page turn', () => {
  it('S33-phone-a: rt.stopJoinedTurn(botId) ends the page turn once and answers true; with nothing in flight it answers false and writes nothing', async () => {
    const w = makeWorld()
    assert.equal(w.rt.stopJoinedTurn(w.bot.id), false)
    await w.prompt(textRequest('x'))
    assert.equal(w.rt.stopJoinedTurn(w.bot.id), true)
    assert.equal(w.sessionOf(MIRROR).log.at(-1).data.reason.kind, 'aborted')
    const written = w.sessionOf(MIRROR).log.length
    assert.equal(w.rt.stopJoinedTurn(w.bot.id), false)
    assert.equal(w.sessionOf(MIRROR).log.length, written)
    assert.deepEqual(w.statuses(), [[MIRROR, true], [MIRROR, false]])
  })

  it('S33-phone-b: another Bot id (an ordinary Bot) is not a joined page turn', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('x'))
    assert.equal(w.rt.stopJoinedTurn('some-local-bot'), false)
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), true, 'the joined turn is still in flight')
  })
})
