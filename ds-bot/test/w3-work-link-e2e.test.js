// W3 (docs/plans/2026-11-24-work-model.md): work across machines, end to end. Three real ds-bot runtimes (hub,
// node010, node011) joined by AC's real code: the hub's NodeRegistry ingest, the nodes' frame dispatcher, the hub and
// node bot-networks, and the reliable link (lib/reliable-link.js, lib/reliable-wire.js). Every turn is driven by
// session events (turn/start → user/message → assistant/message → turn/end); nothing closes a work by hand.
// Needs the AC repo with the reliable link (REMOTE_AGENT_REPO, or a sibling dsh-ai-cluster).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { threadWorld } from './thread-t2-world.js'
import { publishDirectory } from '../src/host/bot-network.js'
import { handlePeerRoster } from '../src/host/federation.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = [process.env.REMOTE_AGENT_REPO, resolve(PLUGIN, '../../dsh-ai-cluster'), resolve(PLUGIN, '../../../Projects/dsh-ai-cluster')]
  .filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
  .find(dir => existsSync(join(dir, 'lib/reliable-wire.js')))
const skip = repo === undefined ? 'AC repo with the reliable link not found (set REMOTE_AGENT_REPO)' : false
const load = file => import(pathToFileURL(join(repo, 'lib', file)).href)
async function until(check, label, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 5)) }
  assert.fail(`timed out: ${label}`)
}
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(r => setImmediate(r)) }

const bot = (id, name) => ({ id, sessionId: id, name, role: 'Exec', instructions: '', createdAt: 1 })
const joined = (nodeId, id, name) => ({ ...bot(`joined:${nodeId}:${id}`, name), type: 'remote-worker', origin: 'joined', worker: { home: 'remote', online: true, nodeId, remoteBotId: id, hostname: `box-${nodeId}` } })
const team = bots => ({ version: 1, mainBotIds: [], revision: 1, whaleStored: true, bots: Object.fromEntries(bots.map(b => [b.id, b])), rooms: {}, exchanges: [], exchangeTurns: {}, questions: {} })

async function cluster(t) {
  const { NodeRegistry } = await load('hub/node-registry.js')
  const { createHubBotNetwork } = await load('hub/bot-network.js')
  const { createBotNetwork } = await load('node/bot-network.js')
  const { createFrameDispatcher } = await load('node/dispatch.js')
  const { attachHubReliable, attachNodeReliable } = await load('reliable-wire.js')
  const registry = new NodeRegistry({ log() {} })
  registry.e2eReady = nodeId => registry.nodes.get(nodeId)?.online === true   // sealing is AC's own test
  let hubCtx
  const hubNetwork = createHubBotNetwork({ registry, ctx: { get: (name, d) => hubCtx?.get(name, d) } })
  const detachHub = attachHubReliable({ registry, network: hubNetwork })
  const world = (prefix, state, services) => {
    const home = mkdtempSync(join(tmpdir(), prefix))
    writeFileSync(join(home, 'state.json'), JSON.stringify(state))
    return threadWorld({ home, services })
  }
  const hub = world('w3-hub-', team([bot('chief', 'Chief'), joined('node010', 'e10', 'Exec10'), joined('node011', 'e11', 'Exec11')]),
    { 'remote-agent:registry': registry, 'remote-agent:bot-network': hubNetwork })
  hubCtx = hub.ctx
  const machines = {}
  const node = (nodeId, local) => {
    const transport = new EventEmitter()
    transport.online = true
    const send = (type, data) => {
      if (!transport.online) return false
      queueMicrotask(() => registry.handleFrameFor(nodeId, { v: 1, t: type, id: 'x', d: structuredClone(data) }))
      return true
    }
    const network = createBotNetwork({ nodeId, send, sendHub: send })
    const dispatch = createFrameDispatcher({ network, send, sendError() {}, logger: {}, ctx: undefined })
    const detach = attachNodeReliable({ nodeId, transport, send, network })
    registry.nodes.set(nodeId, {
      nodeId, online: true, tasks: new Map(), hello: { hostname: `box-${nodeId}`, os: 'linux' },
      conn: { closed: false, send: text => { if (!transport.online) throw new Error('closed'); const frame = JSON.parse(text); queueMicrotask(() => dispatch(frame, frame.d)) } },
    })
    const w = world(`w3-${nodeId}-`, team([local]), { 'remote-agent:bot-network': network })
    machines[nodeId] = { nodeId, transport, network, w, detach }
    return machines[nodeId]
  }
  const n10 = node('node010', bot('e10', 'Exec10'))
  const n11 = node('node011', bot('e11', 'Exec11'))
  await Promise.all([hub.rt.load(), n10.w.rt.load(), n11.w.rt.load()])
  await publishDirectory(hub.rt)
  await until(() => peer(n11.w.rt, 'Exec10') !== undefined && peer(n10.w.rt, 'Exec11') !== undefined && peer(n10.w.rt, 'Chief') !== undefined, 'the nodes have the team directory')
  const goDown = nodeId => { machines[nodeId].transport.online = false; registry.nodes.get(nodeId).online = false }
  const comeBack = nodeId => {
    machines[nodeId].transport.online = true
    registry.nodes.get(nodeId).online = true
    registry.emit('e2eEstablished', { nodeId })
    machines[nodeId].transport.emit('e2e', 'ok')
  }
  t.after(async () => {
    detachHub()
    for (const m of Object.values(machines)) m.detach()
    for (const w of [hub, n10.w, n11.w]) await w.ctx.dispose?.()
  })
  return { registry, hub, n10, n11, goDown, comeBack }
}

const peer = (rt, name) => Object.values(rt.state.bots).find(b => b.origin === 'peer' && b.name === name)
const messageBot = (rt, from, to, message) => rt.teamTools.find(def => def.name === 'message_bot')
  .execute({ to, message }, { agent: { id: from }, callId: 'c', signal: new AbortController().signal })
const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')
const delivered = w => [...w.followups, ...w.steers]
const workThread = (rt, botId) => (rt.botOf(botId).tasks ?? []).find(task => task.origin === 'bot-work')

// One turn, as DSH runs it: it takes `message` up and says `reply`.
const turns = new WeakMap()
function runTurn(w, sessionId, message, reply) {
  const seen = turns.get(w) ?? new Map()
  turns.set(w, seen)
  const turn = (seen.get(sessionId) ?? 0) + 1
  seen.set(sessionId, turn)
  let seq = turn * 10
  const emit = (type, data) => w.sessionEvent(sessionId, { type, seq: ++seq, data })
  emit('turn/start', { turn })
  emit('user/message', { content: message.content, source: message.source })
  if (reply !== undefined) {
    emit('assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { end: (text) => { emit('assistant/message', { message: { content: [{ type: 'text', text }] } }); emit('turn/end', { turn, reason: { kind: 'completed' } }) } }
}
const userTurn = (w, sessionId, text) => runTurn(w, sessionId, { content: [{ type: 'text', text }], source: { kind: 'user' } })

test('W3-E2E-1 a hub Bot hands work to a node Bot: it runs in the pair\'s work thread there, and the hub Bot is resumed once with the result', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const chief = userTurn(hub, 'chief', 'have Exec10 check the build')
  const out = await messageBot(hub.rt, 'chief', 'Exec10', 'check the build')
  assert.match(String(out), /^Handed to Exec10 on box-node010\./)
  chief.end('Exec10 is on it.')
  // On node010: the request is in Exec10's work thread for Chief, not in the chat its user reads.
  await until(() => workThread(n10.w.rt, 'e10') !== undefined && delivered(n10.w).some(d => d.sessionId === workThread(n10.w.rt, 'e10').sessionId), 'the request reached node010')
  const thread = workThread(n10.w.rt, 'e10')
  assert.equal(thread.title, '@Chief · 工作')
  assert.equal(delivered(n10.w).some(d => d.sessionId === 'e10'), false, 'nothing in Exec10\'s own chat')
  const request = delivered(n10.w).find(d => d.sessionId === thread.sessionId).message
  assert.equal(textOf(request), '[Message from Chief]\ncheck the build')
  // Exec10 answers in a real turn; the result goes home, and Chief goes on with it once.
  runTurn(n10.w, thread.sessionId, request, 'the build is green')
  await until(() => delivered(hub).some(d => d.sessionId === 'chief' && d.message.source?.role === 'results'), 'Chief was resumed')
  await settle()
  const toChief = delivered(hub).filter(d => d.sessionId === 'chief')
  assert.equal(toChief.length, 1, 'one resume, nothing else')
  assert.equal(toChief[0].message.source.kind, 'bot')
  assert.match(textOf(toChief[0].message), /^\[Work handed back to you · from Exec10 · everything you handed on is back\]\nExec10:\nthe build is green$/)
  await until(() => thread.status === 'standing', 'the work thread stands by')
  assert.equal(Object.keys(n10.w.rt.state.works ?? {}).length, 0, 'node010 owes nothing')
  // Chief goes on with it; nothing is left open on the hub.
  runTurn(hub, 'chief', toChief[0].message, 'Build checked.')
  await until(() => Object.keys(hub.rt.state.works ?? {}).length === 0, 'the hub work is done')
  // The pair's conversation is on the hub: the request, and the answer.
  const book = (await hub.call('exchange', { a: 'chief', b: 'joined:node010:e10' })).value.map(e => [e.role, e.text])
  assert.deepEqual(book, [['request', 'check the build'], ['reply', 'the build is green']])
})

test('W3-E2E-2 node011 and node010 hold three rounds through the hub, all in one work thread on node010, and the hub keeps the conversation', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  for (let round = 1; round <= 3; round += 1) {
    const asking = userTurn(n11.w, 'e11', `round ${round}`)
    const out = await messageBot(n11.w.rt, 'e11', 'Exec10', `question ${round}`)
    assert.match(String(out), /^Handed to Exec10 on box-node010\./)
    asking.end(`asked Exec10 (${round})`)
    const thread = () => workThread(n10.w.rt, 'e10')
    await until(() => thread() !== undefined && delivered(n10.w).some(d => d.sessionId === thread().sessionId && textOf(d.message).endsWith(`question ${round}`)), `round ${round}: the question reached node010`)
    const request = delivered(n10.w).filter(d => d.sessionId === thread().sessionId).at(-1).message
    runTurn(n10.w, thread().sessionId, request, `answer ${round}`)
    await until(() => delivered(n11.w).filter(d => d.sessionId === 'e11' && d.message.source?.role === 'results').length === round, `round ${round}: node011 was resumed`)
    const resume = delivered(n11.w).filter(d => d.sessionId === 'e11').at(-1).message
    assert.match(textOf(resume), new RegExp(`Exec10:\\nanswer ${round}$`))
    runTurn(n11.w, 'e11', resume, `thanks (${round})`)
  }
  assert.equal((n10.w.rt.botOf('e10').tasks ?? []).filter(task => task.origin === 'bot-work').length, 1, 'one thread for the pair')
  assert.equal(delivered(n10.w).some(d => d.sessionId === 'e10'), false, 'nothing in Exec10\'s own chat')
  // The hub, which carried every frame, has the whole conversation of the two node Bots.
  let book = []
  for (const end = Date.now() + 3000; book.length !== 6 && Date.now() < end;) {
    book = (await hub.call('exchange', { a: 'joined:node011:e11', b: 'joined:node010:e10' })).value ?? []
    await new Promise(r => setTimeout(r, 10))
  }
  assert.deepEqual(book.map(e => [e.role, e.text]), [1, 2, 3].flatMap(r => [['request', `question ${r}`], ['reply', `answer ${r}`]]))
})

test('W3-E2E-3 a node that is away gets the work when it is back: kept at the hub, no clock runs, nothing lost', { skip }, async t => {
  const { hub, n10, goDown, comeBack } = await cluster(t)
  goDown('node010')
  const chief = userTurn(hub, 'chief', 'ask Exec10')
  await messageBot(hub.rt, 'chief', 'Exec10', 'when you are back')
  chief.end('asked')
  await settle()
  assert.equal(hub.rt.ctx.get('remote-agent:bot-network').reliablePending('node010').length, 1, 'kept at the hub for node010')
  assert.equal(workThread(n10.w.rt, 'e10'), undefined)
  comeBack('node010')
  await until(() => workThread(n10.w.rt, 'e10') !== undefined && delivered(n10.w).some(d => textOf(d.message).endsWith('when you are back')), 'delivered once node010 is back')
  const thread = workThread(n10.w.rt, 'e10')
  const request = delivered(n10.w).find(d => d.sessionId === thread.sessionId).message
  runTurn(n10.w, thread.sessionId, request, 'back and done')
  await until(() => delivered(hub).some(d => d.sessionId === 'chief' && /back and done/.test(textOf(d.message))), 'Chief got the result')
  assert.equal(delivered(n10.w).filter(d => textOf(d.message).endsWith('when you are back')).length, 1, 'handled exactly once')
})

test('W3-E2E-4 giving up the wait stops the work on the other machine, and its answer settles nothing here', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const chief = userTurn(hub, 'chief', 'ask Exec10')
  await messageBot(hub.rt, 'chief', 'Exec10', 'long job')
  chief.end('asked')
  await until(() => workThread(n10.w.rt, 'e10') !== undefined && delivered(n10.w).some(d => textOf(d.message).endsWith('long job')), 'the request reached node010')
  const thread = workThread(n10.w.rt, 'e10')
  const request = delivered(n10.w).find(d => d.sessionId === thread.sessionId).message
  const running = runTurn(n10.w, thread.sessionId, request)
  const cancelled = []
  n10.w.agentOf(thread.sessionId).cancel = cause => { cancelled.push(cause) }
  // The user gives the wait up on the hub.
  const child = Object.entries(hub.rt.state.works).find(([, work]) => work.to === 'joined:node010:e10')[0]
  assert.equal((await hub.call('abandon-work', { id: child })).ok, true)
  await until(() => cancelled.length === 1, 'node010 stopped that turn')
  assert.equal(n10.w.rt.state.works?.[request.source.exchangeId], undefined, 'node010 owes it no more')
  running.end('too late')
  await settle()
  await settle()
  // Chief goes on once, with "no reply came back" as that result; nothing comes from node010 afterwards.
  const toChief = delivered(hub).filter(d => d.sessionId === 'chief')
  assert.equal(toChief.length, 1)
  assert.match(textOf(toChief[0].message), /No reply came back from Exec10, and the user gave up waiting/)
})

test('W3-E2E-5 a frame that claims to come from another machine than it did is dropped', { skip }, async t => {
  const { n10, n11 } = await cluster(t)
  // node011 posts a handoff that says it is from the hub's Chief, a Bot node010 knows and would work for.
  n11.network.post('work/handoff', { id: 'spoof-1', from: { id: 'chief', name: 'Chief', nodeId: 'hub' }, to: { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }, part: 'x', text: 'do it' }, { to: 'node010' })
  await settle()
  await settle()
  assert.equal(n10.w.rt.state.works?.['spoof-1'], undefined)
  assert.equal(workThread(n10.w.rt, 'e10'), undefined)
  assert.deepEqual(n11.network.reliablePending(), [], 'acked: not sent again forever')
  assert.equal(delivered(n10.w).some(d => textOf(d.message).endsWith('do it')), false, 'nothing reached a Session')
})

test('W3-E2E-6 a node Bot hands work to a hub Bot: it runs in the hub Bot\'s work thread, and the answer goes home', { skip }, async t => {
  const { hub, n11 } = await cluster(t)
  const asking = userTurn(n11.w, 'e11', 'ask Chief')
  assert.match(String(await messageBot(n11.w.rt, 'e11', 'Chief', 'may I deploy?')), /^Handed to Chief on /)
  asking.end('asked Chief')
  await until(() => workThread(hub.rt, 'chief') !== undefined && delivered(hub).some(d => d.sessionId === workThread(hub.rt, 'chief').sessionId), 'the request is in Chief\'s work thread for Exec11')
  const thread = workThread(hub.rt, 'chief')
  assert.equal(thread.title, '@Exec11 · 工作')
  assert.equal(delivered(hub).some(d => d.sessionId === 'chief'), false, 'nothing in Chief\'s chat with the user')
  runTurn(hub, thread.sessionId, delivered(hub).find(d => d.sessionId === thread.sessionId).message, 'yes, deploy')
  await until(() => delivered(n11.w).some(d => d.sessionId === 'e11' && /yes, deploy/.test(textOf(d.message))), 'the answer reached Exec11')
  assert.equal(delivered(n11.w).filter(d => d.sessionId === 'e11')[0].message.source.role, 'results')
})

test('W3-E2E-7 Chief → Exec11 → Exec10 and back: Exec11 goes on once with Exec10\'s answer, Chief hears nothing before Exec11 is done', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  const chief = userTurn(hub, 'chief', 'run the release')
  await messageBot(hub.rt, 'chief', 'Exec11', 'run the release')
  chief.end('asked Exec11')
  // Exec11 works on it in its thread for Chief, and hands part of it to Exec10 from there.
  await until(() => workThread(n11.w.rt, 'e11') !== undefined && delivered(n11.w).some(d => d.sessionId === workThread(n11.w.rt, 'e11').sessionId), 'Exec11 got the work')
  const t11 = workThread(n11.w.rt, 'e11')
  const exec11 = runTurn(n11.w, t11.sessionId, delivered(n11.w).find(d => d.sessionId === t11.sessionId).message)
  assert.match(String(await messageBot(n11.w.rt, t11.sessionId, 'Exec10', 'run the tests')), /^Handed to Exec10 on box-node010\. .*Your answer goes to Chief after that\.$/)
  exec11.end('Exec10 runs the tests.')
  await until(() => workThread(n10.w.rt, 'e10') !== undefined && delivered(n10.w).some(d => d.sessionId === workThread(n10.w.rt, 'e10').sessionId), 'Exec10 got its part')
  const t10 = workThread(n10.w.rt, 'e10')
  assert.equal(t10.title, '@Exec11 · 工作')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(delivered(hub).filter(d => d.sessionId === 'chief').length, 0, 'Chief hears nothing yet')
  runTurn(n10.w, t10.sessionId, delivered(n10.w).find(d => d.sessionId === t10.sessionId).message, 'tests pass')
  // Exec11 is resumed in its thread for Chief, once, with Exec10's answer.
  await until(() => delivered(n11.w).some(d => d.sessionId === t11.sessionId && d.message.source?.role === 'results'), 'Exec11 was resumed')
  const resume = delivered(n11.w).filter(d => d.sessionId === t11.sessionId).at(-1).message
  assert.match(textOf(resume), /Exec10:\ntests pass$/)
  assert.equal(delivered(hub).filter(d => d.sessionId === 'chief').length, 0, 'still nothing for Chief')
  runTurn(n11.w, t11.sessionId, resume, 'released: tests pass')
  await until(() => delivered(hub).some(d => d.sessionId === 'chief'), 'Chief got Exec11\'s answer')
  const toChief = delivered(hub).filter(d => d.sessionId === 'chief')
  assert.equal(toChief.length, 1)
  assert.match(textOf(toChief[0].message), /Exec11:\nreleased: tests pass\n\n\[Handed back to Exec11 for this work\]\n\nExec10:\ntests pass$/)
})

test('W3-E2E-8 a roster frame (federation off) between rounds keeps the directory rows: the next round is answered', { skip }, async t => {
  const { n10, n11 } = await cluster(t)
  for (const round of [1, 2]) {
    const asking = userTurn(n11.w, 'e11', `round ${round}`)
    await messageBot(n11.w.rt, 'e11', 'Exec10', `question ${round}`)
    asking.end('asked')
    const thread = () => workThread(n10.w.rt, 'e10')
    await until(() => thread() !== undefined && delivered(n10.w).some(d => textOf(d.message).endsWith(`question ${round}`)), `round ${round} reached node010`)
    // The hub's roster push lands on node010 now, before it answers.
    assert.equal(await handlePeerRoster(n10.w.rt, { hubId: 'hub-1', level: 'off', bots: [] }), true)
    assert.ok(peer(n10.w.rt, 'Exec11'), 'the directory row for Exec11 is still there')
    runTurn(n10.w, thread().sessionId, delivered(n10.w).filter(d => d.sessionId === thread().sessionId).at(-1).message, `answer ${round}`)
    await until(() => delivered(n11.w).some(d => d.sessionId === 'e11' && textOf(d.message).endsWith(`answer ${round}`)), `round ${round} answered`)
    runTurn(n11.w, 'e11', delivered(n11.w).filter(d => d.sessionId === 'e11').at(-1).message, 'ok')
  }
})

test('W3-E2E-9 the asker\'s stand-in is gone when the answer is ready: it still goes home, to where the work came from', { skip }, async t => {
  const { n10, n11 } = await cluster(t)
  const asking = userTurn(n11.w, 'e11', 'ask')
  await messageBot(n11.w.rt, 'e11', 'Exec10', 'question')
  asking.end('asked')
  await until(() => workThread(n10.w.rt, 'e10') !== undefined && delivered(n10.w).some(d => textOf(d.message).endsWith('question')), 'reached node010')
  const thread = workThread(n10.w.rt, 'e10')
  delete n10.w.rt.state.bots[peer(n10.w.rt, 'Exec11').id]
  runTurn(n10.w, thread.sessionId, delivered(n10.w).find(d => d.sessionId === thread.sessionId).message, 'answer')
  await until(() => delivered(n11.w).some(d => d.sessionId === 'e11' && textOf(d.message).endsWith('answer')), 'the answer reached node011 anyway')
})
