// A teammate's answer never steers into the running turn of the Bot that asked (work model,
// docs/plans/2026-11-24-work-model.md; this reverts fork.114): it waits for that conversation to be idle, and an idle
// Bot is woken by it once. An answer to a work the Bot waits on is not a message at all (handoffs.js resumeWork).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeBot, threadWorld } from './thread-t2-world.js'

async function pair(t) {
  const w = threadWorld()
  t.after(() => w.ctx.dispose?.())
  const asker = await makeBot(w, 'Asker')
  const helper = await makeBot(w, 'Helper')
  return { w, asker, helper, chat: w.rt.chatOf(asker.id) }
}
const reply = (w, helper, asker) => w.rt.deliver({ fromId: helper.id, toId: asker.id, role: 'reply', replyTo: 'x-1', text: 'done: 42' })
const has = (list, chat) => list.some(item => item.sessionId === chat && JSON.stringify(item.message).includes('done: 42'))

test('a reply to a Bot in the middle of a turn is never steered into that turn', async t => {
  const { w, asker, helper, chat } = await pair(t)
  w.rt.liveOf(chat).turn = 7
  await Promise.race([reply(w, helper, asker), new Promise(resolve => setTimeout(resolve, 100))])
  assert.equal(has(w.steers, chat), false, 'not steered into the running turn')
})

test('a reply to an idle Bot wakes it once, as before', async t => {
  const { w, asker, helper, chat } = await pair(t)
  await reply(w, helper, asker)
  assert.ok(has(w.followups, chat))
  assert.equal(has(w.steers, chat), false)
})

test('a request (not a reply) to a busy Bot keeps its own steer/queue choice', async t => {
  const { w, asker, helper, chat } = await pair(t)
  w.rt.liveOf(chat).turn = 3
  await w.rt.deliver({ fromId: helper.id, toId: asker.id, role: 'request', text: 'done: 42', steer: false })
  assert.ok(has(w.followups, chat))
  assert.equal(has(w.steers, chat), false)
})
