import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { createBotOnNode } from '../src/host/joined-create.js'
import { joinedChatPage, joinedUpdateBot, joinedDeleteBot } from '../src/host/joined-page.js'
import { handleJoinedTurn, listenBotStopResult } from '../src/host/joined-turn.js'
import { startPageTurn } from '../src/host/executor.js'
import { mirrorStateOf } from '../src/host/mirror.js'

function world() {
  const registry = new EventEmitter()
  registry.nodes = new Map([['n1', { nodeId: 'n1', online: true }]])
  registry.onlineNodes = () => [...registry.nodes.values()]
  const bot = { id: 'joined:n1:r1', origin: 'joined', sessionId: 'mirror', worker: { home: 'remote', nodeId: 'n1', remoteBotId: 'r1' } }
  const session = new Session('mirror')
  const replies = []
  const rt = {
    ctx: { get: () => registry },
    state: { bots: { [bot.id]: bot, sender: { id: 'sender' } }, exchanges: [] },
    botOf: id => rt.state.bots[id], save: async () => {},
    resolveAgent: async () => ({ session }),
    deliver: async message => replies.push(message),
  }
  const respond = (event, right, wrong) => {
    registry.send = (_nodeId, _type, payload) => {
      registry.emit(event, { ...payload, ok: true, ...wrong, nodeId: 'n2' })
      queueMicrotask(() => registry.emit(event, { ...payload, ok: true, ...right, nodeId: 'n1' }))
      return true
    }
  }
  return { rt, bot, registry, respond, session, replies }
}

test('a history result from another node cannot supply the requested Bot history', async () => {
  const w = world()
  w.respond('botHistoryResult', { sessionId: 'right', items: [{ kind: 'bot', text: 'right node' }] }, { sessionId: 'wrong', items: [{ kind: 'bot', text: 'wrong node' }] })
  const result = await joinedChatPage(w.rt, w.bot.id)
  assert.equal(result.sessionId, 'right')
  assert.equal(result.items[0].text, 'right node')
  assert.equal(w.registry.listenerCount('botHistoryResult'), 0)
})

test('a create result from another node cannot publish a shadow under the requested node', async () => {
  const w = world()
  w.respond('botCreateResult', { remoteBotId: 'right-id', name: 'Right' }, { remoteBotId: 'wrong-id', name: 'Wrong' })
  const result = await createBotOnNode(w.rt, { nodeId: 'n1', name: 'Remote' })
  assert.equal(result.ok, true)
  assert.equal(w.rt.state.bots['joined:n1:wrong-id'], undefined)
  assert.equal(w.rt.state.bots['joined:n1:right-id'].name, 'Right')
  assert.equal(w.registry.listenerCount('botCreateResult'), 0)
})

test('an update result from another node cannot mutate the shadow model', async () => {
  const w = world()
  w.respond('botUpdateResult', { model: 'right-model' }, { model: 'wrong-model' })
  await joinedUpdateBot(w.rt, w.bot.id, { model: 'right-model' })
  assert.equal(w.bot.model, 'right-model')
  assert.equal(w.bot.worker.model, 'right-model')
  assert.equal(w.registry.listenerCount('botUpdateResult'), 0)
})

test('a delete result from another node cannot acknowledge the requested delete', async () => {
  const w = world()
  w.respond('botDeleteResult', { ok: false, error: 'right-node-refused' }, { ok: true })
  assert.deepEqual(await joinedDeleteBot(w.rt, w.bot.id), { ok: false, error: 'right-node-refused' })
  assert.equal(w.registry.listenerCount('botDeleteResult'), 0)
})

test('a turn result from another node cannot write its answer into the mirror or sender receipt', async () => {
  const w = world()
  w.respond('botTurnResult', { text: 'right answer', seq: 7 }, { text: 'wrong answer', seq: 7 })
  const result = await handleJoinedTurn(w.rt, { fromId: 'sender', toId: w.bot.id, text: 'question', exchangeId: 'exchange-a' })
  assert.equal(result, 'exchange-a')
  const answers = w.session.log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text)
  assert.deepEqual(answers, ['right answer'])
  assert.deepEqual(w.replies.map(reply => reply.text), ['right answer'])
  assert.equal(w.registry.listenerCount('botTurnResult'), 0)
})


test('a stop result from another node cannot acknowledge the stop', async () => {
  const w = world()
  const wait = listenBotStopResult(w.registry, 'stop-a', 'n1', 1000)
  w.registry.emit('botStopResult', { requestId: 'stop-a', nodeId: 'n2', ok: true, stopped: true })
  w.registry.emit('botStopResult', { requestId: 'stop-a', nodeId: 'n1', ok: true, stopped: false })
  assert.equal((await wait.pending).stopped, false)
  assert.equal(w.registry.listenerCount('botStopResult'), 0)
})

test('a late result from another node cannot consume the real late reply or write the mirror', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = world()
  let frame
  w.registry.send = (_nodeId, _type, payload) => { frame = payload; return true }
  const page = startPageTurn({ rt: w.rt, bot: w.bot, session: w.session, text: 'question', requestId: 'page-a', timeoutMs: 5, state: mirrorStateOf(w.rt, w.bot.id, w.session) })
  t.mock.timers.tick(5)
  assert.equal(w.session.log.some(event => event.type === 'turn/end'), false)
  w.registry.emit('botTurnResult', { exchangeId: frame.exchangeId, nodeId: 'n2', ok: true, text: 'wrong late answer', seq: 7 })
  assert.equal(w.session.log.filter(event => event.type === 'assistant/message').length, 2)
  w.registry.emit('botTurnResult', { exchangeId: frame.exchangeId, nodeId: 'n1', ok: true, text: 'right late answer', seq: 7 })
  assert.equal((await page.done).ok, true)
  const answers = w.session.log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text)
  assert.equal(answers.length, 3)
  assert.match(answers[2], /right late answer/)
  assert.doesNotMatch(answers.join('\n'), /wrong late answer/)
  assert.equal(w.session.log.filter(event => event.type === 'turn/start').length, 1)
  assert.equal(w.registry.listenerCount('botTurnResult'), 0)
})
