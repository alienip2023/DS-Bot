// A message sent from the page to a joined Bot's mirror Session goes to its node, not to a local
// model: the Session is found through `bySessionId` (the mirror Session is not the Bot's id), the
// user's message is on the page, and the turn is dispatched as a bot/turn frame. A Session that is
// not a joined Bot's mirror takes the ordinary prompt path. (createSendUser, channel.js.)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSendUser } from '../src/host/channel.js'
import { makeWorld, types } from './joined-world.js'

const drain = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)) }
const text = value => [{ type: 'text', text: value }]

// The parts of a runtime the ordinary (non-joined) path reads.
function withLocalPath(rt) {
  Object.assign(rt, {
    pastOwners: new Map(), chatOwners: new Map(), groupOwners: new Map(),
    roomOf: () => undefined, ensureCapabilities: async () => {},
  })
  return rt
}

test('a send to the mirror Session id is dispatched to the node, not prompted locally', async () => {
  const w = makeWorld({ tracker: true })
  const sendUser = createSendUser(withLocalPath(w.rt), { ctx: w.rt.ctx })
  // The mirror Session's id is not the Bot's id: only bySessionId finds the Bot.
  assert.notEqual(w.bot.sessionId, w.bot.id)
  assert.equal(w.rt.botOf(w.bot.sessionId), undefined)
  assert.equal(w.rt.bySessionId(w.bot.sessionId), w.bot)

  const result = await sendUser({ sessionId: w.bot.sessionId, content: text('hello'), requestId: 'req-1' })
  await drain()
  assert.deepEqual(result, { accepted: true })
  assert.equal(w.frames.length, 1, 'bot/turn went to the node')
  assert.equal(w.frames[0].type, 'bot/turn')
  assert.equal(w.frames[0].payload.text, 'hello')
  assert.equal(w.originalCalls.length, 0, 'the local prompt was not called')
  assert.ok(types(w.sessionOf(w.bot.sessionId)).includes('user/message'), 'the user message is on the page')
})

test('a send to a Session that is no joined Bot\'s mirror takes the ordinary prompt path', async () => {
  const w = makeWorld({ tracker: true })
  const sendUser = createSendUser(withLocalPath(w.rt), { ctx: w.rt.ctx })
  assert.equal(w.rt.bySessionId('ordinary-1'), undefined)
  await sendUser({ sessionId: 'ordinary-1', content: text('hello'), requestId: 'req-2' })
  await drain()
  assert.equal(w.frames.length, 0, 'nothing is dispatched to a node')
  assert.equal(w.originalCalls.length, 1, 'the ordinary prompt is called once')
  assert.equal(w.originalCalls[0][0].sessionId, 'ordinary-1')
})

test('an attachment a node Bot cannot take is refused with the reason, not dropped so that only the words go out', async () => {
  const w = makeWorld({ tracker: true })
  const sendUser = createSendUser(withLocalPath(w.rt), { ctx: w.rt.ctx })
  await assert.rejects(
    sendUser({ sessionId: w.bot.sessionId, content: [{ type: 'text', text: 'look' }, { type: 'image', url: 'x' }], requestId: 'req-img' }),
    error => error.code === 'session/joined-attachment-unsupported' && /图片没有内容/.test(error.message),
  )
  assert.equal(w.frames.length, 0, 'nothing was sent')
})
