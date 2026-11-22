// A node Bot's background task result reaches the hub's page: the node sends one bot/message
// (reportTaskToHub), the hub writes it as a marked turn of the Bot's mirror Session
// (handleNodeMessage → handleNodeReport), after any turn that is open. An older hub drops it at the
// depth check; a Bot the hub never asked, or a link that is down, sends nothing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleNodeMessage } from '../src/host/bot-network.js'
import { createBotTurnReceiver, reportTaskToHub } from '../src/host/joined-turn.js'
import { TASK_RESULT_MARK } from '../src/host/mirror.js'
import { makeWorld, textRequest, types } from './joined-world.js'

const ticks = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)) }
const assistantTexts = session => session.log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text)

test('reportTaskToHub sends one reply at the depth cap with the Bot as both ends, only for a Bot the hub asked', () => {
  const sent = []
  const rt = { hubAskedBots: new Set(['b1']), botNetwork: { nodeId: 'n1', send: payload => { sent.push(payload); return true } } }
  const bot = { id: 'b1', name: 'Worker' }
  assert.equal(reportTaskToHub(rt, bot, '  done: 3 files  '), true)
  assert.equal(sent.length, 1)
  assert.deepEqual([sent[0].kind, sent[0].depth, sent[0].text, sent[0].from, sent[0].to], ['reply', 3, 'done: 3 files', { id: 'b1', name: 'Worker', nodeId: 'n1' }, { id: 'b1', name: 'Worker', nodeId: 'hub' }])
  assert.equal(reportTaskToHub(rt, { id: 'other', name: 'Other' }, 'x'), false, 'a Bot the hub never asked')
  assert.equal(reportTaskToHub(rt, bot, '   '), false, 'nothing to say')
  assert.equal(reportTaskToHub({ ...rt, botNetwork: { nodeId: 'n1', send: () => false } }, bot, 'x'), false, 'link down')
  assert.equal(reportTaskToHub({ hubAskedBots: rt.hubAskedBots }, bot, 'x'), false, 'no network')
})

const report = (w, over = {}) => ({
  kind: 'reply', depth: 3, exchangeId: 'rep-1', text: 'build finished',
  from: { id: 'rb1', name: 'Joined', nodeId: 'n1' }, to: { id: 'rb1', name: 'Joined', nodeId: 'hub' }, ...over,
})

test('the hub writes a node report as a marked turn of the Bot\'s mirror Session, once', async () => {
  const w = makeWorld({ tracker: true })
  await handleNodeMessage(w.rt, report(w))
  await handleNodeMessage(w.rt, report(w))   // a replayed frame
  const session = w.sessionOf('mirror-1')
  assert.equal(session.log.filter(event => event.type === 'turn/start').length, 1)
  assert.deepEqual(assistantTexts(session), [`${TASK_RESULT_MARK}\n\nbuild finished`])
  assert.equal(w.frames.length, 0, 'nothing goes back to the node')
})

test('a report waits while a page turn is open and is written after it', async () => {
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('go', 'req-1'))
  await handleNodeMessage(w.rt, report(w))
  const session = w.sessionOf('mirror-1')
  assert.equal(assistantTexts(session).some(text => text.startsWith(TASK_RESULT_MARK)), false, 'the open turn is not closed under the report')
  assert.equal(types(session).filter(type => type === 'turn/end').length, 0)
  w.reply(0)
  await ticks()
  assert.equal(types(session).filter(type => type === 'turn/end').length, 2)
  assert.equal(assistantTexts(session).filter(text => text.startsWith(TASK_RESULT_MARK)).length, 1)
  assert.ok(assistantTexts(session).at(-1).startsWith(TASK_RESULT_MARK), 'it is the last turn')
})

test('a report for a Bot the hub does not know, or a plain reply at the cap, is dropped', async () => {
  const w = makeWorld({ tracker: true })
  await handleNodeMessage(w.rt, report(w, { from: { id: 'zzz', name: 'X', nodeId: 'n1' }, to: { id: 'zzz', name: 'X', nodeId: 'hub' } }))
  await handleNodeMessage(w.rt, report(w, { exchangeId: 'rep-2', to: { id: 'rb1', name: 'Joined', nodeId: 'n1' } }))
  assert.equal(w.sessionOf('mirror-1').log.length, 0)
  assert.equal(w.frames.length, 0)
})

test('a report whose words a turn just delivered is not sent, and not shown twice on the hub', async () => {
  // node side: the answer already went to the hub as a turn's result
  const sent = []
  const rt = { hubAskedBots: new Set(['b1']), botNetwork: { nodeId: 'n1', send: payload => { sent.push(payload); return true } }, state: { bots: {} } }
  const accept = createBotTurnReceiver(rt, { timeoutMs: 1000 })
  rt.state.bots.b1 = { id: 'b1', name: 'Worker', type: 'local' }
  rt.chatOf = () => 's1'
  rt.sendUser = async () => {}
  const done = accept({ remoteBotId: 'b1', exchangeId: 'e1', text: 'go' })
  await ticks()
  rt.settleJoinedTurn('e1', 'P1 2026-11-22T19:56:45Z')
  await done
  assert.equal(reportTaskToHub(rt, { id: 'b1', name: 'Worker' }, 'P1 2026-11-22T19:56:45Z'), false, 'same words, already delivered')
  assert.equal(sent.length, 0)
  assert.equal(reportTaskToHub(rt, { id: 'b1', name: 'Worker' }, 'something new'), true)

  // hub side (an older node sends it anyway): the page already has those words
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('go', 'req-1'))
  w.reply(0, { text: 'P1 2026-11-22T19:56:45Z' })
  await ticks()
  await handleNodeMessage(w.rt, report(w, { exchangeId: 'rep-dup', text: 'P1 2026-11-22T19:56:45Z' }))
  const texts = w.sessionOf('mirror-1').log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text)
  assert.equal(texts.filter(text => text.includes('P1 2026-11-22T19:56:45Z')).length, 1, 'shown once')
  await handleNodeMessage(w.rt, report(w, { exchangeId: 'rep-new', text: 'a different result' }))
  assert.ok(w.sessionOf('mirror-1').log.some(event => event.type === 'assistant/message' && event.data.message.content[0].text.startsWith(TASK_RESULT_MARK)))
})

test('a report the link could not take is retried until it goes out, once on the hub', async () => {
  let up = false
  const sent = []
  const network = { nodeId: 'n1', send: payload => { if (!up) return false; sent.push(payload); return true } }
  const rt = { hubAskedBots: new Set(['b1']), botNetwork: network, taskReportRetryMs: 5 }
  assert.equal(reportTaskToHub(rt, { id: 'b1', name: 'Worker' }, 'finished while the link was down'), false, 'not sent now')
  assert.equal(sent.length, 0)
  up = true
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(sent.length, 1, 'it goes out when the link is back')
  assert.equal(sent[0].text, 'finished while the link was down')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(sent.length, 1, 'and only once')
})

test('a Bot the hub asked stays asked across a restart: it is remembered on its row', () => {
  const sent = []
  const network = { nodeId: 'n1', send: payload => { sent.push(payload); return true } }
  const bot = { id: 'b1', name: 'Worker', hubAskedAt: 123 }   // as saved before the node restarted
  assert.equal(reportTaskToHub({ botNetwork: network }, bot, 'a task finished after the restart'), true)
  assert.equal(sent.length, 1)
  assert.equal(reportTaskToHub({ botNetwork: network }, { id: 'b2', name: 'Never asked' }, 'x'), false)
})
