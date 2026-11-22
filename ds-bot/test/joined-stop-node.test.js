// Stop on a node Bot's page really ends the work on the node (bot/stop), as it does for a local Bot, instead of
// only ending the wait on this host. A node that cannot be reached or does not answer is said so on the page.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld, textRequest } from './joined-world.js'

const ticks = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)) }
const notes = w => w.sessionOf('mirror-1').log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text).filter(text => text.startsWith('⚠ 停止'))

test('the page Stop sends bot/stop to the node and ends the wait; a node that stopped it needs no note', async () => {
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('long work', 'req-1'))
  await w.cancel()
  await ticks()
  const stop = w.frames.find(frame => frame.type === 'bot/stop')
  assert.ok(stop, 'the node is told')
  assert.deepEqual([stop.payload.nodeId, stop.payload.remoteBotId], ['n1', 'rb1'])
  w.emitter.emit('botStopResult', { requestId: stop.payload.requestId, nodeId: 'n1', ok: true, stopped: true })
  await ticks()
  assert.equal(notes(w).length, 0)
  assert.equal(w.rt.joinedInFlight.size, 0, 'and the wait here is over too')
})

test('a Stop the node cannot take is said on the page, never left looking stopped', async () => {
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('long work', 'req-1'))
  await w.cancel()
  await ticks()
  const stop = w.frames.find(frame => frame.type === 'bot/stop')
  w.emitter.emit('botStopResult', { requestId: stop.payload.requestId, nodeId: 'n1', ok: false, stopped: false, error: 'bot-stop-unavailable' })
  await ticks()
  assert.equal(notes(w).length, 1)
  assert.match(notes(w)[0], /没能让节点停下：bot-stop-unavailable。它可能仍在运行/)
})

test('a node that is offline when Stop is pressed is said so', async () => {
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('long work', 'req-1'))
  await w.cancel()
  await ticks()
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  await ticks()
  assert.match(notes(w)[0] ?? '', /节点不在线/)
})

test('stop_bot already waited for the node: the page stop it triggers does not send a second bot/stop', async () => {
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('long work', 'req-1'))
  w.rt.stopJoinedTurn(w.bot.id, { notifyNode: false })
  await ticks()
  assert.equal(w.frames.filter(frame => frame.type === 'bot/stop').length, 0)
})
