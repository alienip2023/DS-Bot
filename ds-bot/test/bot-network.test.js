import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { MODULES } from '../index.js'
import { directoryOf, publishDirectory, handleNodeMessage, install } from '../src/host/bot-network.js'
import { install as installTools } from '../src/host/tools.js'
import { fakeContext } from './fake-ctx.js'

function world(t, { network, registry = new EventEmitter() } = {}) {
  const local = { id: 'local', name: 'Local', role: 'Writer', sessionId: 'local-chat' }
  const joined = { id: 'joined:n2:b', name: 'Remote', role: 'Research', origin: 'joined', type: 'remote-worker', worker: { home: 'remote', nodeId: 'n2', remoteBotId: 'b' } }
  const peer = { id: 'peer:h:c', name: 'Peer', origin: 'peer', worker: { home: 'hub', hubId: 'h' } }
  const services = { 'remote-agent:registry': registry, 'remote-agent:bot-network': network }
  const ctx = fakeContext({ services })
  ctx.set = (key, value) => { services[key] = value }
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
    { id: 'local', name: 'local', role: 'Writer', nodeId: null },
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

test('hub routes asks to joined Bots with defer:true', async t => {
  const w = world(t)
  await handleNodeMessage(w.rt, message())
  assert.deepEqual(w.joinedTurns, [{ fromId: 'source', toId: w.joined.id, text: 'Hello', role: 'default', exchangeId: 'exchange-1', defer: true }])
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

function nodeWorld(t, { sendResult = true } = {}) {
  const sent = []
  const handlers = new Set()
  const target = { id: 'joined:n3:c', name: 'Scout', role: 'Research', nodeId: 'n3' }
  const network = {
    directory: () => [target],
    send: payload => { sent.push(payload); return sendResult },
    onMessage: handler => { handlers.add(handler); return () => handlers.delete(handler) },
  }
  const w = world(t, { network })
  install(w.rt)
  installTools(w.rt)
  const tool = w.rt.teamTools.find(tool => tool.name === 'message_bot')
  const exec = { agent: { id: 'local-chat' } }
  return { ...w, network, sent, handlers, target, tool, exec }
}

test('message_bot uses the live remote directory when the local lookup misses', async t => {
  const w = nodeWorld(t)
  assert.equal(w.rt.botNetwork, w.network)
  const result = await w.tool.execute({ to: 'Scout', message: 'Investigate' }, w.exec)
  assert.equal(result, 'Sent to Scout on n3; its reply will arrive later as a new message.')
  assert.equal(w.sent.length, 1)
  assert.deepEqual(w.sent[0], { to: { id: w.target.id, name: 'Scout', nodeId: 'n3' }, exchangeId: w.sent[0].exchangeId, kind: 'ask', text: 'Investigate', depth: 0 })
  assert.match(w.sent[0].exchangeId, /^[0-9a-f-]{36}$/)
  assert.equal(w.delivered.length, 0)
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
  assert.deepEqual(w.injected, [{ sessionId: 'local-chat', content: [{ type: 'text', text: '[来自 Source] Hello' }], requestId: 'exchange-1' }])
  assert.ok(w.injected[0].content[0].text.startsWith('[来自 '))
  assert.equal(w.sent.length, 0)
  await w.ctx.dispose()
  assert.equal(w.handlers.size, 0)
})

test('a node tool reaches a second node through the hub joined route without an automatic reply', async t => {
  const source = nodeWorld(t)
  const hub = world(t)
  const destination = nodeWorld(t)
  const receive = [...destination.handlers][0]
  source.target.id = hub.joined.id
  source.target.nodeId = hub.joined.worker.nodeId
  const relayed = []
  source.network.send = payload => {
    relayed.push(handleNodeMessage(hub.rt, { ...payload, from: { id: source.local.id, name: source.local.name, nodeId: 'n1' } }))
    return true
  }
  hub.rt.handleJoinedTurn = async turn => {
    assert.equal(turn.defer, true)
    assert.equal(turn.toId, hub.joined.id)
    return receive(message({ exchangeId: turn.exchangeId, from: { id: source.local.id, name: source.local.name, nodeId: 'n1' }, to: { id: destination.local.id }, text: turn.text }))
  }
  await source.tool.execute({ to: 'Scout', message: 'Across nodes' }, source.exec)
  await Promise.all(relayed)
  assert.equal(destination.injected.length, 1)
  assert.equal(destination.injected[0].content[0].text, '[来自 Local] Across nodes')
  assert.match(destination.injected[0].requestId, /^[0-9a-f-]{36}$/)
  assert.equal(destination.sent.length, 0)
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
