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
    { id: 'local', name: 'local', role: 'Writer', nodeId: 'hub', online: true, state: 'available' },
    { id: 'joined:n2:b', name: 'Remote', role: 'Research', nodeId: 'n2', online: true, state: 'available' },
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

test('depth >= 3 is dropped before routing', async t => {
  const w = world(t)
  for (const depth of [3, 4]) await handleNodeMessage(w.rt, message({ depth }))
  assert.equal(w.joinedTurns.length, 0)
  assert.equal(w.delivered.length, 0)
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
  // A Bot-to-Bot ask no longer comes this way (work across machines is bot-link.js, work model W3): no turn.
  await w.ctx.get('remote-agent:bot-message')(message())
  assert.equal(w.joinedTurns.length, 0)
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

test('older remote-agent versions leave network support absent and preserve missing-Bot behavior', async t => {
  const w = world(t)
  install(w.rt)
  installTools(w.rt)
  assert.equal(w.rt.botNetwork, undefined)
  const tool = w.rt.teamTools.find(tool => tool.name === 'message_bot')
  assert.match(await tool.execute({ to: 'Scout', message: 'Hello' }, { agent: { id: 'local-chat' } }), /^No Bot named Scout\./)
})
