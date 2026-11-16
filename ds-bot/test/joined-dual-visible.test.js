// DS Bot business-layer coverage only: the registry/receiver boundary bypasses RA validation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBotTurnReceiver, handleJoinedTurn } from '../src/host/joined-turn.js'
import { makeWorld, textRequest } from './joined-world.js'

const BODY = '  original body\n正文保持原样  '
const drain = () => new Promise(resolve => setImmediate(resolve))

function hubWorld(t, sender = { id: 'sender', name: 'X' }) {
  const w = makeWorld()
  if (sender) w.rt.state.bots[sender.id] = sender
  w.rt.botOf = id => w.rt.state.bots[id]
  w.rt.state.exchanges = []
  t.after(async () => {
    w.emitter.emit('nodeOffline', { nodeId: 'n1' })
    await drain()
  })
  w.send = (patch = {}) => handleJoinedTurn(w.rt, {
    fromId: 'sender', toId: w.bot.id, text: BODY, exchangeId: 'dual-visible', defer: true, ...patch,
  })
  return w
}

function mirrorPrompt(w) {
  return w.sessionOf('mirror-1').log.find(event => event.type === 'user/message').data
}

async function receive(turn) {
  const prompts = []
  const rt = {
    state: { bots: { local: { id: 'local', sessionId: 'node-chat' } } },
    chatOf: () => 'node-chat',
    sendUser: async args => {
      prompts.push(args)
      queueMicrotask(() => rt.settleJoinedTurn(args.requestId, 'node reply'))
    },
  }
  const accept = createBotTurnReceiver(rt)
  const result = await accept({ remoteBotId: 'local', exchangeId: 'node-exchange', text: BODY, ...turn })
  assert.deepEqual(result, { ok: true, exchangeId: 'node-exchange', text: 'node reply' })
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'node-chat')
  assert.equal(prompts[0].requestId, 'node-exchange')
  return prompts[0].content
}

test('node receiver prefixes a named sender and preserves the complete body', async () => {
  assert.deepEqual(await receive({ senderBotId: 'sender', senderName: 'X' }), [
    { type: 'text', text: `[来自 X] ${BODY}` },
  ])
})

for (const senderName of [undefined, null, '', '   ', 42]) {
  test(`node receiver preserves the original text without a usable senderName: ${JSON.stringify(senderName)}`, async () => {
    // Omitting both fields models an old RA dropping the optional identity fields.
    const turn = senderName === undefined ? {} : { senderBotId: 'sender', senderName }
    assert.deepEqual(await receive(turn), [{ type: 'text', text: BODY }])
  })
}

for (const [label, sender, senderName] of [
  ['display name', { id: 'sender', name: 'X' }, 'X'],
  ['missing sender', null, 'sender'],
  ['missing name', { id: 'sender' }, 'sender'],
  ['empty name', { id: 'sender', name: '' }, 'sender'],
]) {
  test(`Bot-to-Bot frame carries sender identity with ${label}, preserving text and exchangeId`, async t => {
    const w = hubWorld(t, sender)
    assert.equal(await w.send(), 'dual-visible')
    assert.deepEqual(w.frames, [{
      nodeId: 'n1', type: 'bot/turn',
      payload: {
        nodeId: 'n1', remoteBotId: 'rb1', exchangeId: 'dual-visible', text: BODY,
        senderBotId: 'sender', senderName,
      },
    }])
    assert.equal(mirrorPrompt(w).content[0].text, `[来自 ${senderName}] ${BODY}`)
  })
}

test('hub mirror prefixes the sender name and keeps joined:<exchangeId> as its rpcId', async t => {
  const w = hubWorld(t)
  await w.send()
  const prompt = mirrorPrompt(w)
  assert.deepEqual(prompt.content, [{ type: 'text', text: `[来自 X] ${BODY}` }])
  assert.equal(prompt.source.rpcId, 'joined:dual-visible')
})

test('hub mirror preserves the original text when no sender identity is available', async t => {
  const w = hubWorld(t, null)
  await w.send({ fromId: undefined })
  const prompt = mirrorPrompt(w)
  assert.deepEqual(prompt.content, [{ type: 'text', text: BODY }])
  assert.equal(prompt.source.rpcId, 'joined:dual-visible')
})

test('duplicate deferred exchangeId sends one frame, opens one mirror turn and replies once', async t => {
  const w = hubWorld(t)
  assert.equal(await w.send(), 'dual-visible')
  assert.equal(await w.send(), 'dual-visible')
  assert.equal(w.frames.length, 1)
  const session = w.sessionOf('mirror-1')
  assert.equal(session.log.filter(event => event.type === 'turn/start').length, 1)
  assert.equal(session.log.filter(event => event.type === 'turn/end').length, 0, 'defer returns before the node answers')
  w.reply(0, { text: 'node reply' })
  await drain()
  assert.equal(session.log.filter(event => event.type === 'turn/end').length, 1)
  assert.equal(w.rt.state.exchanges.length, 1)
  assert.equal(w.rt.state.exchanges[0].text, 'node reply')
})

test('page input keeps its original four-field frame and unsigned mirror text', async t => {
  const w = hubWorld(t)
  await w.prompt(textRequest(BODY, 'page-request'))
  const frame = w.frames[0]
  assert.equal(frame.type, 'bot/turn')
  assert.deepEqual(frame.payload, {
    nodeId: 'n1', remoteBotId: 'rb1', exchangeId: frame.payload.exchangeId, text: BODY,
  })
  assert.deepEqual(mirrorPrompt(w).content, [{ type: 'text', text: BODY }])
  w.reply(0)
  await w.idle()
})
