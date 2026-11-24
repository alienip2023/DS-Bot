// R2（重写 2026-11-24）：跨机器的 Bot 间一来一回。三台机器各一个真实的 ds-bot 运行时，中间是 AC 的
// 真实代码：节点 bot-network（sendAssign / receiveAssign）、主控 ingest（转发 / 退回）、主控 bot-network。
// 场景：node011 的 Bot 用 message_bot 找 node010 的 Bot，往返三轮；node010 断线时消息进发件箱等待，
// 不计时，回来后自动补发。需要 AC 仓库（REMOTE_AGENT_REPO 或同级 dsh-ai-cluster）。
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
  .find(dir => existsSync(join(dir, 'lib/protocol.js')))
const skip = repo === undefined ? 'AC repo not found (set REMOTE_AGENT_REPO)' : false
const load = file => import(pathToFileURL(join(repo, 'lib', file)).href)
const settle = async (times = 8) => { for (let i = 0; i < times; i += 1) await new Promise(r => setImmediate(r)) }
// Delivery writes the pair ledger and the team file before it goes on: wait for the outcome, not for ticks.
async function until(check, label, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 10)) }
  assert.fail(`timed out: ${label}`)
}

const bot = (id, name, extra = {}) => ({ id, sessionId: id, name, role: 'Exec', instructions: '', createdAt: 1, ...extra })
const joined = (nodeId, id, name) => bot(`joined:${nodeId}:${id}`, name, { type: 'remote-worker', origin: 'joined', worker: { home: 'remote', online: true, nodeId, remoteBotId: id, hostname: `box-${nodeId}` } })
const team = bots => ({ version: 1, mainBotIds: [], revision: 1, whaleStored: true, bots: Object.fromEntries(bots.map(b => [b.id, b])), rooms: {}, exchanges: [], exchangeTurns: {}, questions: {} })

async function cluster(t) {
  const { withIngest } = await load('hub/registry-ingest.js')
  const { createHubBotNetwork } = await load('hub/bot-network.js')
  const { createBotNetwork } = await load('node/bot-network.js')
  const nodes = new Map()
  class Core extends EventEmitter {
    constructor() { super(); this.nodes = new Map([['node010', { nodeId: 'node010', online: true }], ['node011', { nodeId: 'node011', online: true }]]); this.log = () => {} }
    send(nodeId, type, data) {
      if (!this.nodes.get(nodeId)?.online) return false
      const network = nodes.get(nodeId)
      if (type === 'bot/assign') network.receiveAssign(structuredClone(data))
      else if (type === 'team/act-result') network.receiveTeamActResult(structuredClone(data))
      else if (type === 'bot/directory') network.receiveDirectory(structuredClone(data))
      return true
    }
    list() { return [...this.nodes.values()].map(n => ({ nodeId: n.nodeId, hostname: `box-${n.nodeId}`, os: 'linux', online: n.online })) }
    onlineNodes() { return this.list().filter(n => n.online) }
    getNode(nodeId) { return this.nodes.get(nodeId) }
  }
  const registry = new (withIngest(Core))()
  let hubCtx
  const hubNetwork = createHubBotNetwork({ registry, ctx: { get: (name, d) => hubCtx?.get(name, d) } })
  const world = (home, state, services) => {
    writeFileSync(join(home, 'state.json'), JSON.stringify(state))
    return threadWorld({ home, services })
  }
  const hub = world(mkdtempSync(join(tmpdir(), 'r2-hub-')), team([bot('chief', 'Chief', {}), joined('node010', 'e10', 'node010执行'), joined('node011', 'e11', 'node011执行')]),
    { 'remote-agent:registry': registry, 'remote-agent:bot-network': hubNetwork })
  const node = (nodeId, local) => {
    const toHub = (type, data) => { if (!registry.nodes.get(nodeId)?.online) return false; registry.handleFrameFor(nodeId, { t: type, d: structuredClone(data) }); return true }
    const network = createBotNetwork({ nodeId, send: toHub, sendHub: toHub })
    nodes.set(nodeId, network)
    return { network, w: world(mkdtempSync(join(tmpdir(), `r2-${nodeId}-`)), team([local]), { 'remote-agent:bot-network': network }) }
  }
  hubCtx = hub.ctx
  // The hub writes node Bots' mirror pages: its stand-in Sessions log what is appended, as DSH's do.
  const resolve = hub.ctx.sessionController.resolveAgent
  hub.ctx.sessionController.resolveAgent = async (sessionId) => {
    const out = await resolve(sessionId)
    const session = out.agent.session
    if (typeof session.append !== 'function') session.append = (type, data) => { const event = { type, seq: ++session.seq, time: Date.now(), data }; session.log.push(event); return event }
    return out
  }
  const n10 = node('node010', bot('e10', 'node010执行'))
  const n11 = node('node011', bot('e11', 'node011执行'))
  await Promise.all([hub.rt.load(), n10.w.rt.load(), n11.w.rt.load()])
  t.after(async () => { for (const w of [hub, n10.w, n11.w]) await w.ctx.dispose?.() })
  await publishDirectory(hub.rt)
  if (process.env.R3_DEBUG) for (const [name, w] of [['hub', hub], ['n10', n10.w], ['n11', n11.w]]) { const warn = w.rt.warn; w.rt.warn = (...a) => { console.log('WARN', name, ...a); return warn?.(...a) } }
  return { registry, hub, n10, n11 }
}

const textsIn = (w, sessionId) => [...w.followups, ...w.steers, ...w.prompts.map(p => ({ sessionId: p.request.sessionId, message: p.request.message ?? p.request }))]
  .filter(item => item.sessionId === sessionId)
  .map(item => JSON.stringify(item.message))
// Where a cross-machine request runs (rewrite R3): a background task of the recipient, not its chat.
const taskSessions = (w, botId) => (w.rt.botOf(botId)?.tasks ?? []).map(task => task.sessionId)
const taskTexts = (w, botId) => taskSessions(w, botId).flatMap(sessionId => textsIn(w, sessionId))
const peerOf = (rt, name) => Object.values(rt.state.bots).find(b => b.origin === 'peer' && b.name === name)
const messageBot = (rt, from, to, message) => rt.teamTools.find(def => def.name === 'message_bot')
  .execute({ to, message }, { agent: { id: from }, callId: 'c', signal: new AbortController().signal })

// What node010's Bot does when it has read the request: answer it, the way turns.js answers a request.
async function answer(rt, botId, requestText, reply) {
  const work = Object.entries(rt.state.works ?? {}).find(([, w]) => w.to === botId)
  assert.ok(work, `node010 has open work for the request "${requestText}"`)
  const [exchangeId, entry] = work
  rt.closeWork(exchangeId, rt.botOf(botId).name, reply)
  await rt.deliver({ fromId: botId, toId: entry.from, role: 'reply', replyTo: exchangeId, text: reply })
}

test('R2-E2E-1 node011 ↔ node010: three rounds, each reply closes the sender work and reaches its chat', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  assert.ok(peerOf(n11.w.rt, 'node010执行'), 'node011 sees node010 Bot from the directory')
  for (let round = 1; round <= 3; round += 1) {
    const out = await messageBot(n11.w.rt, 'e11', 'node010执行', `第 ${round} 回合：你好`)
    assert.match(String(out), /Delivered to node010执行/)
    const opened = Object.values(n11.w.rt.state.works ?? {}).filter(w => w.from === 'e11')
    assert.equal(opened.length, 1, `round ${round}: node011 waits for one answer`)
    await until(() => taskTexts(n10.w, 'e10').some(text => text.includes(`第 ${round} 回合：`)), `round ${round}: the request reached a node010 background task`)
    assert.equal(textsIn(n10.w, 'e10').length, 0, `round ${round}: nothing in node010 Bot's own chat (the user's window)`)
    if (round > 1) {
      const latest = taskTexts(n10.w, 'e10').find(text => text.includes(`第 ${round} 回合：`))
      assert.match(latest, /Earlier in your conversation with node011执行/, `round ${round}: the fresh task carries the conversation on`)
      assert.ok(latest.includes(`第 ${round - 1} 回合收到`), `round ${round}: it knows its last answer`)
    }
    await until(() => n11.w.rt.assign.pending().length === 0, `round ${round}: node010 acked the request`)
    await answer(n10.w.rt, 'e10', `第 ${round} 回合`, `第 ${round} 回合收到`)
    await until(() => textsIn(n11.w, 'e11').some(text => text.includes(`第 ${round} 回合收到`)), `round ${round}: the reply reached node011 Bot chat`)
    assert.equal(Object.values(n11.w.rt.state.works ?? {}).filter(w => w.from === 'e11').length, 0, `round ${round}: the reply closed node011 work`)
    await until(() => n10.w.rt.assign.pending().length === 0, `round ${round}: node011 acked the reply`)
  }
  // The read-only exchange view (the "Reply from" line opens it) shows both sides on both machines.
  const peer10 = peerOf(n11.w.rt, 'node010执行')
  const peer11early = peerOf(n10.w.rt, 'node011执行')
  // A message shows once the other side acked it: wait for the last ack on both sides.
  await until(() => n11.w.rt.exchangesOf('e11', peer10.id).length === 6 && n10.w.rt.exchangesOf('e10', peer11early.id).length === 6, 'six delivered messages on both machines')
  const onSender = n11.w.rt.exchangesOf('e11', peer10.id)
  assert.deepEqual(onSender.map(item => item.role), ['request', 'reply', 'request', 'reply', 'request', 'reply'])
  assert.ok(onSender[5].text.includes('第 3 回合收到'))
  const peer11 = peerOf(n10.w.rt, 'node011执行')
  const onRecipient = n10.w.rt.exchangesOf('e10', peer11.id)
  assert.deepEqual(onRecipient.map(item => item.role), ['request', 'reply', 'request', 'reply', 'request', 'reply'])
  // The hub carried every frame: its own exchange view of the two node Bots shows the whole conversation too.
  await until(() => hub.rt.exchangesOf('joined:node011:e11', 'joined:node010:e10').length === 6, 'the hub shows all six messages')
  const onHub = hub.rt.exchangesOf('joined:node011:e11', 'joined:node010:e10')
  assert.deepEqual(onHub.map(item => item.role), ['request', 'reply', 'request', 'reply', 'request', 'reply'])
  assert.ok(onHub[5].text.includes('第 3 回合收到'))
  assert.equal(Object.keys(hub.rt.state.assignOutbox ?? {}).length, 0, 'the hub only carried frames')
})

test('R2-E2E-2 node010 offline: the request waits (away, no time limit), then goes when node010 is back', { skip }, async t => {
  const { registry, n10, n11 } = await cluster(t)
  registry.nodes.get('node010').online = false
  const out = await messageBot(n11.w.rt, 'e11', 'node010执行', '离线时发的')
  await settle()
  assert.match(String(out), /Delivered to node010执行|not connected/)
  const [pending] = n11.w.rt.assign.pending()
  assert.equal(pending.away, true, 'the hub bounced it: away')
  assert.equal(taskTexts(n10.w, 'e10').length, 0)
  registry.nodes.get('node010').online = true
  await n11.w.rt.assign.flush({ force: true })
  await until(() => taskTexts(n10.w, 'e10').some(text => text.includes('离线时发的')), 'delivered once node010 is back')
  await until(() => n11.w.rt.assign.pending().length === 0, 'acked once node010 is back')
  // A resend of the same frame (its ack lost) is acked again, never applied twice.
  const before = taskTexts(n10.w, 'e10').length
  const frame = { op: 'deliver', frameId: Object.keys(n10.w.rt.state.assignSeen)[0], from: { id: 'joined:node011:e11', name: 'node011执行', nodeId: 'node011' }, to: { id: 'joined:node010:e10', name: 'node010执行', nodeId: 'node010' }, role: 'request', exchangeId: 'dup', text: '离线时发的' }
  assert.equal(await n10.w.rt.assign.receive(frame), 'duplicate')
  assert.equal(taskTexts(n10.w, 'e10').length, before)
})

test('R2-E2E-3 node Bot → hub Bot: the hub Bot answers through the joined shadow, the reply goes home', { skip }, async t => {
  const { hub, n11 } = await cluster(t)
  const out = await messageBot(n11.w.rt, 'e11', 'Chief', '主控你好')
  assert.match(String(out), /Delivered to Chief/)
  await until(() => taskTexts(hub, 'chief').some(text => text.includes('主控你好')), 'the request reached a Chief background task')
  assert.equal(textsIn(hub, 'chief').length, 0, "nothing in Chief's own chat")
  await answer(hub.rt, 'chief', '主控你好', '收到，我是主控')
  await until(() => textsIn(n11.w, 'e11').some(text => text.includes('收到，我是主控')), 'the reply reached node011 Bot')
  assert.equal(Object.values(n11.w.rt.state.works ?? {}).filter(w => w.from === 'e11').length, 0)
})

test('R3-E2E-4 hub Bot → node Bot: over bot/assign, never written into the node Bot page on the hub', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  let mirrored = 0
  const realJoinedTurn = hub.rt.handleJoinedTurn
  hub.rt.handleJoinedTurn = (...args) => { mirrored += 1; return realJoinedTurn?.(...args) }
  const out = await messageBot(hub.rt, 'chief', 'node010执行', '主控派活：查一下磁盘')
  assert.match(String(out), /Delivered to node010执行/)
  await until(() => taskTexts(n10.w, 'e10').some(text => text.includes('主控派活')), 'the request reached a node010 background task')
  assert.equal(mirrored, 0, 'no bot/turn: nothing goes into the mirror Session as if the user had said it')
  assert.equal(textsIn(n10.w, 'e10').length, 0, "nothing in node010 Bot's own chat")
  await answer(n10.w.rt, 'e10', '主控派活', '磁盘还剩 120G')
  await until(() => textsIn(hub, 'chief').some(text => text.includes('磁盘还剩 120G')), 'the answer reached Chief')
  assert.equal(Object.values(hub.rt.state.works ?? {}).filter(w => w.from === 'chief').length, 0, 'Chief work closed')
  assert.equal(mirrored, 0)
})

// ── R4: team management from a node ─────────────────────────────────────────────────────────────
async function managedCluster(t, prefs) {
  const c = await cluster(t)
  for (const w of [c.n10.w, c.n11.w]) {
    const get = w.ctx.get.bind(w.ctx)
    w.ctx.get = name => (name === 'remote-agent:role' ? 'worker' : get(name))
  }
  // A real hub-side answer for team/act: AC's ingest + hub bot-network, back to the node over its link.
  if (prefs !== undefined) Object.assign(c.hub.rt.state.prefs ??= {}, prefs)
  return c
}
const tool = (w, name, args, as) => w.rt.teamTools.find(def => def.name === name).execute(args, { agent: { id: w.rt.chatOf(as) }, callId: 'c', signal: new AbortController().signal })

test('R4-E2E-1 a node Bot creates and deletes a hub group chat through the hub, as itself', { skip }, async t => {
  const { hub, n11 } = await managedCluster(t)
  const made = await tool(n11.w, 'create_group', { name: '节点协作组', members: ['node010执行'] }, 'e11')
  assert.match(String(made), /节点协作组/)
  const room = Object.values(hub.rt.state.rooms).find(r => r.name === '节点协作组')
  assert.ok(room, 'the group exists on the hub')
  assert.deepEqual(room.members.sort(), ['joined:node010:e10', 'joined:node011:e11'].sort(), 'the node Bot that asked is in it')
  const gone = await tool(n11.w, 'delete_group', { group: '节点协作组' }, 'e11')
  assert.doesNotMatch(String(gone), /Only a Main Bot|Not done/)
  assert.equal(Object.values(hub.rt.state.rooms).some(r => r.name === '节点协作组'), false)
})

test('R4-E2E-2 the hub decides: nodeManagers "none" refuses, and a node manager cannot change a Main Bot', { skip }, async t => {
  const none = await managedCluster(t, { nodeManagers: 'none' })
  const refused = await tool(none.n11.w, 'create_group', { name: 'X', members: ['node010执行'] }, 'e11')
  assert.match(String(refused), /^Not done on the hub: node011执行 may not manage the team/)
  assert.equal(Object.keys(none.hub.rt.state.rooms).length, 0)

  const all = await managedCluster(t)
  all.hub.rt.state.mainBotIds = ['chief']
  const main = await tool(all.n11.w, 'update_bot', { bot: 'Chief', role: '被改' }, 'e11')
  assert.match(String(main), /Chief is a Main Bot: only a Main Bot can change it/)
  assert.notEqual(all.hub.rt.botOf('chief').role, '被改')
})

test('R4-E2E-3 a node Bot still changes itself locally (no hub round trip)', { skip }, async t => {
  const { hub, n11 } = await managedCluster(t)
  let asked = 0
  const net = n11.w.ctx.get('remote-agent:bot-network')
  const real = net.teamAct
  net.teamAct = (...a) => { asked += 1; return real(...a) }
  await tool(n11.w, 'update_bot', { role: '执行官' }, 'e11')
  assert.equal(asked, 0)
  assert.equal(n11.w.rt.botOf('e11').role, '执行官')
  void hub
})

test('R4-E2E-4 a node Bot answer reaches a hub Bot that is still in its turn at its next step, not its queue', { skip }, async t => {
  const { hub, n10 } = await cluster(t)
  await messageBot(hub.rt, 'chief', 'node010执行', '跑一下验收 A1')
  await until(() => taskTexts(n10.w, 'e10').some(text => text.includes('跑一下验收 A1')), 'the request reached node010')
  hub.rt.liveOf(hub.rt.chatOf('chief')).turn = 9  // Chief is still working on the acceptance run
  await answer(n10.w.rt, 'e10', '跑一下验收 A1', 'A1 PASS')
  await until(() => hub.steers.some(item => item.sessionId === hub.rt.chatOf('chief') && JSON.stringify(item.message).includes('A1 PASS')), 'steered into Chief running turn')
  assert.equal(hub.followups.some(item => JSON.stringify(item.message).includes('A1 PASS')), false, "not in Chief's queue")
})

// The answer must come back by itself when the recipient's background task ends its turn (turns.js), not
// only when a test closes the work by hand: node ↔ node replies were seen to go one way only on the cluster.
async function runTask(w, botId, needle, answerText) {
  await until(() => (w.rt.botOf(botId)?.tasks ?? []).some(task => task.status === 'running'), 'a background task is running')
  const task = w.rt.botOf(botId).tasks.find(item => item.status === 'running')
  const sid = task.sessionId
  const find = () => [...w.followups, ...w.steers].find(item => item.sessionId === sid && JSON.stringify(item.message).includes(needle))
  await until(() => find() !== undefined, 'the request is in the task session')
  const delivered = find()
  const agent = w.agentOf(sid)
  agent.session.seq = (agent.session.seq ?? 0)
  const emit = async (type, data) => {
    const event = { type, seq: ++agent.session.seq, data }
    agent.session.log.push(event)
    for (const listener of w.ctx.listeners.get('session/event') ?? []) await listener(agent.session, event)
  }
  await emit('turn/start', { turn: 1 })
  await emit('user/message', delivered.message)
  await emit('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: answerText }] } })
  await emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return task
}

test('R4-E2E-5 node011 → node010: node010 background task ends its turn, the answer comes back to node011 by itself', { skip }, async t => {
  const { n10, n11 } = await cluster(t)
  await messageBot(n11.w.rt, 'e11', 'node010执行', '回包测试：请回 OK')
  const task = await runTask(n10.w, 'e10', '回包测试', '回包 OK')
  await until(() => task.status === 'completed', 'the task completed')
  await until(() => textsIn(n11.w, 'e11').some(text => text.includes('回包 OK')), 'the answer reached node011 Bot')
  assert.equal(Object.values(n11.w.rt.state.works ?? {}).filter(w => w.from === 'e11').length, 0, 'node011 work closed')
})

// The cluster run: the hub's Chief asks node011执行 to talk to node010执行. node011's background task forwards
// the question and ends its turn ("round 1 sent"). The answer from node010 must bring node011 back to that
// work, and Chief must not take "round 1 sent" as the final answer.
function taskEmitter(w, sid) {
  const agent = w.agentOf(sid)
  agent.session.seq = agent.session.seq ?? 0
  return async (type, data) => {
    const event = { type, seq: ++agent.session.seq, data }
    agent.session.log.push(event)
    for (const listener of w.ctx.listeners.get('session/event') ?? []) await listener(agent.session, event)
  }
}
const requestIn = (w, sid, needle) => [...w.followups, ...w.steers].find(item => item.sessionId === sid && JSON.stringify(item.message).includes(needle))

test('R4-E2E-6 Chief → node011 task → node010 and back: node011 resumes on the answer, Chief gets no premature reply', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  await messageBot(hub.rt, 'chief', 'node011执行', '和 node010执行 沟通一次')
  await until(() => (n11.w.rt.botOf('e11').tasks ?? []).some(task => task.status === 'running'), 'node011 opened a task')
  const task11 = n11.w.rt.botOf('e11').tasks.find(task => task.status === 'running')
  const emit11 = taskEmitter(n11.w, task11.sessionId)
  await emit11('turn/start', { turn: 1 })
  await until(() => requestIn(n11.w, task11.sessionId, '和 node010执行 沟通一次') !== undefined, 'the request is in node011 task')
  await emit11('user/message', requestIn(n11.w, task11.sessionId, '和 node010执行 沟通一次').message)
  const sent = await n11.w.rt.teamTools.find(def => def.name === 'message_bot')
    .execute({ to: 'node010执行', message: '第 1 回合：你好' }, { agent: { id: task11.sessionId }, callId: 'c1', signal: new AbortController().signal })
  assert.match(String(sent), /Delivered to node010执行/)
  await emit11('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第 1 回合已发给 node010执行，等它回复' }] } })
  await emit11('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(textsIn(hub, 'chief').some(text => text.includes('第 1 回合已发给')), false, 'Chief must not get "round 1 sent" as the answer while node011 still waits for node010')

  // node010 answers in its own task.
  await until(() => (n10.w.rt.botOf('e10').tasks ?? []).some(task => task.status === 'running'), 'node010 opened a task')
  const task10 = n10.w.rt.botOf('e10').tasks.find(task => task.status === 'running')
  const emit10 = taskEmitter(n10.w, task10.sessionId)
  await emit10('turn/start', { turn: 1 })
  await until(() => requestIn(n10.w, task10.sessionId, '第 1 回合') !== undefined, 'the request is in node010 task')
  await emit10('user/message', requestIn(n10.w, task10.sessionId, '第 1 回合').message)
  await emit10('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第 1 回合收到' }] } })
  await emit10('turn/end', { turn: 1, reason: { kind: 'completed' } })

  // The answer goes back to node011's task part, not into node011's own chat (the user's window).
  await until(() => [...n11.w.followups, ...n11.w.steers].some(item => item.sessionId !== n11.w.rt.chatOf('e11') && JSON.stringify(item.message).includes('第 1 回合收到')), 'the answer reached node011 task, not its Main chat')
  assert.equal(textsIn(n11.w, 'e11').some(text => text.includes('第 1 回合收到')), false, "not in node011's own chat")

  // node011's task takes the answer up and finishes the work Chief gave it: Chief gets that final answer.
  const back = [...n11.w.followups, ...n11.w.steers].find(item => item.sessionId === task11.sessionId && JSON.stringify(item.message).includes('第 1 回合收到'))
  assert.ok(back, 'the answer went to the very task that asked')
  await emit11('turn/start', { turn: 2 })
  await emit11('user/message', back.message)
  await emit11('assistant/message', { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'node010 已回复：第 1 回合收到。沟通完成。' }] } })
  await emit11('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await until(() => [...hub.followups, ...hub.steers].some(item => JSON.stringify(item.message).includes('沟通完成')), 'Chief got the final answer from node011')
  assert.equal(Object.values(hub.rt.state.works ?? {}).filter(w => w.from === 'chief').length, 0, 'Chief work closed')
})


// What the hub page of each node Bot shows: one "Message from" line per message it got, one "Reply from" line per
// answer it got, and what it did on each answer — as many as there are (the user watches from the hub).
const relayLines = (w, botId) => {
  const sid = w.rt.chatOf(botId)
  const session = w.agentOf(sid).session
  return (session.log ?? []).filter(e => e.type === 'user/message' && e.data?.source?.kind === 'bot').map(e => `${e.data.source.role}:${e.data.source.senderName}`)
}
const mirrorLog = (w, botId) => w.agentOf(w.rt.chatOf(botId)).session.log ?? []

test('R4-E2E-7 hub pages: node010 shows every "Message from node011", node011 every "Reply from node010" and what it did next', { skip }, async t => {
  const { hub, n10, n11 } = await cluster(t)
  n11.w.rt.state.bots.e11.hubAskedAt = Date.now()   // node011's Bot works for the hub's page
  for (let round = 1; round <= 2; round += 1) {
    await messageBot(n11.w.rt, 'e11', 'node010执行', `第 ${round} 回合：你好`)
    await until(() => taskTexts(n10.w, 'e10').some(text => text.includes(`第 ${round} 回合：`)), `round ${round} reached node010`)
    await answer(n10.w.rt, 'e10', `第 ${round} 回合`, `第 ${round} 回合收到`)
    await until(() => textsIn(n11.w, 'e11').some(text => text.includes(`第 ${round} 回合收到`)), `round ${round} reply reached node011`)
  }
  await until(() => relayLines(hub, 'joined:node010:e10').length === 2 && relayLines(hub, 'joined:node011:e11').length === 2, 'two lines on each hub page')
  assert.deepEqual(relayLines(hub, 'joined:node010:e10'), ['request:node011执行', 'request:node011执行'])
  assert.deepEqual(relayLines(hub, 'joined:node011:e11'), ['reply:node010执行', 'reply:node010执行'])

  // node011 goes on in its own chat with the answer: that turn reaches its hub page, as a plain answer.
  const chat = n11.w.rt.chatOf('e11')
  const agent = n11.w.agentOf(chat)
  agent.session.seq = agent.session.seq ?? 0
  const emit = async (type, data) => { const event = { type, seq: ++agent.session.seq, data }; agent.session.log.push(event); for (const l of n11.w.ctx.listeners.get('session/event') ?? []) await l(agent.session, event) }
  const got = [...n11.w.followups, ...n11.w.steers].find(item => item.sessionId === chat && JSON.stringify(item.message).includes('第 2 回合收到'))
  await emit('turn/start', { turn: 1 })
  await emit('user/message', got.message)
  await emit('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '两轮都收到了，继续第 3 回合' }] } })
  await emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const shown = () => mirrorLog(hub, 'joined:node011:e11').filter(e => e.type === 'assistant/message').map(e => e.data.message.content.map(b => b.text).join(''))
  await until(() => shown().some(text => text === '两轮都收到了，继续第 3 回合'), "node011's next step shows on its hub page, without a task-result mark")
})


// Found on the cluster (task-board/evidence/T-20261124-node-no-reply-forensics): round 1 answered, round 2/3 were
// answered on the node but the answer never left — "reply delivery failed: Unknown Bot peer:hub:node010:…". A
// peer/roster frame with federation off cleared every peer row, the team directory's too, and the answer had no
// stand-in to go to until the next directory.
test('R4-E2E-8 a peer/roster frame (federation off) between rounds keeps the directory rows: round 2 is answered', { skip }, async t => {
  const { n10, n11 } = await cluster(t)
  await messageBot(n11.w.rt, 'e11', 'node010执行', '第 1 回合：你好')
  await until(() => taskTexts(n10.w, 'e10').some(text => text.includes('第 1 回合：')), 'round 1 reached node010')
  await answer(n10.w.rt, 'e10', '第 1 回合', '第 1 回合收到')
  await until(() => textsIn(n11.w, 'e11').some(text => text.includes('第 1 回合收到')), 'round 1 reply reached node011')
  await messageBot(n11.w.rt, 'e11', 'node010执行', '第 2 回合：你好')
  await until(() => taskTexts(n10.w, 'e10').some(text => text.includes('第 2 回合：')), 'round 2 reached node010')
  // The hub's roster push lands on node010 now, before it answers.
  assert.equal(await handlePeerRoster(n10.w.rt, { hubId: 'hub-1', level: 'off', bots: [] }), true)
  assert.ok(peerOf(n10.w.rt, 'node011执行'), "the directory's row for node011 is still there")
  await answer(n10.w.rt, 'e10', '第 2 回合', '第 2 回合收到')
  await until(() => textsIn(n11.w, 'e11').some(text => text.includes('第 2 回合收到')), 'round 2 reply reached node011')
})

test('R4-E2E-9 the asker stand-in is gone when the answer is ready: it still goes home to the address the request came from', { skip }, async t => {
  const { n10, n11 } = await cluster(t)
  await messageBot(n11.w.rt, 'e11', 'node010执行', '第 1 回合：你好')
  await until(() => taskTexts(n10.w, 'e10').some(text => text.includes('第 1 回合：')), 'round 1 reached node010')
  delete n10.w.rt.state.bots[peerOf(n10.w.rt, 'node011执行').id]
  await answer(n10.w.rt, 'e10', '第 1 回合', '第 1 回合收到')
  await until(() => textsIn(n11.w, 'e11').some(text => text.includes('第 1 回合收到')), 'the answer reached node011 anyway')
  assert.equal(Object.values(n11.w.rt.state.works ?? {}).filter(w => w.from === 'e11').length, 0, 'node011 work closed')
})
