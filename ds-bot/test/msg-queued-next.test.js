// msg-s2: a second message to a joined Bot is accepted at once, queued, and starts only when the
// running turn ends. A turn that itself outlives the timeout is let go and frees the Bot.
// The page is a copy of the node Bot's chat (W4): the hub writes nothing on it here.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeWorld, types } from './joined-world.js'
import { createSendUser } from '../src/host/channel.js'

const MIRROR = 'mirror-1'
// How the n-th bot/turn frame's message ended (its tracker entry).
const outcome = (w, index) => { const entry = w.rt.turnTracker.get(w.frames[index].payload.exchangeId); return [entry.status, entry.error] }
const sleep = ms => new Promise(r => setTimeout(r, ms))

describe('msg-s2: a second message queues behind the running joined turn', () => {
  it('is accepted within 5s, queued at once, and starts only after the first turn ends', async () => {
    const w = makeWorld({ tracker: true })
    const sendUser = createSendUser(w.rt)
    await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'first' }], requestId: 'r1' })
    assert.equal(w.frames.length, 1)

    const t0 = Date.now()
    const ack = await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'second' }], requestId: 'r2' })
    const accepted = Date.now() - t0
    assert.ok(accepted < 5000)
    assert.equal(ack.accepted, true)
    // The page is a copy of the node Bot's chat (W4): the second waits in the queue, nothing is written here.
    assert.equal(ack.queued, true)
    assert.deepEqual(w.rt._joinedNextQueues.get(w.bot.id).items.map(item => item.requestId), ['r2'])
    assert.deepEqual(types(w.sessionOf(MIRROR)), [])

    await sleep(200)
    assert.equal(w.frames.length, 1, 'second must not run before the first turn ends')

    w.reply(0)
    for (let i = 0; i < 40 && w.frames.length < 2; i++) await sleep(25)
    assert.equal(w.frames.length, 2, 'second starts once the first ends')
    assert.equal(w.frames[1].payload.text, 'second')
    assert.equal(w.rt._joinedNextQueues.has(w.bot.id), false, 'the queue is empty: the second is in flight now')
    assert.equal(w.rt.joinedInFlight.get(w.bot.id).requestId, 'r2')

    w.reply(1)
    await w.idle()
    await sleep(100)
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), false)
    assert.equal(w.frames.length, 2)
    assert.deepEqual(w.statuses(), [[MIRROR, true], [MIRROR, false], [MIRROR, true], [MIRROR, false]], 'running true / false once per message')
    assert.deepEqual(types(w.sessionOf(MIRROR)), [])
  })

  it('a turn that outlives the timeout is let go, releases the queue, and the Bot stays usable', async () => {
    const w = makeWorld({ tracker: true, timeoutMs: 1000 })
    const sendUser = createSendUser(w.rt)
    await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'long' }], requestId: 'r1' })
    await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'next' }], requestId: 'r2' })
    for (let i = 0; i < 80 && w.frames.length < 2; i++) await sleep(50)
    assert.equal(w.frames.length, 2, 'the queue released after the timeout')
    // The page is a copy of the node Bot's chat (W4): no timeout row; the stuck message's claim was aborted.
    assert.deepEqual(outcome(w, 0), ['failed', 'E_ABORTED'])
    assert.equal(w.rt.joinedInFlight.get(w.bot.id).requestId, 'r2')
    w.reply(1)
    await w.idle()
    await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'again' }], requestId: 'r3' })
    assert.equal(w.frames.length, 3, 'the Bot is usable afterwards')
    w.reply(2)
    await w.idle()
    assert.deepEqual(outcome(w, 1), ['done', undefined])
    assert.deepEqual(outcome(w, 2), ['done', undefined])
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), false)
    assert.deepEqual(types(w.sessionOf(MIRROR)), [])
  })
})
