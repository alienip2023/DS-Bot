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
      else if (type === 'bot/directory') network.receiveDirectory(structuredClone(data))
      return true
    }
    list() { return [...this.nodes.values()].map(n => ({ nodeId: n.nodeId, hostname: `box-${n.nodeId}`, os: 'linux', online: n.online })) }
    onlineNodes() { return this.list().filter(n => n.online) }
    getNode(nodeId) { return this.nodes.get(nodeId) }
  }
  const registry = new (withIngest(Core))()
  const hubNetwork = createHubBotNetwork({ registry, ctx: { get: () => undefined } })
  const world = (home, state, services) => {
    writeFileSync(join(home, 'state.json'), JSON.stringify(state))
    return threadWorld({ home, services })
  }
  const hub = world(mkdtempSync(join(tmpdir(), 'r2-hub-')), team([bot('chief', 'Chief', {}), joined('node010', 'e10', 'node010执行'), joined('node011', 'e11', 'node011执行')]),
    { 'remote-agent:registry': registry, 'remote-agent:bot-network': hubNetwork })
  const node = (nodeId, local) => {
    const network = createBotNetwork({ nodeId, sendHub: (type, data) => { if (!registry.nodes.get(nodeId)?.online) return false; registry.handleFrameFor(nodeId, { t: type, d: structuredClone(data) }); return true } })
    nodes.set(nodeId, network)
    return { network, w: world(mkdtempSync(join(tmpdir(), `r2-${nodeId}-`)), team([local]), { 'remote-agent:bot-network': network }) }
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
  const onSender = n11.w.rt.exchangesOf('e11', peer10.id)
  assert.deepEqual(onSender.map(item => item.role), ['request', 'reply', 'request', 'reply', 'request', 'reply'])
  assert.ok(onSender[5].text.includes('第 3 回合收到'))
  const peer11 = peerOf(n10.w.rt, 'node011执行')
  const onRecipient = n10.w.rt.exchangesOf('e10', peer11.id)
  assert.deepEqual(onRecipient.map(item => item.role), ['request', 'reply', 'request', 'reply', 'request', 'reply'])
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
