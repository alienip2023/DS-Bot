import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shadowId } from '../src/host/roster-join.js'
import { handleJoinedTurn, createBotTurnReceiver, install, BRIDGE_DOWN_TEXT } from '../src/host/joined-turn.js'
import { install as installDelivery } from '../src/host/delivery.js'

function shadowFor(nodeId, remoteBotId) {
  const id = shadowId(nodeId, remoteBotId)
  return {
    id,
    name: 'Alpha',
    origin: 'joined',
    worker: { home: 'remote', nodeId, remoteBotId, hostname: 'desk-1' },
  }
}

function registry() {
  const listeners = {}
  return {
    sent: [],
    send(nodeId, type, data) {
      this.sent.push({ nodeId, type, data })
      this.emit('botTurnResult', {
        nodeId,
        remoteBotId: data.remoteBotId,
        exchangeId: data.exchangeId,
        text: 'pong',
        ok: true,
      })
      return true
    },
    on(name, fn) { (listeners[name] ??= []).push(fn) },
    off(name, fn) { listeners[name] = (listeners[name] ?? []).filter((item) => item !== fn) },
    emit(name, payload) { for (const fn of [...(listeners[name] ?? [])]) fn(payload) },
  }
}

function controller(nodeId = 'node-a', remoteBotId = 'alpha') {
  const shadow = shadowFor(nodeId, remoteBotId)
  const local = { id: 'local', name: 'Local' }
  const bots = { [shadow.id]: shadow, [local.id]: local }
  const reg = registry()
  const dispatched = []
  const replies = []
  const rt = {
    ctx: { get(name) { return name === 'remote-agent:registry' ? reg : undefined } },
    state: { bots, exchanges: [] },
    botOf: (id) => bots[id],
    joinedTurnTimeoutMs: 50,
    tools: { dispatch: { execute(spec) { dispatched.push(spec); return { isError: false } } } },
    pickNode() { dispatched.push({ picked: true }) },
    async deliver(msg) { replies.push(msg); return msg.exchangeId },
  }
  rt.handleJoinedTurn = (msg) => handleJoinedTurn(rt, msg)
  return { rt, shadow, reg, dispatched, replies }
}

test('a joined shadow sends bot/turn and does not start an agent task', async () => {
  const turns = readFileSync(new URL('../src/host/turns.js', import.meta.url), 'utf8')
  const delivery = readFileSync(new URL('../src/host/delivery.js', import.meta.url), 'utf8')
  assert.match(turns, /return rt\.handleJoinedTurn\(\{ fromId, toId, text: text \?\? '', role, exchangeId, replyTo, work \}\)/)
  assert.match(turns, /return \{ ok: false, error: 'joined shadow cannot dispatch' \}/)
  assert.match(delivery, /return rt\.handleJoinedTurn\(\{ fromId, toId, text, role, exchangeId, replyTo, work \}\)/)

  const { rt, shadow, reg, dispatched, replies } = controller()
  const result = await handleJoinedTurn(rt, {
    fromId: 'local',
    toId: shadow.id,
    text: 'go',
    role: 'request',
    exchangeId: 'ex-1',
  })
  assert.equal(result, 'ex-1')
  assert.equal(reg.sent.length, 1)
  assert.equal(reg.sent[0].type, 'bot/turn')
  assert.equal(reg.sent[0].nodeId, 'node-a')
  assert.deepEqual(reg.sent[0].data, {
    nodeId: 'node-a',
    remoteBotId: 'alpha',
    exchangeId: 'ex-1',
    text: 'go',
  })
  assert.equal(reg.sent[0].data.mode, undefined)
  assert.deepEqual(dispatched, [])
  assert.equal(replies[0].role, 'reply')
  assert.equal(replies[0].toId, 'local')
  assert.equal(replies[0].replyTo, 'ex-1')
  assert.equal(replies[0].text, 'pong')
})

test('a missing remoteBotId is not rewritten into an agent task', async () => {
  const { rt, shadow, reg, dispatched } = controller()
  delete shadow.worker.remoteBotId
  const result = await handleJoinedTurn(rt, { fromId: 'local', toId: shadow.id, text: 'go', role: 'request' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'joined shadow missing remoteBotId')
  assert.equal(reg.sent.length, 0)
  assert.deepEqual(dispatched, [])
})

test('a bot id that is not on the controller roster is not dispatched', async () => {
  const { rt, reg } = controller()
  const result = await handleJoinedTurn(rt, { fromId: 'local', toId: 'missing', text: 'go', role: 'request' })
  assert.equal(result.error, 'joined shadow cannot dispatch')
  assert.equal(reg.sent.length, 0)
})

test('delivery routes a joined request and still refuses when the handler is missing', async () => {
  const shadow = shadowFor('node-a', 'alpha')
  const calls = []
  const rt = {
    ctx: {},
    state: { bots: { [shadow.id]: shadow }, exchanges: [] },
    botOf: (id) => (id === shadow.id ? shadow : undefined),
    handleRemoteTurn() { calls.push('remote') },
    handleJoinedTurn() { calls.push('joined'); return 'routed' },
    chatOf() { calls.push('chat') },
    hideBotUnusedTools() {},
  }
  installDelivery(rt)
  const routed = await rt.deliver({ fromId: 'local', toId: shadow.id, text: 'go', role: 'request' })
  assert.equal(routed, 'routed')
  const reply = await rt.deliver({ fromId: 'local', toId: shadow.id, text: 'back', role: 'reply' })
  assert.equal(reply.error, 'joined shadow cannot dispatch')
  delete rt.handleJoinedTurn
  const refused = await rt.deliver({ fromId: 'local', toId: shadow.id, text: 'go', role: 'request' })
  assert.equal(refused.error, 'joined shadow cannot dispatch')
  assert.deepEqual(calls, ['joined'])
})

test('the remote receiver only accepts a local non-worker bot and keeps the exchangeId', async () => {
  const rt = {
    state: {
      bots: {
        alpha: { id: 'alpha', name: 'Alpha', type: 'normal' },
        worker: { id: 'worker', name: 'Worker', type: 'remote-worker' },
      },
    },
    chatOf: (id) => `chat:${id}`,
    async deliver(msg) {
      assert.equal(msg.joinedTurn, true)
      assert.equal(msg.toId, 'alpha')
      rt.settleJoinedTurn(msg.exchangeId, 'from-session')
      return msg.exchangeId
    },
  }
  const accept = createBotTurnReceiver(rt, { timeoutMs: 30 })
  const ok = await accept({ nodeId: 'n', remoteBotId: 'alpha', exchangeId: 'e1', text: 'hi' })
  assert.equal(ok.ok, true)
  assert.equal(ok.exchangeId, 'e1')
  assert.equal(ok.text, 'from-session')
  assert.equal((await accept({ nodeId: 'n', remoteBotId: 'worker', exchangeId: 'e2', text: 'hi' })).error, 'bot-not-on-roster')
  assert.equal((await accept({ nodeId: 'n', remoteBotId: 'missing', exchangeId: 'e3', text: 'hi' })).error, 'bot-not-on-roster')
})

test('sidebar send does not prompt a local session when the bridge is down', async () => {
  const shadow = shadowFor('node-a', 'alpha')
  let prompted = 0
  const rt = {
    ctx: { get() { return undefined }, set() {} },
    state: { bots: { [shadow.id]: shadow }, exchanges: [] },
    botOf: (id) => (id === shadow.id ? shadow : undefined),
    sendUser: async () => { prompted += 1 },
  }
  install(rt)
  await assert.rejects(
    () => rt.sendUser({ sessionId: shadow.id, content: [{ type: 'text', text: 'hi' }], requestId: 'req-1' }),
    (err) => err.message === BRIDGE_DOWN_TEXT,
  )
  assert.equal(prompted, 0)
  assert.equal(shadow.worker.lastReply.text, BRIDGE_DOWN_TEXT)
})
