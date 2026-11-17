import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { MODULES } from '../index.js'
import { directoryOf, publishDirectory, handleNodeMessage, install } from '../src/host/bot-network.js'
import { install as installTools } from '../src/host/tools.js'
import { handleJoinedTurn } from '../src/host/joined-turn.js'
import { fakeContext } from './fake-ctx.js'
import { makeWorld } from './joined-world.js'

function world(t, { network, registry = new EventEmitter() } = {}) {
  const local = { id: 'local', name: 'Local', role: 'Writer', sessionId: 'local-chat' }
  const joined = { id: 'joined:n2:b', name: 'Remote', role: 'Research', origin: 'joined', type: 'remote-worker', worker: { home: 'remote', nodeId: 'n2', remoteBotId: 'b' } }
  const peer = { id: 'peer:h:c', name: 'Peer', origin: 'peer', worker: { home: 'hub', hubId: 'h' } }
  const services = { 'remote-agent:registry': registry, 'remote-agent:bot-network': network }
  const ctx = fakeContext({ services })
  ctx.set = (key, value) => {
    if (!Object.hasOwn(services, key)) throw new Error(`cannot set property "${key}" without provide`)
    services[key] = value
  }
  const frames = []
  const joinedTurns = []
  const delivered = []
  const injected = []
  const warnings = []
  const saved = new Set()
  registry.onlineNodes = () => [{ nodeId: 'n1' }, { nodeId: 'n2' }]
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true }
  const rt = {
    ctx, state: { bots: { [local.id]: local, [joined.id]: joined, [peer.id]: peer }, rooms: {} },
    teamTools: [], live: new Map(), groupOwners: new Map(),
    load: async () => {},
    botOf: id => rt.state.bots[id], selfOf: () => local.id,
    findBot: name => Object.values(rt.state.bots).find(bot => bot.name === name),
    chatOf: id => rt.state.bots[id]?.sessionId, roomOf: () => undefined, isMain: () => false,
    statusOf: () => 'idle',
    onSaved: fn => { saved.add(fn); return () => saved.delete(fn) },
    handleJoinedTurn: async args => { joinedTurns.push(args) },
    deliver: async args => { delivered.push(args) },
    sendUser: async args => { injected.push(args) },
    warn: (...args) => warnings.push(args),
  }
  t.after(() => ctx.dispose())
  return { rt, ctx, registry, services, frames, local, joined, peer, joinedTurns, delivered, injected, warnings, saved }
}

const message = (patch = {}) => ({
  exchangeId: 'exchange-1', kind: 'ask',
  from: { id: 'source', name: 'Source', nodeId: 'n1' },
  to: { id: 'joined:n2:b', name: 'Remote', nodeId: 'n2' }, text: 'Hello', depth: 0,
  ...patch,
})

test('the plugin assembles the Bot network module', () => {
  assert.ok(MODULES.some(module => module.install === install))
})

test('directory includes local and joined Bots, omits peers, and falls back to id for a name', t => {
  const w = world(t)
  w.local.name = ''
  assert.deepEqual(directoryOf(w.rt), [
    { id: 'local', name: 'local', role: 'Writer', nodeId: 'hub' },
    { id: 'joined:n2:b', name: 'Remote', role: 'Research', nodeId: 'n2' },
  ])
})

test('publishDirectory sends the current directory to every online node', async t => {
  const w = world(t)
  await publishDirectory(w.rt)
  assert.deepEqual(w.frames.map(f => [f.nodeId, f.type]), [['n1', 'bot/directory'], ['n2', 'bot/directory']])
  for (const frame of w.frames) {
    assert.deepEqual(frame.payload.bots, directoryOf(w.rt))
    assert.equal(typeof frame.payload.at, 'number')
  }
})

test('hub passes joined routing arguments with defer:true (stubbed handler)', async t => {
  const w = world(t)
  await handleNodeMessage(w.rt, message())
  assert.deepEqual(w.joinedTurns, [{ fromId: 'source', toId: w.joined.id, text: 'Hello', role: 'default', exchangeId: 'exchange-1', senderName: 'Source', senderBotId: 'source', defer: true }])
  assert.equal(w.delivered.length, 0)
})

test('hub routes local asks and replies to the addressed Bot with the sender name', async t => {
  const w = world(t)
  await handleNodeMessage(w.rt, message({ to: { id: w.local.id } }))
  await handleNodeMessage(w.rt, message({ kind: 'reply', to: { id: w.local.id } }))
  assert.equal(w.delivered.length, 2)
  for (const sent of w.delivered) {
    assert.equal(sent.toId, w.local.id)
    assert.equal(sent.fromId, 'source')
    assert.equal(sent.fromName, 'Source')
    assert.equal(sent.text, 'Hello')
    assert.equal(sent.exchangeId, 'exchange-1')
  }
})

test('hub routes replies to joined Bots through joined delivery too', async t => {
  const w = world(t)
  await handleNodeMessage(w.rt, message({ kind: 'reply' }))
  assert.equal(w.joinedTurns.length, 1)
  assert.equal(w.joinedTurns[0].toId, w.joined.id)
  assert.equal(w.joinedTurns[0].defer, true)
  assert.equal(w.delivered.length, 0)
})

test('depth >= 3 is dropped before routing', async t => {
  const w = world(t)
  for (const depth of [3, 4]) await handleNodeMessage(w.rt, message({ depth }))
  assert.equal(w.joinedTurns.length, 0)
  assert.equal(w.delivered.length, 0)
})

test('duplicate ask is suppressed for 60 seconds, without suppressing replies', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const w = world(t)
  await handleNodeMessage(w.rt, message())
  await handleNodeMessage(w.rt, message())
  assert.equal(w.joinedTurns.length, 1)
  await handleNodeMessage(w.rt, message({ kind: 'reply' }))
  assert.equal(w.joinedTurns.length, 2)
  t.mock.timers.tick(60_000)
  await handleNodeMessage(w.rt, message())
  assert.equal(w.joinedTurns.length, 3)
})

test('unknown and peer destinations warn and never execute locally', async t => {
  const w = world(t)
  for (const id of ['missing', w.peer.id]) await handleNodeMessage(w.rt, message({ exchangeId: id, to: { id } }))
  assert.equal(w.joinedTurns.length, 0)
  assert.equal(w.delivered.length, 0)
  assert.equal(w.warnings.length, 2)
})

test('private Bots stay outside the network directory and cannot receive network messages', async t => {
  const w = world(t)
  w.local.private = true
  assert.equal(directoryOf(w.rt).some(bot => bot.id === w.local.id), false)
  await handleNodeMessage(w.rt, message({ to: { id: w.local.id } }))
  assert.equal(w.delivered.length, 0)
})

test('install provides an absent receiver and only sets and restores a provided receiver', async t => {
  for (const provided of [false, true]) {
    await t.test(provided ? 'already provided' : 'not provided', async t => {
      const w = world(t)
      const name = 'remote-agent:bot-message'
      const previous = () => null
      if (provided) w.ctx.provide(name, previous)
      const originalProvide = w.ctx.provide.bind(w.ctx)
      let offReceiver
      const provide = t.mock.method(w.ctx, 'provide', (name, value) => {
        offReceiver = t.mock.fn(originalProvide(name, value))
        return offReceiver
      })
      const set = t.mock.method(w.ctx, 'set')

      assert.doesNotThrow(() => install(w.rt))
      const receive = w.ctx.get(name)
      assert.equal(typeof receive, 'function')
      assert.notEqual(receive, previous)
      assert.equal(provide.mock.callCount(), provided ? 0 : 1)
      assert.equal(set.mock.callCount(), provided ? 1 : 0)
      const registration = (provided ? set : provide).mock.calls[0]
      assert.deepEqual(registration.arguments, [name, receive])

      const cleanup = await w.ctx.dispose()
      assert.ok(cleanup.every(result => result.status === 'fulfilled'))
      assert.equal(w.ctx.get(name), provided ? previous : undefined)
      assert.equal(set.mock.callCount(), provided ? 2 : 0)
      if (provided) assert.deepEqual(set.mock.calls[1].arguments, [name, previous])
      else assert.equal(offReceiver.mock.callCount(), 1)
      await w.ctx.dispose()
      assert.equal(set.mock.callCount(), provided ? 2 : 0)
      if (!provided) assert.equal(offReceiver.mock.callCount(), 1)
    })
  }
})

test('install registers the hub receiver and publishes on online, roster changes, and a 60s fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const w = world(t)
  install(w.rt)
  await Promise.resolve()
  await Promise.resolve()
  w.frames.length = 0
  assert.equal(typeof w.ctx.get('remote-agent:bot-message'), 'function')
  await w.ctx.get('remote-agent:bot-message')(message())
  assert.equal(w.joinedTurns.length, 1)
  w.registry.emit('nodeOnline', { nodeId: 'n1' })
  await Promise.resolve()
  assert.ok(w.frames.some(f => f.nodeId === 'n1'))
  w.frames.length = 0
  w.local.name = 'Renamed'
  for (const fn of w.saved) { fn(); fn() }
  w.registry.emit('roster', { nodeId: 'n2' })
  t.mock.timers.tick(999)
  assert.equal(w.frames.length, 0)
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.equal(w.frames.length, 2)
  assert.equal(w.frames[0].payload.bots[0].name, 'Renamed')
  w.frames.length = 0
  t.mock.timers.tick(60_000)
  await Promise.resolve()
  assert.equal(w.frames.length, 2)
  await w.ctx.dispose()
  assert.equal(w.registry.listenerCount('nodeOnline'), 0)
  assert.equal(w.registry.listenerCount('roster'), 0)
  assert.equal(w.saved.size, 0)
  assert.equal(w.ctx.get('remote-agent:bot-message'), undefined)
  w.frames.length = 0
  t.mock.timers.tick(60_000)
  await Promise.resolve()
  assert.equal(w.frames.length, 0)
})

// Minimal remote-agent send contract, copied here to avoid a cross-repository import.
function validateNodeMessage(payload, nodeId) {
  if (!payload.from || ['id', 'name', 'nodeId'].some(key => typeof payload.from[key] !== 'string' || payload.from[key].trim() === '') || payload.from.nodeId !== nodeId) {
    throw Object.assign(new Error('bot-message-invalid'), { code: 'bot-message-invalid' })
  }
}

function nodeWorld(t, { sendResult = true } = {}) {
  const sent = []
  const handlers = new Set()
  const target = { id: 'joined:n3:c', name: 'Scout', role: 'Research', nodeId: 'n3' }
  const network = {
    nodeId: 'n1',
    directory: () => [target],
    send: payload => { validateNodeMessage(payload, network.nodeId); sent.push(payload); return sendResult },
    onMessage: handler => { handlers.add(handler); return () => handlers.delete(handler) },
  }
  const w = world(t, { network })
  install(w.rt)
  installTools(w.rt)
  const tool = w.rt.teamTools.find(tool => tool.name === 'message_bot')
  const exec = { agent: { id: 'local-chat' } }
  return { ...w, network, sent, handlers, target, tool, exec }
}

test('install tolerates a network service without onMessage', t => {
  const network = { nodeId: 'n1', directory: () => [], send: () => true }
  const w = world(t, { network })
  assert.doesNotThrow(() => install(w.rt))
  assert.equal(w.rt.botNetwork, network)
})

test('hub-shaped network service does not break list_bots', async t => {
  const network = { sendDirectory: () => {}, sendMessage: () => {}, dispose: () => {} }
  const w = world(t, { network })
  install(w.rt)
  installTools(w.rt)
  const tool = w.rt.teamTools.find(tool => tool.name === 'list_bots')
  let result
  await assert.doesNotReject(async () => { result = await tool.execute({}, { agent: { id: 'local-chat' } }) })
  assert.match(result, /^Bots:\n- Local \(Writer, you\)/)
  assert.match(result, /\n- Remote \(Research\)/)
  assert.match(result, /\n- Peer \(/)
})

test('hub-shaped network service preserves the missing-Bot message_bot result', async t => {
  const network = { sendDirectory: () => {}, sendMessage: () => {}, dispose: () => {} }
  const w = world(t, { network })
  install(w.rt)
  installTools(w.rt)
  const tool = w.rt.teamTools.find(tool => tool.name === 'message_bot')
  let result
  await assert.doesNotReject(async () => { result = await tool.execute({ to: 'Scout', message: 'Hello' }, { agent: { id: 'local-chat' } }) })
  assert.equal(result, 'No Bot named Scout. Team: Local, Remote, Peer')
})

test('node-shaped network service still lists and routes to remote Bots', async t => {
  const w = nodeWorld(t)
  const list = w.rt.teamTools.find(tool => tool.name === 'list_bots')
  assert.match(await list.execute({}, w.exec), /Scout.*Research.*n3/)
  assert.equal(await w.tool.execute({ to: 'Scout', message: 'Investigate' }, w.exec), 'Sent to Scout on n3; its reply will arrive later as a new message.')
  assert.equal(w.sent.length, 1)
  assert.deepEqual(w.sent[0].to, { id: w.target.id, name: 'Scout', nodeId: 'n3' })
})

test('install subscribes to onMessage once and unsubscribes on cleanup', async t => {
  const w = nodeWorld(t)
  assert.equal(w.handlers.size, 1)
  const cleanup = await w.ctx.dispose()
  assert.ok(cleanup.every(result => result.status === 'fulfilled'))
  assert.equal(w.handlers.size, 0)
})

test('message_bot uses the live remote directory when the local lookup misses', async t => {
  const w = nodeWorld(t)
  assert.equal(w.rt.botNetwork, w.network)
  const result = await w.tool.execute({ to: 'Scout', message: 'Investigate' }, w.exec)
  assert.equal(result, 'Sent to Scout on n3; its reply will arrive later as a new message.')
  assert.equal(w.sent.length, 1)
  assert.deepEqual(w.sent[0], { from: { id: 'local', name: 'Local', nodeId: 'n1' }, to: { id: w.target.id, name: 'Scout', nodeId: 'n3' }, exchangeId: w.sent[0].exchangeId, kind: 'ask', text: 'Investigate', depth: 0 })
  assert.match(w.sent[0].exchangeId, /^[0-9a-f-]{36}$/)
  assert.equal(w.delivered.length, 0)
})

test('remote send passes the node identity validator with all three sender fields', async t => {
  const w = nodeWorld(t)
  assert.throws(() => validateNodeMessage({}, 'n1'), { code: 'bot-message-invalid' })
  assert.throws(() => validateNodeMessage(message(), 'other-node'), { code: 'bot-message-invalid' })
  await w.tool.execute({ to: 'Scout', message: 'Validated' }, w.exec)
  assert.deepEqual(w.sent[0].from, { id: w.local.id, name: w.local.name, nodeId: w.network.nodeId })
  assert.doesNotThrow(() => validateNodeMessage(w.sent[0], w.network.nodeId))
})

test('remote send falls back to the local sender id when its name is empty', async t => {
  const w = nodeWorld(t)
  w.local.name = ''
  await w.tool.execute({ to: 'Scout', message: 'Validated' }, w.exec)
  assert.deepEqual(w.sent[0].from, { id: 'local', name: 'local', nodeId: 'n1' })
})

test('remote send refuses missing or invalid node identity before calling send', async t => {
  const w = nodeWorld(t)
  let attempts = 0
  w.network.send = () => { attempts++; return true }
  for (const nodeId of [undefined, null, '', '   ', 42]) {
    w.network.nodeId = nodeId
    await assert.rejects(w.tool.execute({ to: 'Scout', message: 'Hello' }, w.exec), /bot-network-identity-unavailable/)
  }
  assert.equal(attempts, 0)
})

test('list_bots makes directory destinations discoverable without persisting shadows', async t => {
  const w = nodeWorld(t)
  const before = JSON.stringify(w.rt.state)
  const list = w.rt.teamTools.find(tool => tool.name === 'list_bots')
  assert.match(await list.execute({}, w.exec), /Scout.*Research.*n3/)
  assert.equal(JSON.stringify(w.rt.state), before)
})

test('remote lookup is case sensitive and retains the old missing-Bot result', async t => {
  const w = nodeWorld(t)
  assert.match(await w.tool.execute({ to: 'scout', message: 'Hello' }, w.exec), /^No Bot named scout\./)
  assert.equal(w.sent.length, 0)
})

test('local names take precedence over a duplicate name in the remote directory', async t => {
  const w = nodeWorld(t)
  w.local.name = 'Scout'
  assert.equal(await w.tool.execute({ to: 'Scout', message: 'Hello' }, w.exec), 'You cannot message yourself.')
  assert.equal(w.sent.length, 0)
})

test('remote send failure never reports success', async t => {
  const w = nodeWorld(t, { sendResult: false })
  await assert.rejects(w.tool.execute({ to: 'Scout', message: 'Hello' }, w.exec), /not sent|could not|unavailable/i)
})

test('empty messages and group calls never leave through the network', async t => {
  const w = nodeWorld(t)
  assert.equal(await w.tool.execute({ to: 'Scout', message: '  ' }, w.exec), 'Write a message to send.')
  w.rt.roomOf = () => ({ id: 'room', name: 'Ops', members: ['local'] })
  await assert.rejects(w.tool.execute({ to: 'Scout', message: 'Hello' }, w.exec), /group/i)
  assert.equal(w.sent.length, 0)
})

test('incoming ask injects a named user message, keeps the exchange id, and returns no automatic reply', async t => {
  const w = nodeWorld(t)
  const receive = [...w.handlers][0]
  assert.equal(await receive(message({ to: { id: w.local.id } })), null)
  assert.deepEqual(w.injected, [{ sessionId: 'local-chat', content: [{ type: 'text', text: '[Message from Source]\nHello' }], requestId: 'exchange-1' }])
  assert.ok(w.injected[0].content[0].text.startsWith('[Message from '))
  assert.equal(w.injected[0].content[0].text.includes('[来自'), false)
  assert.equal(w.sent.length, 0)
  await w.ctx.dispose()
  assert.equal(w.handlers.size, 0)
})

test('a node tool carries sender identity through the real joined handler to bot/turn', async t => {
  const source = nodeWorld(t)
  const hub = makeWorld({ bot: { id: 'joined:n2:b', worker: { nodeId: 'n2', remoteBotId: 'b', home: 'remote' } } })
  hub.rt.handleJoinedTurn = args => handleJoinedTurn(hub.rt, args)
  t.after(() => hub.emitter.emit('nodeOffline', { nodeId: 'n2' }))
  source.target.id = hub.bot.id
  source.target.nodeId = hub.bot.worker.nodeId
  const relayed = []
  source.network.send = payload => {
    validateNodeMessage(payload, source.network.nodeId)
    relayed.push(handleNodeMessage(hub.rt, payload))
    return true
  }
  await source.tool.execute({ to: 'Scout', message: 'Across nodes' }, source.exec)
  await Promise.all(relayed)
  assert.equal(hub.rt.botOf(source.local.id), undefined, 'the sender is not on the hub roster')
  assert.equal(hub.frames.length, 1)
  const frame = hub.frames[0]
  assert.equal(frame.type, 'bot/turn')
  assert.equal(frame.nodeId, 'n2')
  assert.deepEqual(frame.payload, {
    nodeId: 'n2', remoteBotId: 'b', exchangeId: frame.payload.exchangeId, text: 'Across nodes',
    senderName: 'Local', senderBotId: 'local',
  })
  assert.match(frame.payload.exchangeId, /^[0-9a-f-]{36}$/)
  const prompt = hub.sessionOf('mirror-1').log.find(event => event.type === 'user/message')
  assert.equal(prompt.data.content[0].text, 'Across nodes')
  assert.equal(source.injected.length, 0, 'no automatic reply is injected')
})

test('node receiver ignores replies and warns about unknown or nonlocal ask destinations', async t => {
  const w = nodeWorld(t)
  const receive = [...w.handlers][0]
  assert.equal(await receive(message({ kind: 'reply', to: { id: w.local.id } })), null)
  for (const id of ['missing', w.joined.id, w.peer.id]) assert.equal(await receive(message({ to: { id } })), null)
  assert.equal(w.injected.length, 0)
  assert.equal(w.warnings.length, 3)
})

test('older remote-agent versions leave network support absent and preserve missing-Bot behavior', async t => {
  const w = world(t)
  install(w.rt)
  installTools(w.rt)
  assert.equal(w.rt.botNetwork, undefined)
  const tool = w.rt.teamTools.find(tool => tool.name === 'message_bot')
  assert.match(await tool.execute({ to: 'Scout', message: 'Hello' }, { agent: { id: 'local-chat' } }), /^No Bot named Scout\./)
})
