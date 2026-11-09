// The turn/end events ds-bot writes into a mirror Session, read by the core's own code.
//
// A bare { kind: 'aborted' } (no `reason`) made ui-chat's endFailure() throw while the chat of a
// reloaded page was rebuilt — the page showed no history at all (test/smoke/RUN-RECORD-2026-11-10-o7b.md).
// Here every writer of mirror.js runs on a real Session and each turn/end it wrote goes through
//   · ui-chat's endFailure / failureFrom / displayFailure   (client/ui-chat/src/client/conversation-nodes/…)
//   · the SDK's validatedTurnEndReason                      (sdk/client/src/api.ts)
// loaded unchanged from the Harness checkout's source (test/core-source.js), not re-written here.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { coreSource, REQUIRE_CORE_SOURCE } from './core-source.js'
import {
  allocateTurn, mirrorTurn, mirrorTurnStart, mirrorTurnFinish, mirrorTurnFail, mirrorTurnAbort,
  mirrorLateReply, mirrorTurnEnd, importHistory, mirrorStateOf,
} from '../src/host/mirror.js'
import { turnEnd, DUPLICATE_RESULT } from '../src/host/turn-end.js'

const { Session } = await import('@deepseek-ai/dsh-session')

const chat = coreSource([
  { file: 'client/ui-chat/src/client/conversation-nodes/event-projection.ts', functions: ['displayFailure'] },
  { file: 'client/ui-chat/src/client/conversation-nodes/turn-error.ts', functions: ['endFailure', 'failureFrom'] },
])
const sdk = coreSource([
  { file: 'sdk/client/src/client.ts', functions: ['isRecord'], classes: ['SdkProtocolError'] },
  { file: 'sdk/client/src/api.ts', functions: ['validatedTurnEndReason'] },
])
const SKIP = chat !== undefined && sdk !== undefined ? false : 'the Harness checkout source is not there (set DSH_HARNESS)'
if (SKIP && REQUIRE_CORE_SOURCE) throw new Error(`DSH_REQUIRE_CORE_SOURCE=1 but: ${SKIP}`)

const makeSession = () => new Session('turn-end-' + Math.random().toString(36).slice(2))
const endsOf = session => session.log.filter(event => event.type === 'turn/end')
const failureOf = event => chat.failureFrom({ event })   // what the chat's turn-error node reads off the event

/** A write the Session refuses, once: wraps the instance's append. */
function failOnce(session, type) {
  const original = session.append.bind(session)
  let tripped = false
  session.append = (kind, ...rest) => {
    if (kind === type && !tripped) { tripped = true; throw new Error(`disk refused ${type}`) }
    return original(kind, ...rest)
  }
  return session
}

/** Both core readers accept the event, never throw, and the reason has every field they read. */
function coreAccepts(event) {
  const { reason } = event.data
  assert.doesNotThrow(() => chat.endFailure(reason), `ui-chat endFailure on ${JSON.stringify(reason)}`)
  assert.doesNotThrow(() => sdk.validatedTurnEndReason(reason), `sdk validatedTurnEndReason on ${JSON.stringify(reason)}`)
  if (reason.kind === 'aborted') assert.equal(typeof reason.reason?.kind, 'string', 'aborted names its cause')
  if (reason.kind === 'error') {
    assert.equal(typeof reason.error?.message, 'string')
    assert.equal(typeof reason.error?.code, 'string', 'error.code is a required string (LlmFailure)')
  }
  return failureOf(event)
}

describe('S43: the core\'s own readers accept what ds-bot writes', { skip: SKIP }, () => {
  it('S43-premise: the loaded core code is the real thing — a bare aborted throws in both readers', () => {
    assert.throws(() => chat.endFailure({ kind: 'aborted' }), TypeError)
    assert.throws(() => sdk.validatedTurnEndReason({ kind: 'aborted' }), sdk.SdkProtocolError)
    // and it shows what a good ending looks like
    assert.equal(chat.endFailure(turnEnd.stopped()), undefined)
    assert.deepEqual(chat.endFailure(turnEnd.interrupted()), { message: 'The DSH process exited before this turn finished.', code: 'INTERRUPTED' })
  })

  it('S43-builder: every ending the builder makes is accepted; aborted always carries a cause the SDK knows', () => {
    for (const reason of [turnEnd.completed(), turnEnd.stopped(), turnEnd.duplicateResult(), turnEnd.interrupted(), turnEnd.error('boom'), turnEnd.error('boom', 'E_TIMEOUT')]) {
      assert.doesNotThrow(() => chat.endFailure(reason))
      assert.doesNotThrow(() => sdk.validatedTurnEndReason(reason))
    }
    assert.deepEqual(turnEnd.stopped(), { kind: 'aborted', reason: { kind: 'user' } })
    assert.deepEqual(turnEnd.duplicateResult(), { kind: 'aborted', reason: { kind: 'hook', reason: DUPLICATE_RESULT } })
    assert.notEqual(turnEnd.stopped().reason.kind, 'disposed', 'disposed would make resume.js pick the turn up again')
    assert.equal(turnEnd.error('x').error.code, 'UNKNOWN')
    assert.equal(turnEnd.error('x', '').error.code, 'UNKNOWN')
    assert.equal(turnEnd.error('x', 'E_OFFLINE').error.code, 'E_OFFLINE')
  })

  it('S43-dangling: allocateTurn closes an open turn as `interrupted` — the chat shows the "process exited" row', () => {
    const session = makeSession()
    session.append('turn/start', { turn: 1 })
    assert.equal(allocateTurn(session), 2)
    const [end] = endsOf(session)
    assert.deepEqual(end.data.reason, { kind: 'interrupted' })
    assert.deepEqual(coreAccepts(end), { seq: end.seq, time: end.time, message: 'The DSH process exited before this turn finished.', code: 'INTERRUPTED' })
  })

  it('S43-stop: mirrorTurnAbort ends the turn as aborted/user — accepted, and no failure row for a Stop', () => {
    const session = makeSession()
    mirrorTurnStart(session, { turn: 1, userText: 'hi', rpcId: 'r1' })
    const closedTurns = new Set()
    mirrorTurnAbort(session, { turn: 1, closedTurns })
    const [end] = endsOf(session)
    assert.deepEqual(end.data.reason, { kind: 'aborted', reason: { kind: 'user' } })
    assert.equal(coreAccepts(end), undefined)
  })

  it('S43-duplicate: a node result already written closes the turn as a hook abort — accepted, nothing shown', () => {
    const session = makeSession()
    const state = { seenKeys: new Set(['b1:7']), closedKeys: new Set(), seenSteps: new Set(), closedTurns: new Set() }
    mirrorTurnStart(session, { turn: 1, userText: 'hi', rpcId: 'r1' })
    const out = mirrorTurnFinish(session, { turn: 1, botText: 'again', botId: 'b1', nodeSeq: 7, ...state })
    assert.equal(out.skipped, true)
    const [end] = endsOf(session)
    assert.deepEqual(end.data.reason, { kind: 'aborted', reason: { kind: 'hook', reason: DUPLICATE_RESULT } })
    assert.equal(coreAccepts(end), undefined)
  })

  it('S43-fail: mirrorTurnFail writes error with a code (given, or UNKNOWN) — accepted, and the row carries the code', () => {
    for (const [code, shown] of [['E_TIMEOUT', 'E_TIMEOUT'], [undefined, 'UNKNOWN']]) {
      const session = makeSession()
      mirrorTurnStart(session, { turn: 1, userText: 'hi', rpcId: 'r1' })
      mirrorTurnFail(session, { turn: 1, code, message: 'node did not answer', closedTurns: new Set() })
      const [end] = endsOf(session)
      assert.equal(coreAccepts(end).code, shown)
      assert.equal(coreAccepts(end).message, 'node did not answer')
    }
  })

  it('S43-finish: a normal finish and a late reply end as completed — accepted', () => {
    const session = makeSession()
    const state = mirrorStateOf({}, 'b1')
    mirrorTurnStart(session, { turn: 1, userText: 'hi', rpcId: 'r1' })
    mirrorTurnFinish(session, { turn: 1, botText: 'ok', botId: 'b1', nodeSeq: 1, ...state })
    mirrorLateReply(session, { botText: 'late', botId: 'b1', nodeSeq: 2, ...state })
    const ends = endsOf(session)
    assert.equal(ends.length, 2)
    for (const end of ends) { assert.deepEqual(end.data.reason, { kind: 'completed' }); assert.equal(coreAccepts(end), undefined) }
  })

  it('S43-finish-write-failure: a write that fails inside mirrorTurnFinish closes the turn with an error code, accepted', () => {
    const session = failOnce(makeSession(), 'assistant/message')
    mirrorTurnStart(session, { turn: 1, userText: 'hi', rpcId: 'r1' })
    assert.throws(() => mirrorTurnFinish(session, { turn: 1, botText: 'ok', closedTurns: new Set() }), /disk refused/)
    const [end] = endsOf(session)
    assert.equal(end.data.reason.error.code, 'E_MIRROR_WRITE')
    assert.equal(coreAccepts(end).code, 'E_MIRROR_WRITE')
  })

  it('S43-late-write-failure: a failing late reply closes its turn with an error code, accepted', () => {
    const session = failOnce(makeSession(), 'assistant/message')
    assert.throws(() => mirrorLateReply(session, { botText: 'late', closedTurns: new Set() }), /disk refused/)
    const [end] = endsOf(session)
    assert.equal(coreAccepts(end).code, 'E_MIRROR_WRITE')
  })

  it('S43-start-write-failure: mirrorTurnStart failing after turn/start closes it with an error code, accepted', () => {
    const session = failOnce(makeSession(), 'user/message')
    assert.throws(() => mirrorTurnStart(session, { turn: 1, userText: 'hi', rpcId: 'r1' }), /disk refused/)
    const [end] = endsOf(session)
    assert.equal(coreAccepts(end).code, 'E_MIRROR_WRITE')
  })

  it('S43-mirrorTurn: the whole-exchange writer — completed, and a failing write ends with an error code', async () => {
    const ok = makeSession()
    await mirrorTurn(ok, { userText: 'hi', botText: 'ok' })
    assert.equal(coreAccepts(endsOf(ok)[0]), undefined)
    const bad = failOnce(makeSession(), 'assistant/message')
    await assert.rejects(mirrorTurn(bad, { userText: 'hi', botText: 'ok' }), /disk refused/)
    assert.equal(coreAccepts(endsOf(bad)[0]).code, 'E_MIRROR_WRITE')
  })

  it('S43-import: imported history — completed turns, and an item whose write fails ends with an error code', async () => {
    const ok = makeSession()
    await importHistory(ok, [{ userText: 'a', botText: 'b', turn: 1, seq: 1 }], { watermark: 0 })
    assert.equal(coreAccepts(endsOf(ok)[0]), undefined)
    const bad = failOnce(makeSession(), 'assistant/message')
    const result = await importHistory(bad, [{ userText: 'a', botText: 'b', turn: 1, seq: 1 }], { watermark: 0 })
    assert.equal(result.warnings.length, 1)
    assert.equal(coreAccepts(endsOf(bad)[0]).code, 'E_MIRROR_WRITE')
  })

  it('S43-mirrorTurnEnd: the small closer writes a valid ending both ways', () => {
    const stopped = makeSession(); const failed = makeSession()
    stopped.append('turn/start', { turn: 1 }); failed.append('turn/start', { turn: 1 })
    mirrorTurnEnd(stopped, 1)
    mirrorTurnEnd(failed, 1, 'it broke')
    assert.equal(coreAccepts(endsOf(stopped)[0]), undefined)
    assert.equal(coreAccepts(endsOf(failed)[0]).message, 'it broke')
  })

  it('S43-rebuild: a log made of every kind of ending is read end to end without a throw (the reload that showed no history)', async () => {
    const session = makeSession()
    const state = mirrorStateOf({}, 'b1')
    await importHistory(session, [{ userText: 'old', botText: 'older', turn: 1, seq: 1 }], { watermark: 0, ...state })
    session.append('turn/start', { turn: 2 })                         // left open (a crash)
    mirrorTurnStart(session, { turn: allocateTurn(session), userText: 'q1', rpcId: 'r1' })  // closes 2 as interrupted, opens 3
    mirrorTurnAbort(session, { turn: 3, closedTurns: state.closedTurns })
    mirrorTurnStart(session, { turn: allocateTurn(session), userText: 'q2', rpcId: 'r2' })
    mirrorTurnFail(session, { turn: 4, code: 'E_OFFLINE', message: 'node offline', closedTurns: state.closedTurns })
    const rows = endsOf(session).map(event => failureOf(event)?.code)
    assert.deepEqual(rows, [undefined, 'INTERRUPTED', undefined, 'E_OFFLINE'])
    for (const event of endsOf(session)) coreAccepts(event)
  })
})
