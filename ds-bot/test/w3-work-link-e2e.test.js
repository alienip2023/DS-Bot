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
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const team = bots => ({ version: 1, mainBotIds: [], revision: 1, whaleStored: true, bots: Object.fromEntries(bots.map(b => [b.id, b])), rooms: {}, exchanges: [], exchangeTurns: {}, questions: {} })

async function cluster(t) {
  const linkLog = process.env.W3_TEST_TRACE === '1' ? (...args) => t.diagnostic(JSON.stringify(args)) : undefined
  const { NodeRegistry } = await load('hub/node-registry.js')
  const { createHubBotNetwork } = await load('hub/bot-network.js')
  const { createBotNetwork } = await load('node/bot-network.js')
  const { createFrameDispatcher } = await load('node/dispatch.js')
  const { attachHubReliable, attachNodeReliable } = await load('reliable-wire.js')
  const registry = new NodeRegistry({ log() {} })
  registry.e2eReady = nodeId => registry.nodes.get(nodeId)?.online === true   // sealing is AC's own test
  let hubCtx
  const hubNetwork = createHubBotNetwork({ registry, ctx: { get: (name, d) => hubCtx?.get(name, d) } })
  const detachHub = attachHubReliable({ registry, network: hubNetwork, log: linkLog })
  const world = (prefix, state, services) => {
    const home = mkdtempSync(join(tmpdir(), prefix))
    writeFileSync(join(home, 'state.json'), JSON.stringify(state))
    return threadWorld({ home, services })
  }
  const hub = world('w3-hub-', team([bot('chief', 'Chief'), joined('node010', 'e10', 'Exec10'), joined('node011', 'e11', 'Exec11')]),
    { 'remote-agent:registry': registry, 'remote-agent:bot-network': hubNetwork })
  hubCtx = hub.ctx
  // The hub's page Sessions keep what is appended, and check it as DSH's store does: surface markers, and every tool
  // call of a step answered before the step (or turn) ends.
  const resolveHub = hub.ctx.sessionController.resolveAgent
  hub.ctx.sessionController.resolveAgent = async (sessionId) => {
    const out = await resolveHub(sessionId)
    const session = out.agent.session
    if (typeof session.append !== 'function') {
      const calls = new Map()
      session.append = (type, data, options) => {
        if (SURFACE.has(type) && options?.surfaceOp === undefined) throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`)
        if (!SURFACE.has(type) && options?.surfaceOp !== undefined) throw new Error(`session event "${type}" is not surface-eligible and cannot carry surfaceOp`)
        if (type === 'tool/call' && calls.get(data.callId) !== 'advertised') throw new Error(`tool/call ${data.callId} does not match one advertised tool call`)
        if (type === 'tool/result' && calls.get(data.message?.source?.callId) !== 'started') throw new Error(`tool/result ${data.message?.source?.callId} has no started tool call`)
        if ((type === 'step/end' || type === 'turn/end') && calls.size > 0) throw new Error(`${type} leaves unresolved tool call ${calls.keys().next().value}`)
        if (type === 'assistant/message') for (const block of data.message?.content ?? []) if (block.type === 'tool-call') calls.set(block.id, 'advertised')
        if (type === 'tool/call') calls.set(data.callId, 'started')
        if (type === 'tool/result') calls.delete(data.message.source.callId)
        const event = { type, seq: ++session.seq, time: Date.now(), data }
        session.log.push(event)
        return event
      }
    }
    return out
  }
  // A page of a hub Session is what was appended to it.
  hub.ctx.sessionController.page = async ({ address }) => ({ records: (hub.agents.get(address.sessionId)?.session.log ?? []).map(event => ({ event })), hasMore: false })
  const machines = {}
  const node = (nodeId, local) => {
    const transport = new EventEmitter()
    transport.online = true
    const send = (type, data) => {
      linkLog?.('node→hub', nodeId, type, data?.type ?? null, data?.data?.status ?? data?.data?.outcome ?? null)
      if (!transport.online) return false
      queueMicrotask(() => registry.handleFrameFor(nodeId, { v: 1, t: type, id: 'x', d: structuredClone(data) }))
      return true
    }
    const network = createBotNetwork({ nodeId, send, sendHub: send })
    const dispatch = createFrameDispatcher({ network, send, sendError() {}, logger: {}, ctx: undefined })
    const detach = attachNodeReliable({ nodeId, transport, send, network, log: linkLog })
    registry.nodes.set(nodeId, {
      nodeId, online: true, tasks: new Map(), hello: { hostname: `box-${nodeId}`, os: 'linux' },
      conn: { closed: false, send: text => { if (!transport.online) throw new Error('closed'); const frame = JSON.parse(text); linkLog?.('hub→node', nodeId, frame.t, frame.d?.type ?? null); queueMicrotask(() => dispatch(frame, frame.d)) } },
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
const messageBot = (rt, from, to, message, requestId) => rt.teamTools.find(def => def.name === 'message_bot')
  .execute({ to, message, ...(requestId ? { request_id: requestId } : {}) }, { agent: { id: from }, callId: 'c', signal: new AbortController().signal })
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

test('W3 batch waits for both nodes and runs each assignment in the receiving Bot chat', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  const chief = userTurn(hub, 'chief', 'check the two halves')
  await messageBot(hub.rt, 'chief', 'Exec10', 'inspect the first half')
  await messageBot(hub.rt, 'chief', 'Exec11', 'inspect the second half')
  chief.end('Both checks are underway.')

  const requestOf = (w, id) => delivered(w).find(d => d.sessionId === id && d.message.source.role === 'request')
  await until(() => delivered(n10.w).length > 0 && delivered(n11.w).length > 0, 'both nodes received work')
  const first = requestOf(n10.w, 'e10')
  const second = requestOf(n11.w, 'e11')
  assert.ok(first, 'the first request reached Exec10’s own chat')
  assert.ok(second, 'the second request reached Exec11’s own chat')
  assert.equal(workThread(n10.w.rt, 'e10'), undefined)
  assert.equal(workThread(n11.w.rt, 'e11'), undefined)

  const parent = hub.rt.state.works[first.message.source.exchangeId].parent
  assert.equal(hub.rt.state.works[second.message.source.exchangeId].parent, parent)
  runTurn(n10.w, 'e10', first.message, 'first half checked')
  await until(() => hub.rt.state.works[parent]?.results?.length === 1, 'first result persisted in the batch')
  assert.deepEqual(n10.w.rt.state.exchangeTurns.e10 ?? [], [], 'foreground handoff is not hidden in the receiving chat')
  await until(() => pageOf(hub, 'joined:node010:e10')?.log.some(e => e.data?.source?.exchangeId === first.message.source.exchangeId), 'actual worker conversation copied to its page')
  await settle()
  assert.equal(delivered(hub).filter(d => d.sessionId === 'chief').length, 0, 'a partial return never wakes Chief')
  const waiting = hub.rt.waitingView().chief
  assert.deepEqual(waiting.waits.map(item => item.id), [second.message.source.exchangeId])
  assert.deepEqual(waiting.batches, [{
    id: parent, part: 'chief', total: 2, pending: [second.message.source.exchangeId],
    returned: [{ id: first.message.source.exchangeId, from: 'joined:node010:e10', name: 'Exec10', outcome: 'done' }],
  }])

  runTurn(n11.w, 'e11', second.message, 'second half checked')
  await until(() => delivered(hub).some(d => d.sessionId === 'chief'), 'completed batch returned')
  await settle()
  const replies = delivered(hub).filter(d => d.sessionId === 'chief')
  assert.equal(replies.length, 1)
  assert.equal(replies[0].message.source.role, 'results')
  assert.deepEqual(new Set(replies[0].message.source.results), new Set([first.message.source.exchangeId, second.message.source.exchangeId]))
  assert.match(textOf(replies[0].message), /Exec10:\nfirst half checked/)
  assert.match(textOf(replies[0].message), /Exec11:\nsecond half checked/)
})

test('W3 admits one remote assignment for a named request, including concurrent retries', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const chief = userTurn(hub, 'chief', 'check a file')
  const send = (message) => messageBot(hub.rt, 'chief', 'Exec10', message, 'file-check')
  const [first, retry] = await Promise.all([send('check the file'), send('check the file')])
  assert.match(String(first), /^Handed to Exec10/)
  assert.equal(retry, first)
  const works = Object.values(hub.rt.state.works).filter(work => work.remote !== undefined)
  assert.equal(works.length, 1)
  await assert.rejects(() => send('run a different check'), /already used for a different request/)
  chief.end('Waiting for the check.')
  await until(() => delivered(n10.w).some(delivery => delivery.message.source.role === 'request'), 'worker received work')
  await settle()
  assert.equal(delivered(n10.w).filter(delivery => delivery.message.source.role === 'request').length, 1)
})

test('W3-E2E-1 a hub Bot hands work to a node Bot: it runs in the receiving Bot\'s own chat, and the hub Bot is resumed once with the result', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const chief = userTurn(hub, 'chief', 'have Exec10 check the build')
  const out = await messageBot(hub.rt, 'chief', 'Exec10', 'check the build')
  assert.match(String(out), /^Handed to Exec10 on box-node010\./)
  chief.end('Exec10 is on it.')
  // On node010: the request stays in Exec10's own chat.
  await until(() => delivered(n10.w).some(d => d.sessionId === 'e10'), 'the request reached node010')

  assert.equal(workThread(n10.w.rt, 'e10'), undefined)
  const request = delivered(n10.w).find(d => d.sessionId === 'e10').message
  assert.equal(textOf(request), '[Message from Chief]\ncheck the build')
  // Exec10 answers in a real turn; the result goes home, and Chief goes on with it once.
  runTurn(n10.w, 'e10', request, 'the build is green')
  await until(() => delivered(hub).some(d => d.sessionId === 'chief' && d.message.source?.role === 'results'), 'Chief was resumed')
  await settle()
  const toChief = delivered(hub).filter(d => d.sessionId === 'chief')
  assert.equal(toChief.length, 1, 'one resume, nothing else')
  assert.equal(toChief[0].message.source.kind, 'bot')
  assert.match(textOf(toChief[0].message), /^\[Work handed back to you · from Exec10 · everything you handed on is back\]\nExec10:\nthe build is green$/)
  assert.equal(Object.keys(n10.w.rt.state.works ?? {}).length, 0, 'node010 owes nothing')
  // Chief goes on with it; nothing is left open on the hub.
  runTurn(hub, 'chief', toChief[0].message, 'Build checked.')
  await until(() => Object.keys(hub.rt.state.works ?? {}).length === 0, 'the hub work is done')
  // The pair's conversation is on the hub: the request, and the answer.
  const book = (await hub.call('exchange', { a: 'chief', b: 'joined:node010:e10' })).value.map(e => [e.role, e.text])
  assert.deepEqual(book, [['request', 'check the build'], ['reply', 'the build is green']])
})

test('W3-E2E-2 node011 and node010 hold three rounds through the hub, in the same chat on node010, and the hub keeps the conversation', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  for (let round = 1; round <= 3; round += 1) {
    const asking = userTurn(n11.w, 'e11', `round ${round}`)
    const out = await messageBot(n11.w.rt, 'e11', 'Exec10', `question ${round}`)
    assert.match(String(out), /^Handed to Exec10 on box-node010\./)
    asking.end(`asked Exec10 (${round})`)

    await until(() => delivered(n10.w).some(d => d.sessionId === 'e10' && d.sessionId === 'e10' && textOf(d.message).endsWith(`question ${round}`)), `round ${round}: the question reached node010`)
    const request = delivered(n10.w).filter(d => d.sessionId === 'e10').at(-1).message
    runTurn(n10.w, 'e10', request, `answer ${round}`)
    await until(() => delivered(n11.w).filter(d => d.sessionId === 'e11' && d.message.source?.role === 'results').length === round, `round ${round}: node011 was resumed`)
    const resume = delivered(n11.w).filter(d => d.sessionId === 'e11').at(-1).message
    assert.match(textOf(resume), new RegExp(`Exec10:\\nanswer ${round}$`))
    runTurn(n11.w, 'e11', resume, `thanks (${round})`)
  }
  assert.equal((n10.w.rt.botOf('e10').tasks ?? []).filter(task => task.origin === 'bot-work').length, 0, 'no background work thread for the pair')
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
  await until(() => delivered(n10.w).some(d => d.sessionId === 'e10' && textOf(d.message).endsWith('when you are back')), 'delivered once node010 is back')

  const request = delivered(n10.w).find(d => d.sessionId === 'e10').message
  runTurn(n10.w, 'e10', request, 'back and done')
  await until(() => delivered(hub).some(d => d.sessionId === 'chief' && /back and done/.test(textOf(d.message))), 'Chief got the result')
  assert.equal(delivered(n10.w).filter(d => textOf(d.message).endsWith('when you are back')).length, 1, 'handled exactly once')
})

test('W3-E2E-4 giving up the wait stops the work on the other machine, and its answer settles nothing here', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const chief = userTurn(hub, 'chief', 'ask Exec10')
  await messageBot(hub.rt, 'chief', 'Exec10', 'long job')
  chief.end('asked')
  await until(() => delivered(n10.w).some(d => d.sessionId === 'e10' && textOf(d.message).endsWith('long job')), 'the request reached node010')

  const request = delivered(n10.w).find(d => d.sessionId === 'e10').message
  const running = runTurn(n10.w, 'e10', request)
  const cancelled = []
  n10.w.agentOf('e10').cancel = cause => { cancelled.push(cause) }
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

test('W3-E2E-6 a node Bot hands work to a hub Bot: it runs in the hub Bot\'s own chat, and the answer goes home', { skip }, async t => {
  const { hub, n11 } = await cluster(t)
  const asking = userTurn(n11.w, 'e11', 'ask Chief')
  assert.match(String(await messageBot(n11.w.rt, 'e11', 'Chief', 'may I deploy?')), /^Handed to Chief on /)
  asking.end('asked Chief')
  await until(() => delivered(hub).some(d => d.sessionId === 'chief'), 'the request is in Chief\'s own chat')

  assert.equal(workThread(hub.rt, 'chief'), undefined)
  runTurn(hub, 'chief', delivered(hub).find(d => d.sessionId === 'chief').message, 'yes, deploy')
  await until(() => delivered(n11.w).some(d => d.sessionId === 'e11' && /yes, deploy/.test(textOf(d.message))), 'the answer reached Exec11')
  assert.equal(delivered(n11.w).filter(d => d.sessionId === 'e11')[0].message.source.role, 'results')
})

test('W3-E2E-7 Chief → Exec11 → Exec10 and back: Exec11 goes on once with Exec10\'s answer, Chief hears nothing before Exec11 is done', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  const chief = userTurn(hub, 'chief', 'run the release')
  await messageBot(hub.rt, 'chief', 'Exec11', 'run the release')
  chief.end('asked Exec11')
  // Exec11 receives the assignment in its own chat, then hands part onward.
  await until(() => delivered(n11.w).some(d => d.sessionId === 'e11'), 'Exec11 got the work')

  const exec11 = runTurn(n11.w, 'e11', delivered(n11.w).find(d => d.sessionId === 'e11').message)
  assert.match(String(await messageBot(n11.w.rt, 'e11', 'Exec10', 'run the tests')), /^Handed to Exec10 on box-node010\. .*Your answer goes to Chief after that\.$/)
  exec11.end('Exec10 runs the tests.')
  await until(() => delivered(n10.w).some(d => d.sessionId === 'e10'), 'Exec10 got its part')

  assert.equal(workThread(n10.w.rt, 'e10'), undefined)
  await new Promise(r => setTimeout(r, 30))
  assert.equal(delivered(hub).filter(d => d.sessionId === 'chief').length, 0, 'Chief hears nothing yet')
  runTurn(n10.w, 'e10', delivered(n10.w).find(d => d.sessionId === 'e10').message, 'tests pass')
  // Exec11 is resumed in its own chat, once, with Exec10's answer.
  await until(() => delivered(n11.w).some(d => d.sessionId === 'e11' && d.message.source?.role === 'results'), 'Exec11 was resumed')
  const resume = delivered(n11.w).filter(d => d.sessionId === 'e11').at(-1).message
  assert.match(textOf(resume), /Exec10:\ntests pass$/)
  assert.equal(delivered(hub).filter(d => d.sessionId === 'chief').length, 0, 'still nothing for Chief')
  runTurn(n11.w, 'e11', resume, 'released: tests pass')
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

    await until(() => delivered(n10.w).some(d => d.sessionId === 'e10' && textOf(d.message).endsWith(`question ${round}`)), `round ${round} reached node010`)
    // The hub's roster push lands on node010 now, before it answers.
    assert.equal(await handlePeerRoster(n10.w.rt, { hubId: 'hub-1', level: 'off', bots: [] }), true)
    assert.ok(peer(n10.w.rt, 'Exec11'), 'the directory row for Exec11 is still there')
    runTurn(n10.w, 'e10', delivered(n10.w).filter(d => d.sessionId === 'e10').at(-1).message, `answer ${round}`)
    await until(() => delivered(n11.w).some(d => d.sessionId === 'e11' && textOf(d.message).endsWith(`answer ${round}`)), `round ${round} answered`)
    runTurn(n11.w, 'e11', delivered(n11.w).filter(d => d.sessionId === 'e11').at(-1).message, 'ok')
  }
})

test('W3-E2E-9 the asker\'s stand-in is gone when the answer is ready: it still goes home, to where the work came from', { skip }, async t => {
  const { n10, n11 } = await cluster(t)
  const asking = userTurn(n11.w, 'e11', 'ask')
  await messageBot(n11.w.rt, 'e11', 'Exec10', 'question')
  asking.end('asked')
  await until(() => delivered(n10.w).some(d => d.sessionId === 'e10' && textOf(d.message).endsWith('question')), 'reached node010')

  delete n10.w.rt.state.bots[peer(n10.w.rt, 'Exec11').id]
  runTurn(n10.w, 'e10', delivered(n10.w).find(d => d.sessionId === 'e10').message, 'answer')
  await until(() => delivered(n11.w).some(d => d.sessionId === 'e11' && textOf(d.message).endsWith('answer')), 'the answer reached node011 anyway')
})

// ── W4: the hub's page of a node Bot is a copy of the Bot's own chat ──

// One turn of Exec10's own chat on node010, as DSH records it, with the events a page shows and some it does not.
function nodeTurn(w, sessionId, turn, { seqFrom, said, rpcId }) {
  let seq = seqFrom
  const emit = (type, data) => w.sessionEvent(sessionId, { type, seq: ++seq, data })
  emit('turn/start', { turn })
  emit('request/context', { provider: 'p', model: 'm' })
  emit('step/start', { turn, step: 1 })
  emit('user/message', { role: 'user', content: [{ type: 'text', text: `question ${turn}` }, { type: 'image', attachment: { id: 'node-local-1', name: 'shot.png' } }], source: { kind: 'user', ...(rpcId ? { rpcId } : {}) } })
  emit('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'let me look' }, { type: 'tool-call', id: `c${turn}`, name: 'bash', arguments: '{"command":"ls"}' }] }, stream: [{ type: 'text-delta', text: 'x'.repeat(5000) }] })
  emit('tool/call', { turn, step: 1, callId: `c${turn}`, name: 'bash', arguments: '{"command":"ls"}' })
  emit('tool/result', { turn, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: `c${turn}` }, toolCallId: `c${turn}`, content: [{ type: 'text', text: 'y'.repeat(40_000) }], isError: false } })
  emit('step/end', { turn, step: 1 })
  emit('step/start', { turn, step: 2 })
  emit('assistant/message', { turn, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: said }] }, stream: [] })
  emit('step/end', { turn, step: 2 })
  emit('turn/end', { turn, reason: { kind: 'completed' } })
  return seq
}
const pageOf = (hub, botId) => hub.agents.get(hub.rt.botOf(botId).sessionId)?.session

test('W4-1 a node Bot\'s own chat is copied to its hub page in order, with the page\'s turn numbers, and nothing else writes there', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  hub.rt.joinedRequests = new Map([['turn-x', 'page-request-1']])
  hub.rt.joinedRequestOf = id => hub.rt.joinedRequests.get(id)
  let seq = nodeTurn(n10.w, 'e10', 1, { seqFrom: 0, said: 'first answer', rpcId: 'turn-x' })
  seq = nodeTurn(n10.w, 'e10', 2, { seqFrom: seq, said: 'second answer' })
  await until(() => (pageOf(hub, 'joined:node010:e10')?.log ?? []).filter(e => e.type === 'turn/end').length === 2, 'both turns on the hub page')
  const page = pageOf(hub, 'joined:node010:e10')
  // What a page shows, in order; the request context stays on the node.
  assert.deepEqual(page.log.filter(e => e.data?.turn === 1 || e.type === 'user/message').slice(0, 11).map(e => e.type),
    ['turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
  assert.equal(page.log.some(e => e.type === 'request/context'), false)
  assert.deepEqual(page.log.filter(e => e.type === 'turn/start').map(e => e.data.turn), [1, 2])
  // The page's own message comes back with the page's request id; a node attachment is a line of text.
  const user = page.log.find(e => e.type === 'user/message')
  assert.equal(user.data.source.rpcId, 'page-request-1')
  assert.deepEqual(user.data.content.map(b => b.text ?? b.type), ['question 1', '[图片 shot.png]'])
  // No stream chunks; a huge tool result is cut and says so.
  assert.deepEqual(page.log.filter(e => e.type === 'assistant/message').map(e => e.data.stream.length), [0, 0, 0, 0])
  const result = page.log.find(e => e.type === 'tool/result').data.message.content[0].text
  assert.ok(result.length < 17_000 && /more characters on the node\]$/.test(result))
  assert.deepEqual(page.log.filter(e => e.type === 'assistant/message').at(-1).data.message.content, [{ type: 'text', text: 'second answer' }])

  // Only the copy writes the page: another writer of this plugin is held off.
  const before = page.log.length
  page.append('user/message', { role: 'user', content: [{ type: 'text', text: 'made up on the hub' }], source: { kind: 'user' } })
  assert.equal(page.log.length, before)

  // A part switch on the node starts its turns from 1 again; the page goes on counting.
  nodeTurn(n10.w, 'e10-part2', 1, { seqFrom: 0, said: 'after the switch' })
  n10.w.rt.chatOwners.set('e10-part2', 'e10')
  nodeTurn(n10.w, 'e10-part2', 1, { seqFrom: 100, said: 'after the switch' })
  await until(() => page.log.filter(e => e.type === 'turn/end').length === 3, 'the next part\'s turn is on the page')
  assert.deepEqual(page.log.filter(e => e.type === 'turn/start').map(e => e.data.turn), [1, 2, 3])
})

test('W4-2 a copy sent twice is written once, and a turn whose start the copy missed still lands in a turn', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const network = n10.network
  const ref = { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }
  const post = (seq, type, data) => network.post('team/conv', { bot: ref, sid: 'e10', seq, type, data })
  post(5, 'step/start', { turn: 7, step: 1 })
  post(6, 'assistant/message', { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'mid-turn' }] }, stream: [] })
  post(6, 'assistant/message', { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'mid-turn' }] }, stream: [] })
  post(7, 'step/end', { turn: 7, step: 1 })
  post(8, 'turn/end', { turn: 7, reason: { kind: 'completed' } })
  await until(() => (pageOf(hub, 'joined:node010:e10')?.log ?? []).some(e => e.type === 'turn/end'), 'the turn ended on the page')
  const page = pageOf(hub, 'joined:node010:e10')
  assert.deepEqual(page.log.map(e => [e.type, e.data.turn]), [['turn/start', 1], ['step/start', 1], ['assistant/message', 1], ['step/end', 1], ['turn/end', 1]])
  assert.deepEqual(hub.rt.ctx.get('remote-agent:bot-network').reliablePending(), [], 'nothing left to send again')
})

test('W4-3 a node Bot\'s work thread is copied to the hub too: listed on its page, readable there, standing between works', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const asker = peer(n10.w.rt, 'Chief')
  const { task, sessionId } = await n10.w.rt.workThreadFor(n10.w.rt.botOf('e10'), asker, 'compat-test')
  n10.w.rt.openWork('w4-copy-test', { from: asker.id, to: 'e10' })
  await n10.w.rt.workThreadTakes(task, 'w4-copy-test')
  await n10.w.rt.deliver({ fromId: asker.id, toId: 'e10', sessionId, role: 'request', exchangeId: 'w4-copy-test', text: 'check the build' })
  await until(() => workThread(n10.w.rt, 'e10') !== undefined && delivered(n10.w).some(d => d.sessionId === workThread(n10.w.rt, 'e10').sessionId), 'the request reached node010')
  const thread = workThread(n10.w.rt, 'e10')
  const request = delivered(n10.w).find(d => d.sessionId === thread.sessionId).message
  runTurn(n10.w, thread.sessionId, request, 'the build is green')
  const copyOf = () => hub.rt.state.replicas?.['joined:node010:e10']?.tasks?.[thread.id]
  await until(() => copyOf()?.sessionId !== undefined && (hub.agents.get(copyOf().sessionId)?.session.log ?? []).some(e => e.type === 'turn/end'), 'the thread\'s turn is on the hub')
  const copy = hub.agents.get(copyOf().sessionId).session
  // No system/message head: DSH stores one only inside a turn, and would keep nothing after it.
  assert.deepEqual(copy.log.map(e => e.type), ['turn/start', 'user/message', 'assistant/message', 'turn/end'])
  assert.equal(textOf(copy.log.find(e => e.type === 'user/message').data), '[Message from Chief]\ncheck the build')
  // Not on the Bot's own page: that stays its chat with the user.
  assert.equal((pageOf(hub, 'joined:node010:e10')?.log ?? []).some(e => /check the build/.test(JSON.stringify(e.data))), false)
  // The hub lists it on Exec10's page, standing by, and opens it.
  await until(() => thread.status === 'standing', 'the thread stands by on node010')
  hub.rt.state.mainBotIds = ['chief']
  const answer = await hub.call('state', {})
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 400))
  const row = answer.value.bots.find(b => b.id === 'joined:node010:e10')
  const listed = (row.tasks ?? []).find(task => task.id === thread.id)
  assert.equal(listed?.title, '@Chief · 工作')
  assert.equal(listed.status, 'standing')
  assert.equal(listed.viewable, true)
  const read = await hub.call('bot-task-read', { botId: 'joined:node010:e10', taskId: thread.id })
  assert.equal(read.ok, true, JSON.stringify(read))
  assert.equal(read.value.sessionId, copyOf().sessionId)
  // Only the copy writes there.
  const before = copy.log.length
  copy.append('user/message', { role: 'user', content: [{ type: 'text', text: 'made up' }] }, { surfaceOp: 'append' })
  assert.equal(copy.log.length, before)
})

test('W4-4 a tool result the copy lost does not leave the page unloadable: the step is answered before it ends', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const ref = { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }
  const post = (seq, type, data) => n10.network.post('team/conv', { bot: ref, sid: 'e10', seq, type, data })
  post(1, 'turn/start', { turn: 1 })
  post(2, 'step/start', { turn: 1, step: 1 })
  post(3, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'k1', name: 'message_bot', arguments: '{}' }, { type: 'tool-call', id: 'k2', name: 'list_bots', arguments: '{}' }] }, stream: [] })
  post(4, 'tool/call', { turn: 1, step: 1, callId: 'k1', name: 'message_bot', arguments: '{}' })
  // seq 5 (k1's result) and k2's call and result never reach the page.
  post(8, 'step/end', { turn: 1, step: 1 })
  post(9, 'step/start', { turn: 1, step: 2 })
  post(10, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'handed on' }] }, stream: [] })
  post(11, 'step/end', { turn: 1, step: 2 })
  post(12, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => (pageOf(hub, 'joined:node010:e10')?.log ?? []).some(e => e.type === 'turn/end'), 'the turn ended on the page')
  const page = pageOf(hub, 'joined:node010:e10')
  assert.deepEqual(page.log.map(e => e.type), ['turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'tool/call', 'tool/result', 'step/end', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
  const results = page.log.filter(e => e.type === 'tool/result')
  assert.deepEqual(results.map(e => e.data.message.source.callId), ['k1', 'k2'])
  assert.match(results[0].data.message.content[0].text, /did not reach the hub/)
})

test('W4-5 a node turn whose end never came is closed whole when the next one starts: open calls answered, step ended', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const ref = { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }
  const post = (seq, type, data) => n10.network.post('team/conv', { bot: ref, sid: 'e10', seq, type, data })
  post(1, 'turn/start', { turn: 1 })
  post(2, 'step/start', { turn: 1, step: 1 })
  post(3, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'k1', name: 'bash', arguments: '{}' }] }, stream: [] })
  post(4, 'tool/call', { turn: 1, step: 1, callId: 'k1', name: 'bash', arguments: '{}' })
  // The node restarted and goes on in a new part of the chat: its next turn begins there.
  n10.network.post('team/conv', { bot: ref, sid: 'e10-part2', seq: 1, type: 'turn/start', data: { turn: 1 } })
  await until(() => (pageOf(hub, 'joined:node010:e10')?.log ?? []).filter(e => e.type === 'turn/start').length === 2, 'the next turn is on the page')
  const page = pageOf(hub, 'joined:node010:e10')
  assert.deepEqual(page.log.map(e => [e.type, e.data.turn]), [['turn/start', 1], ['step/start', 1], ['assistant/message', 1], ['tool/call', 1], ['tool/result', 1], ['step/end', 1], ['turn/end', 1], ['turn/start', 2]])
  assert.equal(page.log.find(e => e.type === 'turn/end').data.reason.kind, 'interrupted')
})

test('W4-6 a work-thread copy fork.119 made (nothing of it stored) is started again', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  hub.rt.state.replicas = { 'joined:node010:e10': { sessions: {}, tasks: { t1: { title: '@Chief · 工作', sessionId: 'old-copy', sessions: { 'w-1': { seq: 50, turns: {} } } } } } }
  const ref = { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }
  const task = { id: 't1', title: '@Chief · 工作', origin: 'bot-work' }
  n10.network.post('team/conv', { bot: ref, sid: 'w-1', seq: 51, type: 'turn/start', data: { turn: 9 }, task })
  await until(() => hub.rt.state.replicas['joined:node010:e10'].tasks.t1.v === 2 && (hub.agents.get(hub.rt.state.replicas['joined:node010:e10'].tasks.t1.sessionId)?.session.log ?? []).length === 1, 'the copy started again')
  const entry = hub.rt.state.replicas['joined:node010:e10'].tasks.t1
  assert.notEqual(entry.sessionId, 'old-copy')
  assert.deepEqual(entry.sessions, { 'w-1': { seq: 51, turns: { 9: 1 } } })
})

test('W4-7 a copied message names its Bots as the hub knows them: who sent it, and whose results it brings back', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const ref = { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }
  const post = (seq, type, data) => n10.network.post('team/conv', { bot: ref, sid: 'e10', seq, type, data })
  post(1, 'turn/start', { turn: 1 })
  post(2, 'step/start', { turn: 1, step: 1 })
  // On node010, Exec11 is its peer row and Chief the hub's; Exec10 itself is a local id there.
  post(3, 'user/message', { role: 'user', content: [{ type: 'text', text: '[Work handed back to you · from Exec11]\nExec11:\nok' }], source: { kind: 'bot', role: 'results', resultFrom: ['peer:hub:node011:joined%3Anode011%3Ae11', 'peer:hub:hub:chief', 'e10', 'peer:hub:node099:gone'] } })
  post(4, 'user/message', { role: 'user', content: [{ type: 'text', text: '[Message from Chief]\nhi' }], source: { kind: 'bot', role: 'request', senderSessionId: 'peer:hub:hub:chief', senderName: 'Chief' } })
  await until(() => (pageOf(hub, 'joined:node010:e10')?.log ?? []).filter(e => e.type === 'user/message').length === 2, 'both messages on the page')
  const [results, request] = pageOf(hub, 'joined:node010:e10').log.filter(e => e.type === 'user/message')
  assert.deepEqual(results.data.source.resultFrom, ['joined:node011:e11', 'chief', 'joined:node010:e10', 'peer:hub:node099:gone'])
  assert.equal(request.data.source.senderSessionId, 'chief')
})

test('W3-E2E-10 the answer from another machine reaches a node Bot whose turn is still running: steered into that turn at once, read once', { skip }, async t => {
  const { n10, n11 } = await cluster(t)
  const asking = userTurn(n11.w, 'e11', 'ask Exec10, then keep checking things')
  await messageBot(n11.w.rt, 'e11', 'Exec10', 'question')
  // Exec11 goes on in the same turn (no end yet) while Exec10 answers on node010.
  await until(() => delivered(n10.w).some(d => d.sessionId === 'e10' && textOf(d.message).endsWith('question')), 'reached node010')

  runTurn(n10.w, 'e10', delivered(n10.w).find(d => d.sessionId === 'e10').message, 'answer')
  await until(() => n11.w.steers.some(d => d.sessionId === 'e11'), 'steered into the running turn on node011')
  const steered = n11.w.steers.find(d => d.sessionId === 'e11').message
  assert.equal(steered.source.role, 'results')
  assert.match(textOf(steered), /Exec10:\nanswer$/)
  assert.equal(n11.w.followups.some(d => d.sessionId === 'e11'), false, 'not queued for after the turn')
  // The turn reads it and ends: nothing comes again.
  n11.w.sessionEvent('e11', { type: 'user/message', seq: 900, data: { content: steered.content, source: steered.source } })
  asking.end('Exec10 answered')
  await settle()
  await settle()
  assert.equal(delivered(n11.w).filter(d => d.sessionId === 'e11').length, 1)
})

// ── fork.125: Stop stops what was handed on, across machines; loops and depth are refused across machines ──

test('W3-E2E-11 the user stops Chief: Exec11 on node011 and Exec10 on node010, working on what Chief handed on, both stop, and nothing comes back', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  userTurn(hub, 'chief', 'run the release')
  await messageBot(hub.rt, 'chief', 'Exec11', 'run the release')
  await until(() => delivered(n11.w).some(d => d.sessionId === 'e11'), 'Exec11 got the work')

  const exec11 = runTurn(n11.w, 'e11', delivered(n11.w).find(d => d.sessionId === 'e11').message)
  const cancelled11 = []
  n11.w.agentOf('e11').cancel = cause => { cancelled11.push(cause) }
  await messageBot(n11.w.rt, 'e11', 'Exec10', 'run the tests')
  await until(() => delivered(n10.w).some(d => d.sessionId === 'e10'), 'Exec10 got its part')

  const exec10 = runTurn(n10.w, 'e10', delivered(n10.w).find(d => d.sessionId === 'e10').message)
  const cancelled10 = []
  n10.w.agentOf('e10').cancel = cause => { cancelled10.push(cause) }
  // The user presses Stop on Chief's turn.
  hub.sessionEvent('chief', { type: 'turn/end', seq: 99, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await until(() => cancelled11.length === 1 && cancelled10.length === 1, 'both turns on the nodes were stopped')
  assert.equal(Object.keys(n11.w.rt.state.works ?? {}).length, 0, 'node011 owes nothing')
  assert.equal(Object.keys(n10.w.rt.state.works ?? {}).length, 0, 'node010 owes nothing')
  // The stopped turns end; nothing goes home, and Chief is not woken.
  exec10.end('tests pass')
  exec11.end('released')
  await new Promise(r => setTimeout(r, 50))
  await settle()
  assert.equal(delivered(hub).filter(d => d.sessionId === 'chief').length, 0, 'nothing comes back to Chief')
  assert.equal(delivered(n11.w).filter(d => d.sessionId === 'e11').length, 1, 'nothing comes back to Exec11')
})

test('W3-E2E-12 a Bot may not hand work back to a Bot waiting above it on another machine: refused at the sender, and at the receiver', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  userTurn(hub, 'chief', 'run the release')
  await messageBot(hub.rt, 'chief', 'Exec11', 'run the release')
  await until(() => delivered(n11.w).some(d => d.sessionId === 'e11'), 'Exec11 got the work')

  runTurn(n11.w, 'e11', delivered(n11.w).find(d => d.sessionId === 'e11').message)
  // Back to Chief, from Exec11's work on it: refused on node011, nothing is sent.
  const back = String(await messageBot(n11.w.rt, 'e11', 'Chief', 'what do you think?'))
  assert.match(back, /^Not sent: Chief is waiting for the result of the work you are doing/)
  // Exec11 → Exec10 is fine; then Exec10 → Chief and Exec10 → Exec11 are refused on node010.
  await messageBot(n11.w.rt, 'e11', 'Exec10', 'run the tests')
  await until(() => delivered(n10.w).some(d => d.sessionId === 'e10'), 'Exec10 got its part')

  runTurn(n10.w, 'e10', delivered(n10.w).find(d => d.sessionId === 'e10').message)
  assert.match(String(await messageBot(n10.w.rt, 'e10', 'Chief', 'ok?')), /^Not sent: Chief is waiting/)
  assert.match(String(await messageBot(n10.w.rt, 'e10', 'Exec11', 'ok?')), /^Not sent: Exec11 is waiting/)
  // A frame from a sender that did not check is refused at the receiver: Exec11 is in the chain it came with.
  n10.network.post('work/handoff', { id: 'loop-1', from: { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }, to: { id: 'joined:node011:e11', name: 'Exec11', nodeId: 'node011' }, part: 'x', text: 'again', chain: [{ id: 'chief', nodeId: 'hub' }, { id: 'joined:node011:e11', nodeId: 'node011' }, { id: 'joined:node010:e10', nodeId: 'node010' }] }, { to: 'node011' })
  await settle()
  await settle()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(n11.w.rt.state.works?.['loop-1'], undefined, 'not taken on node011')
  assert.equal(delivered(n11.w).some(d => textOf(d.message).endsWith('again')), false)
})

// fork.129 (AC 0.4.40 direct links): a stop and its work can take different ways, so the stop may come first.
test('W3-E2E-14 a stop that arrives before its work: the work is not taken when it comes, and the asker hears it stopped', { skip }, async t => {
  const { hub, n10, goDown, comeBack } = await cluster(t)
  goDown('node010')
  const chief = userTurn(hub, 'chief', 'have Exec10 check the build')
  await messageBot(hub.rt, 'chief', 'Exec10', 'check the build')
  chief.end('Exec10 is on it.')
  const id = Object.keys(hub.rt.state.works).find(key => hub.rt.state.works[key].remote?.nodeId === 'node010')
  assert.ok(id, 'the work is open on the hub')
  // its work/cancel reaches node010 first (the other way); the handoff is still held at the hub
  n10.network.receiveReliable('rel/frame', { rid: `cancel-${id}`, type: 'work/cancel', data: { id } })
  await settle()
  assert.equal(n10.w.rt.state.cancelledAhead?.[id]?.nodeId, 'hub')
  comeBack('node010')
  await until(() => hub.rt.state.works?.[id] === undefined || (hub.rt.state.works[id].results ?? []).length > 0 || delivered(hub).some(d => d.sessionId === 'chief' && d.message.source?.role === 'results'), 'the hub heard back')
  await settle()
  assert.equal(n10.w.rt.state.works?.[id], undefined, 'node010 did not take it')
  assert.equal(!delivered(n10.w).some(d => d.sessionId === 'e10' && d.message.source?.role === 'request'), true, 'Exec10 never got the request')
  assert.equal(n10.w.rt.state.cancelledAhead?.[id], undefined, 'the mark is used up')
  const back = delivered(hub).find(d => d.sessionId === 'chief' && d.message.source?.role === 'results')
  if (back) assert.match(textOf(back.message), /Stopped before it started/)
})

// fork.129 follow-up (stored page of a node task, 2026-11-26): DSH closes a turn it finds open when it loads a Session
// again ("interrupted", with a result for the call that had none). The copy kept its own record of the open turn, so
// the node's steps that came next were written under a turn that was no longer open, and the page could not be opened.
test('W4-8 the page closed a copied turn itself: the node\'s later steps go in a turn of their own, and nothing is written outside a turn', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  const ref = { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }
  const post = (seq, type, data) => n10.network.post('team/conv', { bot: ref, sid: 'e10', seq, type, data })
  post(1, 'turn/start', { turn: 1 })
  post(2, 'step/start', { turn: 1, step: 1 })
  post(3, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'k1', name: 'bash', arguments: '{}' }] }, stream: [] })
  post(4, 'tool/call', { turn: 1, step: 1, callId: 'k1', name: 'bash', arguments: '{}' })
  await until(() => (pageOf(hub, 'joined:node010:e10')?.log ?? []).some(e => e.type === 'tool/call'), 'the first steps are on the page')
  const page = pageOf(hub, 'joined:node010:e10')
  // DSH loads the page again and closes what it finds open, as it does after a restart. It writes through the Session's
  // own append: the page refuses any other writer than the copy.
  const held = Object.getOwnPropertySymbols(page).find(symbol => String(symbol).includes('replica page'))
  const dsh = (type, data, options) => page[held].call(page, type, data, options)
  dsh('tool/result', { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'k1' }, toolCallId: 'k1', content: [{ type: 'text', text: 'The tool call was interrupted after it was recorded, but no result.' }], isError: true, id: 'interrupted-k1' } }, { surfaceOp: 'append' })
  dsh('step/end', { turn: 1, step: 1 })
  dsh('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  const before = page.log.length
  // The node goes on: the result the page lost, the step's end, then a new step, and the turn's end.
  post(5, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'k1' }, toolCallId: 'k1', content: [{ type: 'text', text: 'late result' }], isError: false } })
  post(6, 'step/end', { turn: 1, step: 1 })
  post(7, 'step/start', { turn: 1, step: 2 })
  post(8, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] }, stream: [] })
  post(9, 'step/end', { turn: 1, step: 2 })
  post(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => page.log.length > before && page.log.at(-1).type === 'turn/end' && page.log.at(-1).data.reason.kind === 'completed', 'the node\'s turn is closed on the page')
  // Replay the page the way DSH's loader does: every turn/step event inside an open turn (and step) of its own number.
  let turn
  let step
  let lastStep = 0
  let lastTurn = 0
  for (const event of page.log) {
    const d = event.data ?? {}
    if (event.type === 'turn/start') { assert.equal(turn, undefined, `turn/start ${d.turn} while turn ${turn} is open`); assert.equal(d.turn, lastTurn + 1, 'turns count up'); turn = d.turn; lastTurn = d.turn; step = undefined; lastStep = 0; continue }
    if (event.type === 'turn/end') { assert.equal(d.turn, turn, `turn/end ${d.turn} outside turn ${turn}`); turn = undefined; step = undefined; continue }
    if (event.type === 'step/start') { assert.notEqual(turn, undefined, 'step/start outside a turn'); assert.equal(d.turn, turn); assert.equal(step, undefined, 'a step is open'); assert.equal(d.step, lastStep + 1, 'steps count up from 1'); step = d.step; lastStep = d.step; continue }
    if (event.type === 'step/end') { assert.equal([d.turn, d.step].join(), [turn, step].join(), `step/end ${d.turn}/${d.step} outside the open step ${turn}/${step}`); step = undefined; continue }
    if (['assistant/message', 'tool/call', 'tool/result'].includes(event.type) && d.turn !== undefined) assert.equal(turn, d.turn, `${event.type} of turn ${d.turn} outside it (open: ${turn})`)
  }
  assert.equal(turn, undefined, 'no turn is left open')
  assert.equal(page.log.filter(e => e.type === 'turn/start').length, 2, 'the rest of the node turn has a turn of its own')
  assert.equal(JSON.stringify(page.log).includes('late result'), false, 'what belonged to the step the page had closed is not written again')
  assert.equal(JSON.stringify(page.log).includes('all done'), true)
})

test('W3-E2E-13 depth: work that passed through too many hands is not taken, and one at the limit cannot be handed on further', { skip }, async t => {
  const { n10, n11 } = await cluster(t)
  const refs = n => ['a', 'b', 'c', 'd', 'e'].slice(0, n).map(id => ({ id: `x-${id}`, nodeId: 'hub' }))
  // Five Bots above already: refused on node010, never started.
  n11.network.post('work/handoff', { id: 'deep-1', from: { id: 'joined:node011:e11', name: 'Exec11', nodeId: 'node011' }, to: { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }, part: 'x', text: 'deep work', chain: refs(5) }, { to: 'node010' })
  await settle()
  await settle()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(n10.w.rt.state.works?.['deep-1'], undefined)
  assert.equal(delivered(n10.w).some(d => textOf(d.message).endsWith('deep work')), false)
  // Four above (the limit): taken, but Exec10 may not hand it on again.
  n11.network.post('work/handoff', { id: 'deep-2', from: { id: 'joined:node011:e11', name: 'Exec11', nodeId: 'node011' }, to: { id: 'joined:node010:e10', name: 'Exec10', nodeId: 'node010' }, part: 'x', text: 'at the limit', chain: [...refs(3), { id: 'joined:node011:e11', nodeId: 'node011' }] }, { to: 'node010' })
  await until(() => delivered(n10.w).some(d => d.sessionId === 'e10' && textOf(d.message).endsWith('at the limit')), 'taken on node010')

  runTurn(n10.w, 'e10', delivered(n10.w).find(d => textOf(d.message).endsWith('at the limit')).message)
  assert.match(String(await messageBot(n10.w.rt, 'e10', 'Chief', 'one more hand')), /^Not sent: this work has already passed through 4 Bots/)
})
