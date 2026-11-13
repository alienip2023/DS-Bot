// A late node answer (the page turn already ended with E_TIMEOUT or Stop) must not be written
// inside an open Bot-to-Bot mirror turn: allocateTurn would close that turn as interrupted,
// and the exchange's own finish would then fail a strict restore. These tests drive the real
// startPageTurn / handleJoinedTurn / mirror writer and put the stored log through the real v4
// reader with recovery:'strict', validation:'current' — not a hand-written framing check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld, textRequest, types } from './joined-world.js'
import { handleJoinedTurn } from '../src/host/joined-turn.js'

const { sessionFormatCatalog } = await import('@deepseek-ai/dsh-session-format-catalog')

const settle = () => new Promise(resolve => setImmediate(resolve))
const drain = async (times = 8) => { for (let i = 0; i < times; i += 1) await settle() }

/**
 * The real reader a restart uses. Every stored row goes through encodeCurrentEvent ->
 * decodeRow and finish(); a turn closed while another turn is open throws SessionFormatError
 * here, which is exactly what the verifier reproduces.
 */
function strictRestore(session) {
  const header = { ...session.header, delegationDepth: 0 }
  const reader = sessionFormatCatalog.createRestore(
    sessionFormatCatalog.encodeCurrentHeader(header, 0),
    { recovery: 'strict', validation: 'current' },
  )
  for (const event of session.log) {
    reader.decodeRow(sessionFormatCatalog.encodeCurrentEvent({
      type: event.type, seq: event.seq, time: event.time, data: event.data,
      ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    }))
  }
  return reader.finish()
}

const texts = (session, type) => session.log
  .filter(event => event.type === type)
  .map(event => (type === 'user/message'
    ? event.data.content.map(part => part.text ?? '').join('')
    : event.data.message?.content?.map(part => part.text ?? '').join('') ?? ''))
const endKinds = session => session.log
  .filter(event => event.type === 'turn/end')
  .map(event => event.data.reason?.kind)

test('a late answer after E_TIMEOUT waits for the open Bot-to-Bot turn, then restores strictly', async () => {
  const w = makeWorld()
  w.rt.state.exchanges = []
  // Short page timeout only; the exchange below must outlive it so its turn is still open.
  w.rt.joinedTurnTimeoutMs = 50
  await w.prompt(textRequest('from the page', 'req-c'))
  await w.idle()   // the page turn times out and is closed with a visible failure line
  w.rt.joinedTurnTimeoutMs = 600_000

  const session = w.sessionOf('mirror-1')
  assert.equal(endKinds(session).length, 1, 'the page turn is closed before anything else writes')
  assert.equal(w.frames.length, 1)

  const pending = handleJoinedTurn(w.rt, {
    fromId: 'local', toId: w.bot.id, text: 'from the team', exchangeId: 'ex-c', role: 'request',
  })
  await drain()
  assert.equal(w.frames.length, 2, 'the Bot-to-Bot frame goes out while its mirror turn is open')

  // The node's answer to the timed-out page turn arrives while the exchange turn is open.
  w.reply(0, { text: 'page answer late' })
  await drain(2)
  assert.equal(texts(session, 'assistant/message').length, 1,
    'the late answer is queued, not written into the open exchange turn')
  assert.equal(endKinds(session).includes('interrupted'), false,
    'nothing was closed as interrupted by the late write')

  w.reply(1, { text: 'team answer' })
  assert.equal(await pending, 'ex-c')
  await drain()

  strictRestore(session)   // throws SessionFormatError on the old behaviour
  assert.equal(endKinds(session).length, 3)
  assert.deepEqual(texts(session, 'user/message'), ['from the page', 'from the team'])
  const answers = texts(session, 'assistant/message')
  assert.equal(answers.length, 3)
  assert.match(answers[0], /^⚠/)
  assert.equal(answers[1], 'team answer')
  assert.match(answers[2], /^↩ 节点迟到回复/)
})

test('a late answer after Stop also waits for the open Bot-to-Bot turn, then restores strictly', async () => {
  const w = makeWorld()
  w.rt.state.exchanges = []
  await w.prompt(textRequest('from the page', 'req-d'))
  await drain()
  w.cancel()
  await drain()

  const session = w.sessionOf('mirror-1')
  assert.equal(endKinds(session).length, 1, 'Stop closed the page turn')
  assert.match(texts(session, 'assistant/message')[0], /^⏹/)

  const pending = handleJoinedTurn(w.rt, {
    fromId: 'local', toId: w.bot.id, text: 'from the team', exchangeId: 'ex-d', role: 'request',
  })
  await drain()
  assert.equal(w.frames.length, 2)

  w.reply(0, { text: 'page answer after stop' })
  await drain(2)
  assert.equal(texts(session, 'assistant/message').length, 1,
    'the late answer waits for the exchange turn to close')

  w.reply(1, { text: 'team answer' })
  assert.equal(await pending, 'ex-d')
  await drain()

  strictRestore(session)
  assert.equal(endKinds(session).length, 3)
  assert.deepEqual(texts(session, 'user/message'), ['from the page', 'from the team'])
  const answers = texts(session, 'assistant/message')
  assert.equal(answers.length, 3)
  assert.match(answers[0], /^⏹/)
  assert.equal(answers[1], 'team answer')
  assert.match(answers[2], /^↩ 节点迟到回复/)
})

test('a late answer that arrives while an exchange is still queued restores strictly too', async () => {
  // The exchange arrives while the page turn is open, so its own write is queued; the page
  // turn then times out and the late answer is written before the queued exchange gets its
  // turn. Each write is still a whole turn, so the log must restore.
  const w = makeWorld()
  w.rt.state.exchanges = []
  w.rt.joinedTurnTimeoutMs = 50
  await w.prompt(textRequest('from the page', 'req-e'))
  w.rt.joinedTurnTimeoutMs = 600_000   // the exchange must outlive the page turn
  const pending = handleJoinedTurn(w.rt, {
    fromId: 'local', toId: w.bot.id, text: 'from the team', exchangeId: 'ex-e', role: 'request',
  })
  await drain()
  assert.equal(w.frames.length, 2, 'the exchange frame goes out behind the open page turn')

  await w.idle()   // page turn times out
  const session = w.sessionOf('mirror-1')
  w.reply(0, { text: 'page answer late' })
  await drain(2)
  assert.equal(endKinds(session).length, 2, 'the late answer is its own closed turn')

  w.reply(1, { text: 'team answer' })
  assert.equal(await pending, 'ex-e')
  await drain()

  strictRestore(session)
  assert.equal(endKinds(session).length, 3, 'the queued exchange writes one closed turn')
  assert.deepEqual(texts(session, 'user/message'), ['from the page', 'from the team'])
  const answers = texts(session, 'assistant/message')
  assert.equal(answers.length, 3)
  assert.match(answers[0], /^⚠/)
  assert.match(answers[1], /^↩ 节点迟到回复/)
  assert.equal(answers[2], 'team answer')
})
