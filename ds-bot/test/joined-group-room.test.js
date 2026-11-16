import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { install as installDelivery } from '../src/host/delivery.js'
import { createBotTurnReceiver, handleJoinedTurn } from '../src/host/joined-turn.js'
import { fakeContext } from './fake-ctx.js'
import { install as installStore } from '../src/host/store.js'

const drain = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)) }

function hub(t) {
  const registry = new EventEmitter()
  const frames = []
  const replies = []
  const warnings = []
  const shadow = {
    id: 'joined:n1:rb1', name: 'Node', origin: 'joined', type: 'remote-worker', sessionId: 'private-mirror',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' },
  }
  const sender = { id: 'sender', name: 'Sender', sessionId: 'sender-private' }
  const bots = { [shadow.id]: shadow, sender }
  const room = { id: 'room-1', name: 'Team', sessionId: 'room-session', sessions: { [shadow.id]: 'member-session' } }
  const sessions = new Map(['private-mirror', 'room-session'].map(id => [id, new Session(id)]))
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true }
  const rt = {
    ctx: fakeContext({ services: { 'remote-agent:registry': registry } }),
    state: { bots, exchanges: [], threads: {}, rooms: { [room.id]: room } },
    botOf: id => bots[id], chatOf: id => bots[id]?.sessionId,
    roomOf: id => rt.state.rooms[id], sessionOfRoom: room => room.sessionId,
    resolveAgent: async id => ({ session: sessions.get(id) }),
    hideBotUnusedTools() {},
    warn: (...args) => warnings.push(args),
    ledger: { importer() {}, records: () => [], append() {}, written: async () => {} },
  }
  rt.ctx.sessionController = { resolveAgent: async id => ({ agent: { session: sessions.get(id) } }) }
  installDelivery(rt)
  const deliver = rt.deliver
  rt.deliver = msg => msg.role === 'reply' ? (replies.push(msg), Promise.resolve()) : deliver(msg)
  rt.handleJoinedTurn = msg => handleJoinedTurn(rt, msg)
  const answer = () => registry.emit('botTurnResult', {
    nodeId: 'n1', exchangeId: frames.at(-1).payload.exchangeId, ok: true, text: 'done', roomId: room.id,
  })
  t.after(async () => { registry.emit('nodeOffline', { nodeId: 'n1' }); await drain() })
  return { rt, room, shadow, sender, frames, replies, warnings, sessions, answer, deliver }
}

test('group delivery to a joined shadow forwards the room identity and name', async t => {
  const w = hub(t)
  await w.rt.deliver({ toId: w.shadow.id, role: 'room', roomId: w.room.id, text: '@Node work', exchangeId: 'group' })
  assert.equal(w.frames[0].payload.roomId, w.room.id)
  assert.equal(w.frames[0].payload.roomName, w.room.name)
})

test('node group turns reuse a deterministic session separate from private chat and return roomId', async () => {
  const bot = { id: 'local', sessionId: 'private' }
  const calls = []
  const rt = {
    state: { bots: { local: bot } }, chatOf: () => bot.sessionId,
    sendUser: async args => { calls.push(args); rt.settleJoinedTurn(args.requestId, 'node answer') },
  }
  const accept = createBotTurnReceiver(rt)
  for (const exchangeId of ['first', 'second']) {
    const result = await accept({ remoteBotId: bot.id, exchangeId, roomId: ' room-1 ', roomName: ' Team ', text: 'work' })
    assert.equal(result.roomId, 'room-1')
  }
  assert.notEqual(calls[0].sessionId, rt.chatOf(bot.id))
  assert.match(calls[0].sessionId, /^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  assert.equal(calls[0].sessionId, calls[1].sessionId)
  assert.equal(calls[0].content[0].text, '[群 Team] work')
  await accept({ remoteBotId: bot.id, exchangeId: 'other', roomId: 'room-2', text: 'other work' })
  assert.notEqual(calls[0].sessionId, calls[2].sessionId)
  assert.equal(calls[2].content[0].text, '[群 room-2] other work')
})

for (const fromBot of [false, true]) {
  test(`a node answer returns to its group (Bot sender: ${fromBot})`, async t => {
    const w = hub(t)
    await w.rt.deliver({
      ...(fromBot ? { fromId: w.sender.id } : {}),
      toId: w.shadow.id, role: 'room', roomId: w.room.id, text: 'work', exchangeId: 'reply',
    })
    w.answer()
    await drain()
    assert.equal(w.replies.length, 1)
    assert.equal(w.replies[0].roomId, w.room.id)
    assert.equal(w.replies[0].text, 'done')
    assert.equal(w.sessions.get('private-mirror').log.length, 0)
    assert.ok(w.sessions.get('room-session').log.some(event => event.type === 'assistant/message'))
  })
}

test('a missing room falls back to private reply and mirror with a warning', async t => {
  const w = hub(t)
  delete w.rt.state.rooms[w.room.id]
  await handleJoinedTurn(w.rt, { fromId: w.sender.id, toId: w.shadow.id, roomId: w.room.id, text: 'work', defer: true })
  w.answer()
  await drain()
  assert.equal(w.replies[0].toId, w.sender.id)
  assert.equal(w.replies[0].roomId, undefined)
  assert.ok(w.warnings.some(args => /room/i.test(args[0])))
  assert.ok(w.sessions.get('private-mirror').log.some(event => event.type === 'assistant/message'))
})

test('room fields are trimmed strings and omitted from legacy private turns', async t => {
  const w = hub(t)
  for (const [index, fields] of [{ roomId: ' room-1 ', roomName: ' Team ' }, { roomId: ' ', roomName: {} }, { roomId: 123 }].entries()) {
    await handleJoinedTurn(w.rt, { toId: w.shadow.id, text: 'work', exchangeId: `trim-${index}`, defer: true, ...fields })
    const payload = w.frames.at(-1).payload
    if (index === 0) {
      assert.equal(payload.roomId, 'room-1')
      assert.equal(payload.roomName, 'Team')
    } else {
      assert.equal(Object.hasOwn(payload, 'roomId'), false)
      assert.equal(Object.hasOwn(payload, 'roomName'), false)
    }
    w.answer()
    await drain()
  }
})

test('group replies delivered through the real delivery entry settle the group waiter', async t => {
  const w = hub(t)
  const settled = []
  w.rt.roomWaiters = new Map([['group-wait', { resolve: text => settled.push(text) }]])
  w.rt.deliver = msg => { w.replies.push(msg); return w.deliver(msg) }
  await w.rt.deliver({ toId: w.shadow.id, role: 'room', roomId: w.room.id, text: 'work', exchangeId: 'group-wait' })
  w.answer()
  await drain()
  assert.deepEqual(settled, ['done'])
})

test('node group sessions are created and remain owned by their Bot after reindexing', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-remote-group-'))
  const disposers = []
  const rt = {
    home, statePath: join(home, 'state.json'), warn() {},
    ctx: { effect: run => { const dispose = run(); if (dispose) disposers.push(dispose) } },
  }
  installStore(rt)
  t.after(async () => { for (const dispose of disposers) await dispose(); await rm(home, { recursive: true, force: true }) })
  await rt.load()
  const bot = { id: 'local', name: 'Local', sessionId: 'private' }
  rt.state.bots.local = bot
  await rt.save()
  const created = []
  rt.createSession = async (title, options) => { created.push({ title, ...options }); return options.sessionId }
  const calls = []
  rt.sendUser = async args => {
    assert.equal(rt.selfOf(args.sessionId), bot.id)
    assert.equal(rt.isBotSession(args.sessionId), true)
    calls.push(args)
    rt.settleJoinedTurn(args.requestId, 'answer')
  }
  const accept = createBotTurnReceiver(rt)
  for (const exchangeId of ['before-save', 'after-save']) {
    const result = await accept({ remoteBotId: bot.id, roomId: 'room-1', roomName: 'Team', text: 'work', exchangeId })
    assert.equal(result.ok, true)
    await rt.save()
  }
  assert.equal(created.length, 1)
  assert.equal(created[0].sessionId, calls[0].sessionId)
  assert.notEqual(calls[0].sessionId, rt.chatOf(bot.id))
  assert.equal(calls[0].sessionId, calls[1].sessionId)
})

test('two joined members mirror concurrent group turns without interrupting each other', async t => {
  const w = hub(t)
  const other = { ...w.shadow, id: 'joined:n1:rb2', worker: { ...w.shadow.worker, remoteBotId: 'rb2' } }
  w.rt.state.bots[other.id] = other
  for (const [index, bot] of [w.shadow, other].entries()) {
    await w.rt.deliver({ toId: bot.id, roomId: w.room.id, role: 'room', text: 'work', exchangeId: `parallel-${index}` })
  }
  w.answer()
  await drain()
  w.rt.ctx.get('remote-agent:registry').emit('botTurnResult', { nodeId: 'n1', exchangeId: 'parallel-0', ok: true, text: 'first done' })
  await drain()
  const session = w.sessions.get('room-session')
  assert.equal(session.log.filter(event => event.type === 'turn/end').length, 2)
  assert.ok(session.log.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
  assert.equal(session.log.filter(event => event.type === 'assistant/message').length, 2)
})

test('concurrent node turns wait for their shared group session to be created', async () => {
  let ready
  const gate = new Promise(resolve => { ready = resolve })
  const bot = { id: 'local', name: 'Local', sessionId: 'private' }
  const calls = []
  let created = 0
  const rt = {
    state: { bots: { local: bot } }, chatOf: () => bot.sessionId,
    createSession: async (_title, { sessionId }) => { created += 1; await gate; return sessionId },
    sendUser: async args => { calls.push(args); rt.settleJoinedTurn(args.requestId, 'answer') },
  }
  const accept = createBotTurnReceiver(rt)
  const turns = ['one', 'two'].map(exchangeId => accept({ remoteBotId: bot.id, exchangeId, roomId: 'room-1', text: 'work' }))
  await drain()
  assert.equal(calls.length, 0)
  ready()
  assert.ok((await Promise.all(turns)).every(result => result.ok))
  assert.equal(created, 1)
  assert.equal(calls[0].sessionId, calls[1].sessionId)
})

test('a late group result follows the existing late room reply path', async t => {
  const w = hub(t)
  const late = []
  w.rt.lateRoomReply = async (...args) => late.push(args)
  w.rt.deliver = w.deliver
  await w.rt.deliver({ toId: w.shadow.id, roomId: w.room.id, role: 'room', text: 'work', exchangeId: 'late-group' })
  w.answer()
  await drain()
  assert.deepEqual(late, [['member-session', { role: 'room', roomId: w.room.id, exchangeId: 'late-group' }, 'done']])
})

test('a legacy node turn keeps its private session and original result shape', async () => {
  const bot = { id: 'local', sessionId: 'private' }
  const calls = []
  const rt = {
    state: { bots: { local: bot } }, chatOf: () => bot.sessionId,
    sendUser: async args => { calls.push(args); rt.settleJoinedTurn(args.requestId, 'answer') },
  }
  const accept = createBotTurnReceiver(rt)
  assert.deepEqual(await accept({ remoteBotId: bot.id, exchangeId: 'legacy', roomId: ' ', roomName: 'Ignored', text: 'work' }), {
    ok: true, exchangeId: 'legacy', text: 'answer',
  })
  assert.equal(calls[0].sessionId, 'private')
  assert.equal(calls[0].content[0].text, 'work')
})
