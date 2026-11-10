// s50 / merge plan I2 (R3, R4): resume.js — upstream v0.3.2 adds a reader for `turn/end` reason.kind ===
// 'max-tokens' next to the existing readers of `reason.reason.kind` (aborted/disposed = "DSH shut down",
// aborted/hook/STEER_CUT = "a steer cut it"). The turn/end events this fork writes into a joined Bot's mirror
// Session must read, through resume.js's OWN turn reader (turnsOf/turnOf), exactly as written — and never as a
// cut-off, a shutdown or a steer cut. Real writers (a page turn through the joined prompt takeover: success is
// not needed, stop / failure / duplicate are), real reader. Written before the merge: green on fork.76; the
// merged resume.js must keep it green.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeWorld, textRequest } from './joined-world.js'
import { turnsOf, turnOf } from '../src/host/resume.js'
import { turnEnd, DUPLICATE_RESULT } from '../src/host/turn-end.js'
import { STEER_CUT } from '../src/host/constants.js'

const { Session } = await import('@deepseek-ai/dsh-session')

const endsOf = session => turnsOf(session.log).map(turn => turn.reason)
const isCutOff = reason => reason?.kind === 'max-tokens'
const isShutdown = reason => reason?.kind === 'aborted' && reason.reason?.kind === 'disposed'
const isSteerCut = reason => reason?.kind === 'aborted' && reason.reason?.kind === 'hook' && reason.reason?.reason === STEER_CUT

describe('S50-resume-shape: what ds-bot writes, resume.js reads as written', () => {
  it('R-stop: a stopped page turn reads as aborted/user — not a shutdown, not a steer cut, not a cut-off', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('stuck'))
    await w.cancel()
    const [reason] = endsOf(w.sessionOf('mirror-1'))
    assert.deepEqual(JSON.parse(JSON.stringify(reason)), { kind: 'aborted', reason: { kind: 'user' } })
    assert.equal(isCutOff(reason) || isShutdown(reason) || isSteerCut(reason), false)
  })

  it('R-fail: a page turn that could not reach the node reads as error with a code', async () => {
    for (const world of [{ sendThrows: true }, { sendResult: false }]) {
      const w = makeWorld(world)
      assert.deepEqual(await w.prompt(textRequest('hello')), { accepted: true })
      await w.idle()
      const reasons = endsOf(w.sessionOf('mirror-1'))
      assert.equal(reasons.length, 1, 'exactly one turn ended')
      assert.equal(reasons[0].kind, 'error')
      assert.equal(reasons[0].error.code, 'E_OFFLINE')
      assert.equal(isCutOff(reasons[0]) || isShutdown(reasons[0]) || isSteerCut(reasons[0]), false)
    }
  })

  it('R-builder: every shape of the one builder survives the reader, and none of them is a cut-off, a shutdown (disposed) or a steer cut', () => {
    const session = new Session('shapes')
    const shapes = { completed: turnEnd.completed(), stopped: turnEnd.stopped(), duplicate: turnEnd.duplicateResult(), interrupted: turnEnd.interrupted(), error: turnEnd.error('boom', 'E_TIMEOUT'), errorDefault: turnEnd.error('boom') }
    let n = 0
    for (const reason of Object.values(shapes)) {
      n += 1
      session.append('turn/start', { turn: n })
      session.append('turn/end', { turn: n, reason })
    }
    const read = turnsOf(session.log).map(turn => turn.reason)
    assert.deepEqual(JSON.parse(JSON.stringify(read)), JSON.parse(JSON.stringify(Object.values(shapes))), 'read exactly as written, in order')
    for (const reason of read) assert.equal(isCutOff(reason) || isShutdown(reason) || isSteerCut(reason), false, JSON.stringify(reason))
    assert.equal(shapes.duplicate.reason.reason, DUPLICATE_RESULT)
    assert.equal(shapes.errorDefault.error.code, 'UNKNOWN')
  })

  it('R-turnOf: turnOf finds the turn that took an exchange and returns its reason unchanged (a steer cut is the only reason it rewrites)', () => {
    const session = new Session('of')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', { turn: 1, source: { exchangeId: 'x1' }, message: { content: [{ type: 'text', text: 'q' }] } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: turnEnd.stopped() })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', { turn: 2, source: { exchangeId: 'x2' }, message: { content: [{ type: 'text', text: 'q' }] } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: turnEnd.duplicateResult() })
    assert.deepEqual(JSON.parse(JSON.stringify(turnOf(session.log, 'x1').reason)), { kind: 'aborted', reason: { kind: 'user' } })
    assert.equal(turnOf(session.log, 'x2').reason.reason.reason, DUPLICATE_RESULT)
    assert.equal(turnOf(session.log, 'x2').reason.reason.reason === STEER_CUT, false, 'ours is not the steer cut')
  })
})
