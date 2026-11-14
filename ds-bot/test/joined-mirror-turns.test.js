// A Bot-to-Bot message to a joined shadow is a real exchange on that Bot's page too.
// These tests drive the real handleJoinedTurn against a real Session and a registry that
// records frames, so the mirror events are read from the Session log, not a stub.
import test from 'node:test'
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { handleJoinedTurn, settleStoppedTurns, BRIDGE_DOWN_TEXT } from '../src/host/joined-turn.js'
import { shadowId } from '../src/host/roster-join.js'

const { Session } = await import('@deepseek-ai/dsh-session')

const settle = () => new Promise(resolve => setImmediate(resolve))

function makeWorld({ timeoutMs = 50 } = {}) {
  const emitter = new EventEmitter()
  const frames = []
  const warnings = []
  const replies = []
  const shadow = {
    id: shadowId('n1', 'rb1'),
    name: 'Alpha',
    origin: 'joined',
    type: 'remote-worker',
    worker: { home: 'remote', nodeId: 'n1', remoteBotId: 'rb1', hostname: 'desk-1' },
    sessionId: 'mirror-1',
  }
  const local = { id: 'local', name: 'Local', type: 'normal' }
  const session = new Session('mirror-1')
  const registry = {
    send(nodeId, type, payload) {
      frames.push({ nodeId, type, payload })
      return true
    },
    on(name, fn) { emitter.on(name, fn) },
    off(name, fn) { emitter.off(name, fn) },
  }
  const rt = {
    ctx: { get: name => (name === 'remote-agent:registry' ? registry : undefined) },
    state: { bots: { [shadow.id]: shadow, local }, exchanges: [] },
    botOf: id => (id === shadow.id ? shadow : id === local.id ? local : undefined),
    joinedTurnTimeoutMs: timeoutMs,
    resolveAgent: async () => ({ session }),
    warn: (...args) => { warnings.push(args) },
    async deliver(msg) { replies.push(msg); return msg.exchangeId },
  }
  const answer = (patch = {}) => emitter.emit('botTurnResult', {
    exchangeId: frames.at(-1).payload.exchangeId, ok: true, text: 'pong', seq: 3, ...patch,
  })
  const offline = () => emitter.emit('nodeOffline', { nodeId: 'n1' })
  return { rt, shadow, local, session, frames, warnings, replies, emitter, answer, offline }
}

const events = session => session.log.map(event => event.type)
const texts = (session, type) => session.log
  .filter(event => event.type === type)
  .map(event => {
    if (type === 'user/message') return event.data.content.map(part => part.text ?? '').join('')
    return event.data.message?.content?.map(part => part.text ?? '').join('') ?? ''
  })

test('a Bot-to-Bot message shows on the joined page and the answer lands there', async () => {
  const w = makeWorld()
  const pending = handleJoinedTurn(w.rt, {
    fromId: w.local.id, toId: w.shadow.id, text: 'hello from the team', exchangeId: 'ex-1', role: 'request',
  })
  await settle()
  assert.equal(w.frames.length, 1, 'the frame still goes to the node')
  assert.equal(w.frames[0].type, 'bot/turn')
  w.answer()
  assert.equal(await pending, 'ex-1')

  const log = events(w.session)
  assert.deepEqual(log, ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
  assert.deepEqual(texts(w.session, 'user/message'), ['hello from the team'])
  assert.deepEqual(texts(w.session, 'assistant/message'), ['pong'])
  const prompt = w.session.log.find(event => event.type === 'user/message')
  assert.equal(prompt.data.source.rpcId, 'joined:ex-1', 'the retry key is the exchange id')
  assert.equal(w.session.log.at(-1).data.reason.kind, 'completed')
  // The exchange record and its delivery to the sender are unchanged.
  assert.equal(w.rt.state.exchanges.length, 1)
  assert.equal(w.rt.state.exchanges[0].role, 'reply')
  assert.equal(w.rt.state.exchanges[0].text, 'pong')
  assert.equal(w.replies.length, 1)
  assert.equal(w.warnings.length, 0)
})

test('a timeout writes a visible failure on the page and keeps the exchange honest', async () => {
  const w = makeWorld({ timeoutMs: 20 })
  const result = await handleJoinedTurn(w.rt, {
    fromId: w.local.id, toId: w.shadow.id, text: 'anyone there', exchangeId: 'ex-2', role: 'request',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bot-turn-lost')
  const log = events(w.session)
  assert.deepEqual(log, ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
  assert.deepEqual(texts(w.session, 'user/message'), ['anyone there'])
  assert.match(texts(w.session, 'assistant/message')[0], /^⚠ 无法送达节点：/)
  assert.equal(w.session.log.at(-1).data.reason.kind, 'error')
  assert.equal(w.rt.state.exchanges.at(-1).text, BRIDGE_DOWN_TEXT)
  assert.equal(w.replies.at(-1).text, BRIDGE_DOWN_TEXT)
  assert.equal(w.shadow.worker.lastReply.text, BRIDGE_DOWN_TEXT)
})

test('a bridge that cannot send also leaves the request and the failure on the page', async () => {
  const w = makeWorld()
  const registry = w.rt.ctx.get('remote-agent:registry')
  registry.send = () => false
  const result = await handleJoinedTurn(w.rt, {
    fromId: w.local.id, toId: w.shadow.id, text: 'go', exchangeId: 'ex-3', role: 'request',
  })
  assert.equal(result.error, 'bridge-down')
  assert.deepEqual(texts(w.session, 'user/message'), ['go'])
  assert.match(texts(w.session, 'assistant/message')[0], /^⚠ 无法送达节点：/)
  assert.equal(w.session.log.at(-1).data.reason.kind, 'error')
})

test('the same exchange id never opens a second turn on the page', async () => {
  const w = makeWorld()
  const first = handleJoinedTurn(w.rt, {
    fromId: w.local.id, toId: w.shadow.id, text: 'once', exchangeId: 'ex-4', role: 'request',
  })
  await settle()
  w.answer()
  assert.equal(await first, 'ex-4')
  assert.equal(w.session.log.filter(event => event.type === 'turn/start').length, 1)

  // The retry goes out again, but the page keeps exactly one turn for it.
  const retry = handleJoinedTurn(w.rt, {
    fromId: w.local.id, toId: w.shadow.id, text: 'once', exchangeId: 'ex-4', role: 'request',
  })
  await settle()
  assert.equal(w.frames.length, 2)
  w.answer({ text: 'pong again' })
  assert.equal(await retry, 'ex-4')
  assert.equal(w.session.log.filter(event => event.type === 'turn/start').length, 1)
  assert.deepEqual(texts(w.session, 'assistant/message'), ['pong'])
  // One row per exchange: the retry's answer fills the row the first delivery wrote.
  assert.equal(w.rt.state.exchanges.length, 1, 'the retry keeps one ledger row for the exchange')
  assert.equal(w.rt.state.exchanges[0].text, 'pong again', 'the answer the retry brought back is the one kept')
})

test('a mirror that cannot be opened only warns and never blocks the dispatch', async () => {
  const w = makeWorld()
  w.rt.resolveAgent = async () => { throw new Error('damaged mirror log') }
  const pending = handleJoinedTurn(w.rt, {
    fromId: w.local.id, toId: w.shadow.id, text: 'still deliver', exchangeId: 'ex-5', role: 'request',
  })
  await settle()
  assert.equal(w.frames.length, 1, 'the node still gets the message')
  w.answer()
  assert.equal(await pending, 'ex-5', 'the delivery result is unaffected')
  assert.equal(w.warnings.length, 1)
  assert.match(w.warnings[0][0], /was not mirrored/)
  assert.equal(w.session.log.length, 0, 'nothing was written to the broken mirror')
  assert.equal(w.rt.state.exchanges.at(-1).text, 'pong', 'the exchange record is still written')
})

// stop_bot succeeded for this node. The exchange still in flight must be settled as stopped
// by that exchange, not left waiting for nodeOffline to write the bridge-down line.
test('stop 成功后，迟到的 nodeOffline 不再补发「副机仍在执行，桥已断」', async () => {
  const w = makeWorld()
  const pending = handleJoinedTurn(w.rt, {
    fromId: w.local.id, toId: w.shadow.id, text: 'keep going', exchangeId: 'ex-stop', role: 'request',
  })
  await settle()
  assert.equal(w.frames.length, 1, 'the turn reached the node before it was stopped')

  const settled = settleStoppedTurns(w.rt.ctx.get('remote-agent:registry'), 'n1')
  assert.equal(settled, 1, 'the exchange still in flight is settled by the stop')
  assert.deepEqual(await pending, { ok: false, error: 'stopped' })

  assert.equal(w.session.log.at(-1).data.reason.kind, 'aborted', 'the mirror closes as stopped, not failed')
  const stopped = w.rt.state.exchanges.at(-1)
  assert.equal(stopped.role, 'reply')
  assert.equal(stopped.text === BRIDGE_DOWN_TEXT, false, 'a stop is not reported as a bridge that went down')
  assert.equal(w.replies.length, 1, 'the sender is told once that the exchange was stopped')
  assert.equal(w.replies[0].text === BRIDGE_DOWN_TEXT, false)
  assert.equal(stopped.text, '已停止', 'the ledger keeps the stop as no answer, so a late failure cannot overwrite it')

  const written = w.session.log.length
  const replies = w.replies.length
  w.offline()
  w.answer({ text: 'late result the stop already closed' })
  await settle()
  assert.equal(w.session.log.length, written, 'a late nodeOffline writes nothing more')
  assert.equal(w.replies.length, replies, 'a late result is not delivered to the sender')
  assert.equal(texts(w.session, 'assistant/message').some(text => text === BRIDGE_DOWN_TEXT), false)
  assert.equal(texts(w.session, 'assistant/message').includes('late result the stop already closed'), false)

  // Stopping again finds nothing still in flight and writes nothing again.
  assert.equal(settleStoppedTurns(w.rt.ctx.get('remote-agent:registry'), 'n1'), 0)
  assert.equal(w.session.log.length, written)
})

test('stopping one node does not settle an exchange still in flight on another node', async () => {
  const w = makeWorld()
  const pending = handleJoinedTurn(w.rt, {
    fromId: w.local.id, toId: w.shadow.id, text: 'not yours', exchangeId: 'ex-other', role: 'request',
  })
  await settle()
  assert.equal(settleStoppedTurns(w.rt.ctx.get('remote-agent:registry'), 'n-other'), 0)
  w.answer()
  assert.equal(await pending, 'ex-other')
  assert.equal(w.session.log.at(-1).data.reason.kind, 'completed', 'the other node\'s stop left this exchange alone')
})
