// msg-s2: a second message to a joined Bot is accepted at once, shown at once, and starts
// only when the running turn ends. A turn that itself times out leaves a visible row and frees the Bot.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeWorld, types } from './joined-world.js'
import { createSendUser } from '../src/host/channel.js'

const MIRROR = 'mirror-1'
const userTexts = session => session.log.filter(e => e.type === 'user/message').map(e => (e.data.content ?? e.data.message?.content)[0].text)
const assistantTexts = session => session.log.filter(e => e.type === 'assistant/message').map(e => e.data.message.content[0].text)
const sleep = ms => new Promise(r => setTimeout(r, ms))

describe('msg-s2: a second message queues behind the running joined turn', () => {
  it('is accepted within 5s, visible at once, and starts only after the first turn ends', async () => {
    const w = makeWorld({ tracker: true })
    const sendUser = createSendUser(w.rt)
    await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'first' }], requestId: 'r1' })
    assert.equal(w.frames.length, 1)

    const t0 = Date.now()
    const ack = await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'second' }], requestId: 'r2' })
    const accepted = Date.now() - t0
    assert.ok(accepted < 5000)
    assert.equal(ack.accepted, true)
    assert.deepEqual(userTexts(w.sessionOf(MIRROR)), ['first', 'second'], 'second is on the timeline at once')

    await sleep(200)
    assert.equal(w.frames.length, 1, 'second must not run before the first turn ends')

    w.reply(0)
    for (let i = 0; i < 40 && w.frames.length < 2; i++) await sleep(25)
    assert.equal(w.frames.length, 2, 'second starts once the first ends')
    assert.equal(w.frames[1].payload.text, 'second')
    assert.deepEqual(userTexts(w.sessionOf(MIRROR)), ['first', 'second'], 'no duplicate user row')

    w.reply(1)
    await w.idle()
    await sleep(100)
    assert.equal(w.rt.joinedInFlight.has(w.bot.id), false)
  })

  it('a turn that times out leaves a visible row, releases the queue, and the Bot stays usable', async () => {
    const w = makeWorld({ tracker: true, timeoutMs: 1000 })
    const sendUser = createSendUser(w.rt)
    await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'long' }], requestId: 'r1' })
    await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'next' }], requestId: 'r2' })
    for (let i = 0; i < 80 && w.frames.length < 2; i++) await sleep(50)
    assert.equal(w.frames.length, 2, 'the queue released after the timeout')
    assert.ok(assistantTexts(w.sessionOf(MIRROR)).some(t => t.includes('超时')), 'a visible timeout row')
    w.reply(1)
    await w.idle()
    await sendUser({ sessionId: w.bot.id, content: [{ type: 'text', text: 'again' }], requestId: 'r3' })
    assert.equal(w.frames.length, 3, 'the Bot is usable afterwards')
    assert.ok(types(w.sessionOf(MIRROR)).length > 0)
    w.reply(2)
    await w.idle()
  })
})
