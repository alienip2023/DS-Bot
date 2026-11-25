// bot/trace end to end through AC's REAL functions, no mock of the other side: a node Bot's turn runs in ds-bot's
// real receiver (joined-turn.js createBotTurnReceiver) on real Sessions; AC's real node dispatcher
// (lib/node/dispatch.js + lib/bot-turn.js) validates and sends the frames; AC's real hub ingest
// (lib/hub/registry-ingest.js) validates them again and emits `botTrace` / `botTurnResult`; ds-bot's hub side writes the
// steps into the Bot's mirror page. The test then compares that Session with the node's own Session — the log of the
// turn as a local Bot would have it. A node's page is a copy of its chat (conv-replica.js), so this is the path of a
// node without the copy; group rounds no longer write into the group's Session (fork.130), so the turns below are
// Bot-to-Bot exchanges (handleJoinedTurn without a roomId).
//
// Needs the AC repo (REMOTE_AGENT_REPO, or a sibling `dsh-ai-cluster`); skipped with a message when it is not there.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { handleJoinedTurn, install as installJoinedTurn } from '../src/host/joined-turn.js'
import { NODE_FEATURES } from '../src/host/node-compat.js'
import { TRACE_LIMITS } from '../src/host/node-trace.js'
import { turnEnd } from '../src/host/turn-end.js'
import { makeWorld, textRequest } from './joined-world.js'
import { answers, assertStrict, FULL_SKELETON, reasoningOf, skeleton, textOf } from './node-trace-world.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const candidates = [process.env.REMOTE_AGENT_REPO, resolve(PLUGIN, '../../dsh-ai-cluster'), resolve(PLUGIN, '../../../Projects/dsh-ai-cluster')]
  .filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
const repo = candidates.find(dir => existsSync(join(dir, 'lib/protocol.js')))
const skip = repo === undefined ? 'AC repo not found (set REMOTE_AGENT_REPO)' : false
const load = file => import(pathToFileURL(join(repo, 'lib', file)).href)

const { createAssistantMessage, createToolResultMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')
const { Session } = await import('@deepseek-ai/dsh-session')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const model = { provider: 'node-model', model: 'm' }

const SCRIPT = {
  steps: [
    { think: 'I should list the files first', call: { id: 'call-1', name: 'bash', args: { command: 'ls' }, out: 'a.txt\nb.txt' } },
    { think: 'a.txt looks right, read it', call: { id: 'call-2', name: 'read', args: { file_path: 'a.txt' }, out: 'hello' } },
  ],
  final: { think: 'now I can answer', text: 'a.txt says hello' },
}

/**
 * One hub and one node in a process. `nodeCaps` / `hubCaps` are what each side announces (AC's own lists unless
 * a test wants an older one); `drop(type, data, n)` loses a frame on the node→hub link; `link.up` cuts it.
 * `room`: kept by the tests that name it; the node's turn is run in its chat either way.
 */
async function cluster({ nodeCaps, hubCaps, drop = () => false, script = SCRIPT, tick = 12, steerAfter, room = false } = {}) {
  const protocol = await load('protocol.js')
  const { withIngest } = await load('hub/registry-ingest.js')
  const { createFrameDispatcher } = await load('node/dispatch.js')
  const caps = nodeCaps ?? protocol.nodeCaps(['fs', 'exec', 'artifact', 'agent'], 'linux')
  const link = { up: true }
  const hubGets = []       // what the hub sent the node
  const nodeSent = []      // what the node's AC sent the hub
  const events = new EventEmitter()
  const nodeLog = []
  let dispatch

  class Core {
    constructor() { this.nodes = new Map([['n1', { nodeId: 'n1', online: true, lastSeen: 0, hello: { caps } }]]); this.tasks = new Map() }
    log() {}
    auditRecord() {}
    getNode(id) { return this.nodes.get(id) }
    send(nodeId, type, payload) {
      if (!link.up) return false
      hubGets.push({ type, payload: structuredClone(payload) })
      queueMicrotask(() => dispatch({ id: `f${hubGets.length}`, t: type, d: structuredClone(payload) }))
      return true
    }
    on(name, fn) { events.on(name, fn) }
    off(name, fn) { events.off(name, fn) }
    emit(name, payload) { events.emit(name, payload) }
  }
  const registry = new (withIngest(Core))()

  // The node: ds-bot's real receiver on a real Session, handed to AC's real dispatcher as ctx.get('remote-agent:bot-turn').
  const provided = new Map()
  const listeners = []
  const nodeSession = new Session('node-chat')
  const put = (type, data, options) => {
    const event = nodeSession.append(type, data, options)
    for (const fn of listeners) fn(nodeSession, event)
    return event
  }
  const nodeRt = {
    ctx: { provide: (name, fn) => provided.set(name, fn), get: name => provided.get(name), on: (name, fn) => { if (name === 'session/event') listeners.push(fn) }, logger: { info() {}, warn() {}, error() {}, debug() {} } },
    state: { bots: { rb1: { id: 'rb1', name: 'Worker' } } },
    chatOf: () => 'node-chat',
    save: async () => {},
    warn: (...args) => nodeLog.push(args),
    redactSecrets: text => text.replaceAll('hunter2', '[secret:PW]'),
    nodeTraceFlushMs: 5,
  }
  installJoinedTurn(nodeRt)
  const steered = []
  let turnNo = 0
  let running = false
  async function play(requestId, content) {
    running = true
    const turn = ++turnNo
    put('turn/start', { turn })
    put('step/start', { turn, step: 1 })
    put('user/message', createUserMessage({ content, source: { kind: 'user', rpcId: requestId } }), { surfaceOp: 'append' })
    for (const [index, step] of script.steps.entries()) {
      const n = index + 1
      await wait(tick)
      const args = JSON.stringify(step.call.args)
      put('assistant/message', { turn, step: n, message: createAssistantMessage({ content: [{ type: 'reasoning', text: step.think }, { type: 'tool-call', id: step.call.id, name: step.call.name, arguments: args }], source: model }), stream: [] }, { surfaceOp: 'append' })
      const call = put('tool/call', { turn, step: n, callId: step.call.id, name: step.call.name, arguments: args })
      if (index === 0 && steerAfter !== undefined) { await steerAfter(); }
      await wait(tick)
      put('tool/result', { turn, step: n, message: createToolResultMessage({ callId: step.call.id, content: [{ type: 'text', text: step.call.out }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      put('step/end', { turn, step: n })
      put('step/start', { turn, step: n + 1 })
    }
    await wait(tick)
    const last = script.steps.length + 1
    put('assistant/message', { turn, step: last, message: createAssistantMessage({ content: [{ type: 'reasoning', text: script.final.think }, { type: 'text', text: script.final.text }], source: model }), stream: [] }, { surfaceOp: 'append' })
    put('step/end', { turn, step: last })
    put('turn/end', { turn, reason: turnEnd.completed() })
    running = false
    for (const id of [requestId, ...steered.splice(0)]) nodeRt.settleJoinedTurn(id, script.final.text)
  }
  nodeRt.sendUser = async ({ content, requestId, mode }) => {
    if (running && mode === 'steer') {
      steered.push(requestId)
      put('user/message', createUserMessage({ content, source: { kind: 'user', rpcId: requestId } }), { surfaceOp: 'append' })
      return
    }
    void play(requestId, content)
  }
  const sendToHub = (type, data) => {
    if (!link.up) return false
    nodeSent.push({ type, data: structuredClone(data) })
    if (drop(type, data, nodeSent.length)) return true
    registry.handleFrameFor('n1', { t: type, d: structuredClone(data) })
    return true
  }
  dispatch = createFrameDispatcher({
    ctx: nodeRt.ctx, send: sendToHub, sendError() {}, engine: {}, logger: nodeRt.ctx.logger,
    hubCaps: () => hubCaps ?? protocol.HUB_CAPS,
  })

  // The hub: ds-bot's real page path, on AC's real registry.
  const w = makeWorld({ tracker: true })
  w.rt.ctx.get = key => (key === 'remote-agent:registry' ? registry : undefined)
  // The replies to the exchange are kept as delivered.
  const delivered = []
  if (room) {
    w.rt.state.exchanges = []
    w.rt.deliver = async (msg) => { delivered.push(msg) }
  }
  return { w, registry, link, hubGets, nodeSent, nodeSession, nodeLog, events, protocol, delivered }
}

const groupRound = (c, text) => handleJoinedTurn(c.w.rt, { fromId: 'local', toId: c.w.bot.id, text, role: 'request' })
const groupOf = c => c.w.sessionOf(c.w.bot.sessionId)
// The round's own turn (the first one in the page): a note the hub may add after it is a turn of its own.
const roundOf = (session) => {
  const end = session.log.findIndex(event => event.type === 'turn/end')
  return { log: session.log.slice(0, end + 1) }
}

const finish = async (c) => { await c.w.idle(); await new Promise(resolve => setImmediate(resolve)) }

test('a node turn with thinking and two tool calls: the hub Session has the events a local turn has, in the same order', { skip }, async () => {
  const c = await cluster({ room: true })
  assert.equal(await groupRound(c, 'list the files'), c.hubGets[0].payload.exchangeId)
  await finish(c)
  const mirror = groupOf(c)
  // the node's own Session IS the local turn
  assert.deepEqual(skeleton(mirror), skeleton(c.nodeSession))
  assert.deepEqual(skeleton(mirror), FULL_SKELETON)
  assertStrict(mirror)
  // and the content, not only the shape
  const content = session => session.log.filter(event => ['assistant/message', 'tool/call', 'tool/result'].includes(event.type)).map((event) => {
    if (event.type === 'assistant/message') return ['assistant', event.data.message.content.map(block => block.type === 'tool-call' ? [block.type, block.id, block.name, block.arguments] : [block.type, block.text])]
    if (event.type === 'tool/call') return ['call', event.data.callId, event.data.name, event.data.arguments]
    return ['result', event.data.message.toolCallId, event.data.message.isError, event.data.message.content.map(block => block.text)]
  })
  assert.deepEqual(content(mirror), content(c.nodeSession))
  assert.deepEqual(mirror.deriveMessages().map(message => message.role), c.nodeSession.deriveMessages().map(message => message.role), 'the messages the Session derives have the same roles in the same order')
  assert.equal(reasoningOf(answers(mirror)[0]), 'I should list the files first')
  assert.equal(textOf(answers(mirror).at(-1)), 'a.txt says hello')
  assert.equal(c.w.warnings.length, 0)
})

test('the frames AC carried: live batches first, one final list, then the result; every one accepted by the hub validator', { skip }, async () => {
  const c = await cluster()
  await c.w.prompt(textRequest('list the files', 'req-1'))
  await finish(c)
  const types = c.nodeSent.map(frame => frame.type)
  assert.equal(types.at(-1), 'bot/turn-result')
  assert.equal(types.at(-2), 'bot/trace')
  assert.equal(c.nodeSent.at(-2).data.final, true)
  assert.ok(types.filter(type => type === 'bot/trace').length >= 3, 'live frames went out while the turn ran (not only at its end)')
  const seqs = c.nodeSent.filter(frame => frame.type === 'bot/trace').map(frame => frame.data.seq)
  assert.deepEqual(seqs, seqs.toSorted((a, b) => a - b), 'seq only goes up')
  assert.equal(new Set(seqs).size, seqs.length)
  for (const frame of c.nodeSent.filter(frame => frame.type === 'bot/trace')) {
    const checked = c.protocol.validateBotTrace(frame.data)
    assert.equal(checked.ok, true)
    assert.deepEqual(checked.trace, frame.data, 'AC changed nothing of what ds-bot sent: no field dropped or clipped on the way')
    assert.deepEqual([frame.data.nodeId, frame.data.remoteBotId], ['n1', 'rb1'])
  }
  assert.deepEqual(c.nodeSent.at(-2).data.items.map(item => item.i), [1, 2, 3, 4, 5], 'the final list is the whole turn')
})

test('limits: ds-bot\'s node-side caps are AC\'s caps (a drift would be cut by the hub, silently from the user\'s view)', { skip }, async () => {
  const { BOT_TRACE_LIMITS } = await load('protocol.js')
  for (const key of Object.keys(TRACE_LIMITS)) assert.equal(TRACE_LIMITS[key], BOT_TRACE_LIMITS[key], key)
  assert.equal(NODE_FEATURES.trace.cap, (await load('protocol.js')).BOT_TRACE_CAP)
})

test('capability: the node\'s hello carries bot-trace/1 and ds-bot reads it as "can trace"', { skip }, async () => {
  const c = await cluster()
  const { nodeCan } = await import('../src/host/node-compat.js')
  assert.equal(c.registry.getNode('n1').hello.caps.includes('bot-trace/1'), true)
  assert.equal(nodeCan(c.w.rt, c.w.bot, 'trace'), true)
})

test('a lost live batch (and the node\'s second one with it) is repaired by the final list', { skip }, async () => {
  const lost = new Set()
  const c = await cluster({ room: true, drop: (type, data) => { if (type === 'bot/trace' && data.final !== true && lost.size < 2) { lost.add(data.seq); return true } return false } })
  await groupRound(c, 'list the files')
  await finish(c)
  assert.equal(lost.size, 2)
  const mirror = groupOf(c)
  assert.deepEqual(skeleton(mirror), FULL_SKELETON)
  assertStrict(mirror)
})

test('every trace frame played twice by the link: the page is written once', { skip }, async () => {
  const c = await cluster({ room: true })
  const original = c.registry.handleFrameFor.bind(c.registry)
  c.registry.handleFrameFor = (id, frame) => { original(id, frame); if (frame.t === 'bot/trace') original(id, structuredClone(frame)) }
  await groupRound(c, 'list the files')
  await finish(c)
  assert.deepEqual(skeleton(groupOf(c)), FULL_SKELETON)
})

test('the link is lost while the node is in the middle of a tool: the round\'s turn is closed as lost, nothing dangles, and the node\'s late answer still reaches the group', { skip }, async () => {
  // The late answer is written into the page as a note of its own.
  const c = await cluster({ room: true, tick: 30 })
  const round = groupRound(c, 'list the files')
  await wait(45)   // step 1's call is out, its result is not
  c.link.up = false
  c.events.emit('nodeOffline', { nodeId: 'n1' })
  assert.equal((await round).error, 'bridge-down')
  await finish(c)
  const mirror = groupOf(c)
  assertStrict(mirror)
  assert.equal(mirror.log.at(-1).data.reason.kind, 'error')
  assert.ok(mirror.log.some(event => event.type === 'assistant/message' && reasoningOf(event) === 'I should list the files first'), 'the thinking the round already had is kept')
  assert.ok(mirror.log.filter(event => event.type === 'tool/call').every(call => mirror.log.some(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)))
  assert.ok(textOf(answers(mirror).at(-1)).includes('桥已断'))
  // the link comes back: AC re-sends the node's final steps and its result; the closed turn is not written into again,
  // and the answer is written into the page as a note of its own
  await wait(250)
  const closedAt = mirror.log.length
  c.link.up = true
  const late = () => mirror.log.slice(closedAt).find(event => event.type === 'assistant/message' && textOf(event).includes('a.txt says hello'))
  const started = Date.now()
  while (late() === undefined && Date.now() - started < 4000) await wait(50)
  assert.ok(late() !== undefined, 'the node\'s answer reaches the page after the link is back')
  assert.equal(mirror.log.slice(closedAt).filter(event => event.type === 'tool/call').length, 0, 'no step is written into the closed turn, and none twice')
  assertStrict(mirror)
})

test('a node with an older AC (no bot-trace/1): the round is answered as always, no trace frame is sent, nothing crashes', { skip }, async () => {
  // The page's "too old" note is gone with it.
  const protocol = await load('protocol.js')
  const caps = protocol.nodeCaps(['fs', 'exec', 'artifact', 'agent'], 'linux').filter(cap => cap !== 'bot-trace/1')
  // an old node's AC would not even offer a trace channel to the receiver; its hub list is the old one too
  const c = await cluster({ room: true, nodeCaps: caps, hubCaps: [protocol.MEMORY_CAPS] })
  await groupRound(c, 'list the files')
  await finish(c)
  assert.equal(c.nodeSent.some(frame => frame.type === 'bot/trace'), false)
  const mirror = groupOf(c)
  assertStrict(mirror)
  assert.deepEqual(skeleton(roundOf(mirror)), ['turn/start', 'step/start:1', 'user', 'assistant[text]', 'step/end:1', 'turn/end:completed'], 'one step, one answer')
  assert.equal(textOf(answers(roundOf(mirror))[0]), 'a.txt says hello')
  assert.equal(c.w.warnings.length, 0)
})

test('a new node under a hub whose AC predates bot-trace/1: no frame is sent, the round is answered as always', { skip }, async () => {
  // Traces now reach only group rounds (W4: the page is a copy of the node chat); the page's "got none" note is gone with it.
  const c = await cluster({ room: true, hubCaps: ['memory-sync/1'] })
  await groupRound(c, 'list the files')
  await finish(c)
  assert.equal(c.nodeSent.some(frame => frame.type === 'bot/trace'), false, 'the node sends nothing a hub did not announce')
  const mirror = groupOf(c)
  assertStrict(mirror)
  assert.deepEqual(skeleton(roundOf(mirror)), ['turn/start', 'step/start:1', 'user', 'assistant[text]', 'step/end:1', 'turn/end:completed'], 'one step, one answer')
  assert.equal(textOf(answers(roundOf(mirror))[0]), 'a.txt says hello')
})

test('a hub whose AC emits no botTrace at all (an older AC under a newer ds-bot): the answer is complete and nothing throws', { skip }, async () => {
  const c = await cluster({ room: true })
  const original = c.registry.emit.bind(c.registry)
  c.registry.emit = (name, payload) => { if (name !== 'botTrace') original(name, payload) }
  await groupRound(c, 'list the files')
  await finish(c)
  assert.ok(c.nodeSent.some(frame => frame.type === 'bot/trace'), 'the node did send its steps; the hub dropped them')
  const mirror = groupOf(c)
  assertStrict(mirror)
  assert.deepEqual(skeleton(roundOf(mirror)), ['turn/start', 'step/start:1', 'user', 'assistant[text]', 'step/end:1', 'turn/end:completed'], 'one step, one answer')
  assert.equal(textOf(answers(roundOf(mirror))[0]), 'a.txt says hello')
  assert.equal(c.w.warnings.length, 0)
})

test('a secret the node Bot\'s user keeps never reaches the hub: it is replaced on the node, before AC sends it', { skip }, async () => {
  const script = { steps: [{ think: 'the password is hunter2', call: { id: 'c1', name: 'bash', args: { command: 'echo hunter2' }, out: 'hunter2' } }], final: { think: 'done', text: 'ok' } }
  const c = await cluster({ room: true, script })
  await groupRound(c, 'go')
  await finish(c)
  assert.equal(JSON.stringify(c.nodeSent).includes('hunter2'), false)
  assert.equal(JSON.stringify(groupOf(c).log).includes('hunter2'), false)
  assert.ok(JSON.stringify(groupOf(c).log).includes('[secret:PW]'))
})
