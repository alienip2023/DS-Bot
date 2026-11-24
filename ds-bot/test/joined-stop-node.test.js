// Stop on a node Bot's page really ends the work on the node (bot/stop), as it does for a local Bot, instead of
// only ending the wait on this host. A node that cannot be reached or does not answer is logged (rt.warn); the page is
// a copy of the node Bot's chat (W4), so a node that did not stop shows there as still running.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld as makeJoinedWorld, textRequest, types } from './joined-world.js'

// The composer waits a moment for an immediate node refusal (joined-prompt.js REFUSAL_WAIT_MS); keep it short here.
const makeWorld = (options) => { const w = makeJoinedWorld(options); w.rt.joinedRefusalWaitMs = 5; return w }
const ticks = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)) }
const notes = w => w.sessionOf('mirror-1').log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text).filter(text => text.startsWith('⚠ 停止'))
// The warnings that say the node did not stop: [bot name, reason].
const notStopped = w => w.warnings.filter(args => args[0] === 'ds-bot: %s did not stop on its node: %s').map(args => args.slice(1))

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

test('a Stop the node cannot take is logged with its reason, and nothing is written on the page', async () => {
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('long work', 'req-1'))
  await w.cancel()
  await ticks()
  const stop = w.frames.find(frame => frame.type === 'bot/stop')
  assert.deepEqual(notStopped(w), [], 'nothing is said before the node answers')
  w.emitter.emit('botStopResult', { requestId: stop.payload.requestId, nodeId: 'n1', ok: false, stopped: false, error: 'bot-stop-unavailable' })
  await ticks()
  // The page is a copy of the node Bot's chat (W4): the node's own chat shows it still running; here it is a warning.
  assert.deepEqual(notStopped(w), [[w.bot.name, 'bot-stop-unavailable']])
  assert.deepEqual(types(w.sessionOf('mirror-1')), [])
  assert.equal(w.rt.joinedInFlight.size, 0, 'the wait here is over all the same')
})

test('a node that is offline when Stop is pressed is logged as not online, and nothing is written on the page', async () => {
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('long work', 'req-1'))
  await w.cancel()
  await ticks()
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  await ticks()
  // The page is a copy of the node Bot's chat (W4): nothing is written here; the warning names the reason.
  assert.deepEqual(notStopped(w), [[w.bot.name, '节点不在线']])
  assert.deepEqual(types(w.sessionOf('mirror-1')), [])
})

test('stop_bot already waited for the node: the page stop it triggers does not send a second bot/stop', async () => {
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('long work', 'req-1'))
  w.rt.stopJoinedTurn(w.bot.id, { notifyNode: false })
  await ticks()
  assert.equal(w.frames.filter(frame => frame.type === 'bot/stop').length, 0)
})

test('joinedTurnsRunning sees a page turn, a steer and a Bot-to-Bot or group exchange that is out on the node', async () => {
  const { joinedTurnsRunning, listenBotTurnResult } = await import('../src/host/joined-turn.js')
  const w = makeWorld({ tracker: true })
  assert.equal(joinedTurnsRunning(w.rt, w.bot), false)
  const registry = w.rt.ctx.get('remote-agent:registry')
  const wait = listenBotTurnResult(registry, 'exchange-1', 'n1', 1000, 'rb1')
  assert.equal(joinedTurnsRunning(w.rt, w.bot), true, 'an exchange with no page turn: a group round, or another Bot asking')
  wait.cancel()
  assert.equal(joinedTurnsRunning(w.rt, w.bot), false)
  await w.prompt(textRequest('long work', 'req-1'))
  assert.equal(joinedTurnsRunning(w.rt, w.bot), true)
})
