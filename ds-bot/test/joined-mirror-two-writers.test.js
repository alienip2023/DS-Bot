// The joined Bot's mirror Session has two writers: the page turn (executor.startPageTurn) and
// a Bot-to-Bot exchange (joined-turn). These tests drive both, in both orders, and assert the
// stored log still restores strictly — one open turn at a time, every turn closed once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld } from './joined-world.js'
import { handleJoinedTurn } from '../src/host/joined-turn.js'
import { mirrorStateOf } from '../src/host/mirror.js'

const { Session } = await import('@deepseek-ai/dsh-session')

const settle = () => new Promise(resolve => setImmediate(resolve))
const drain = async (times = 4) => { for (let i = 0; i < times; i += 1) await settle() }

/**
 * The framing rule a strict Session restore applies: a turn/start opens a turn, step/start
 * opens a step, messages belong to the open turn/step, turn/end closes the open turn — and a
 * turn that is still open at the end fails the restore. Written here so the test fails with a
 * readable reason instead of only inside the format decoder.
 */
function assertStrictTurns(session) {
  let openTurn = null
  let openStep = null
  let closed = 0
  for (const event of session.log) {
    const turn = event.data?.turn
    switch (event.type) {
      case 'turn/start':
        assert.equal(openTurn, null, `turn/start ${turn} while turn ${openTurn} is open`)
        assert.equal(openStep, null, `turn/start ${turn} inside an open step`)
        openTurn = turn
        break
      case 'step/start':
        assert.equal(openTurn, turn, `step/start ${turn} outside its turn`)
        assert.equal(openStep, null, `step/start ${turn} while a step is open`)
        openStep = event.data.step
        break
      case 'user/message':
        // A user message carries the content, not the turn/step fields.
        assert.notEqual(openTurn, null, 'user/message outside its turn')
        assert.notEqual(openStep, null, 'user/message outside its step')
        break
      case 'assistant/message':
        assert.equal(openTurn, turn, `${event.type} ${turn} outside its turn`)
        assert.notEqual(openStep, null, `${event.type} ${turn} outside its step`)
        break
      case 'step/end':
        assert.equal(openTurn, turn, `step/end ${turn} outside its turn`)
        assert.equal(openStep, event.data.step, `step/end ${turn} does not match the open step`)
        openStep = null
        break
      case 'turn/end':
        assert.equal(openTurn, turn, `turn/end ${turn} does not match the open turn`)
        assert.equal(openStep, null, `turn/end ${turn} with an open step`)
        openTurn = null
        closed += 1
        break
      default:
        break
    }
  }
  assert.equal(openTurn, null, `turn ${openTurn} is still open`)
  assert.equal(openStep, null, `step ${openStep} is still open`)
  return closed
}

const texts = (session, type) => session.log
  .filter(event => event.type === type)
  .map(event => (type === 'user/message'
    ? event.data.content.map(part => part.text ?? '').join('')
    : event.data.message?.content?.map(part => part.text ?? '').join('') ?? ''))

test('mirror bookkeeping starts fresh when the mirror Session is rebuilt', () => {
  const rt = {}
  const first = new Session('mirror-a')
  const stateA = mirrorStateOf(rt, 'joined:n1:rb1', first)
  stateA.closedTurns.add(1)
  const oldClosed = stateA.closedTurns
  assert.equal(mirrorStateOf(rt, 'joined:n1:rb1', first), stateA, 'same Session keeps its bookkeeping')
  assert.equal(stateA.closedTurns.has(1), true)

  const second = new Session('mirror-b')
  const stateB = mirrorStateOf(rt, 'joined:n1:rb1', second)
  assert.equal(stateB, stateA, 'the per-Bot state is kept')
  assert.notEqual(stateB.closedTurns, oldClosed, 'a new Session gets a fresh closed-turn set')
  assert.equal(stateB.closedTurns.size, 0, 'turn numbers restart at 1 in a new Session, so old closures must not hide them')
})

test('a timed-out exchange reuses its waiter on retry and writes the late answer once', async () => {
  const w = makeWorld({ timeoutMs: 20 })
  w.rt.state.exchanges = []
  const timedOut = await handleJoinedTurn(w.rt, { fromId: 'local', toId: w.bot.id, text: 'first try', exchangeId: 'ex-3', role: 'request' })
  assert.deepEqual(timedOut, { ok: false, error: 'bot-turn-pending', exchangeId: 'ex-3' })
  const session = w.sessionOf('mirror-1')
  assert.equal(session.log.filter(event => event.type === 'turn/end').length, 0)
  assert.doesNotMatch(texts(session, 'assistant/message').join(''), /桥已断/)

  await handleJoinedTurn(w.rt, { fromId: 'local', toId: w.bot.id, text: 'first try', exchangeId: 'ex-3', role: 'request' })
  assert.equal(w.frames.length, 1, 'an in-flight retry does not send another frame or arm another waiter')
  w.reply(0, { text: 'late answer' })
  await drain()
  assert.equal(assertStrictTurns(session), 1, 'the retry must not open a second turn')
  assert.deepEqual(texts(session, 'user/message'), ['first try'])
  assert.equal(texts(session, 'assistant/message').at(-1), 'late answer')
  assert.equal(w.rt.state.exchanges.length, 1)
})
