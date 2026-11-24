// R1（重写 2026-11-24）：节点上的 Bot 看得到全队与所有机器，发出的消息能对上 hub 上的发送方。
// 这里串起两边的真实代码：hub 的 ds-bot 生成目录 → AC 的 bot/directory 校验 → AC 节点 bot-network →
// 节点 ds-bot 生成行 → list_bots / list_machines；以及节点 ds-bot sendToPeer → AC 节点 send（盖 identityId）
// → hub 的 ds-bot handleNodeMessage 找到发送方的影子。需要 AC 仓库（REMOTE_AGENT_REPO 或同级 dsh-ai-cluster）。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { directoryOf, handleNodeMessage, machinesOf, sendToPeer, senderShadowOf } from '../src/host/bot-network.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = [process.env.REMOTE_AGENT_REPO, resolve(PLUGIN, '../../dsh-ai-cluster'), resolve(PLUGIN, '../../../Projects/dsh-ai-cluster')]
  .filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
  .find(dir => existsSync(join(dir, 'lib/protocol.js')))
const skip = repo === undefined ? 'AC repo not found (set REMOTE_AGENT_REPO)' : false
const load = file => import(pathToFileURL(join(repo, 'lib', file)).href)

const ID10 = 'aaaaaaaaaaaaaaaa'
const ID11 = 'bbbbbbbbbbbbbbbb'
const joined = (id, name, worker) => ({ id, sessionId: id, name, role: 'Exec', instructions: '', createdAt: 2, type: 'remote-worker', origin: 'joined', worker: { home: 'remote', online: true, ...worker } })
const HUB_TEAM = {
  version: 1, mainBotIds: ['chief'], revision: 1, whaleStored: true,
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    'joined:node010:e10': joined('joined:node010:e10', 'node010执行', { nodeId: 'node010', remoteBotId: 'e10', identityId: ID10, hostname: 'box-10' }),
    'joined:node011:e11': joined('joined:node011:e11', 'node011执行', { nodeId: 'node011', remoteBotId: 'e11', identityId: ID11, hostname: 'box-11' }),
  },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}
const NODE_TEAM = {
  version: 1, mainBotIds: [], revision: 1, whaleStored: true,
  bots: { e11: { id: 'e11', sessionId: 'e11', name: 'node011执行', role: 'Exec', instructions: '', createdAt: 1 } },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}

async function runtime(t, team, services) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-r1-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = (name, args = {}, as) => rt.teamTools.find(def => def.name === name).execute(args, { agent: { id: as }, callId: 'c', signal: new AbortController().signal })
  return { rt, call }
}

async function hubWorld(t) {
  const { createBotIdentityBook } = await load('node/bot-identities.js')
  const botsDir = mkdtempSync(join(tmpdir(), 'ds-bot-r1-ids-'))
  t.after(() => rmSync(botsDir, { recursive: true, force: true }))
  const book = createBotIdentityBook({ homeNodeId: 'hub', botsDir })
  const frames = []
  const nodes = [
    { nodeId: 'node010', hostname: 'box-10', os: 'linux', online: true, acVersion: '0.4.34', lastSeen: 10 },
    { nodeId: 'node011', hostname: 'box-11', os: 'linux', online: true, acVersion: '0.4.34', lastSeen: 11 },
    { nodeId: 'node012', hostname: 'box-12', os: 'win32', online: false, lastSeen: 12 },
  ]
  const registry = {
    on() {}, off() {}, list: () => nodes, onlineNodes: () => nodes.filter(node => node.online),
    getNode: () => undefined, send: (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true },
  }
  const identity = { identityOf: (id, meta) => book.identityOf(id) ?? book.decorate([{ id, ...meta }])[0]?.identityId }
  const hub = await runtime(t, HUB_TEAM, { 'remote-agent:registry': registry, 'remote-agent:bot-identity': identity })
  return { ...hub, frames }
}

test('R1-E2E-1 hub directory → AC → node: every Bot with identityId, machine and state; every machine listed', { skip }, async t => {
  const { createBotNetwork } = await load('node/bot-network.js')
  const { validateBotDirectory } = await load('protocol.js')
  const hub = await hubWorld(t)
  const payload = { bots: directoryOf(hub.rt), machines: machinesOf(hub.rt), rooms: [], at: Date.now() }
  // The hub Bot got a portable id from AC's identity book; node Bots carry their reported ones.
  const byName = Object.fromEntries(payload.bots.map(bot => [bot.name, bot]))
  assert.match(byName.Chief.identityId, /^[0-9a-f]{16}$/)
  assert.equal(byName['node010执行'].identityId, ID10)
  assert.equal(byName['node010执行'].hostname, 'box-10')
  assert.deepEqual(payload.machines.map(machine => machine.nodeId), ['hub', 'node010', 'node011', 'node012'])
  // Nothing ds-bot sends is dropped by AC's validator.
  const checked = validateBotDirectory(payload)
  assert.deepEqual(checked.bots, payload.bots)
  assert.equal(checked.machines.length, 4)

  const network = createBotNetwork({ nodeId: 'node011', send: () => true })
  t.after(() => network.dispose())
  const node = await runtime(t, NODE_TEAM, { 'remote-agent:bot-network': network })
  network.receiveDirectory(payload)

  const rows = Object.values(node.rt.state.bots).filter(bot => bot.origin === 'peer')
  assert.deepEqual(rows.map(row => row.name).sort(), ['Chief', 'node010执行'], 'its own Bot is not listed twice')
  const exec10 = rows.find(row => row.name === 'node010执行')
  assert.equal(exec10.identityId, ID10)
  assert.equal(exec10.worker.hostname, 'box-10')
  assert.equal(exec10.worker.state, 'available')

  const bots = await node.call('list_bots', {}, 'e11')
  const botsText = typeof bots === 'string' ? bots : JSON.stringify(bots)
  assert.match(botsText, /node010执行 \(Exec, on box-10\)/)
  assert.doesNotMatch(botsText, /read-only/)

  const machines = await node.call('list_machines', {}, 'e11')
  const text = typeof machines === 'string' ? machines : JSON.stringify(machines)
  assert.doesNotMatch(text, /No nodes connected/)
  assert.match(text, /🟢 box-10 \(node010\)/)
  assert.match(text, /🟢 box-11 \(node011\).*this machine/)
  assert.match(text, /🔴 box-12 \(node012\)/)
  assert.match(text, /Bots: node011执行/, 'its own Bot is on its own machine')
  assert.match(text, /Bots: node010执行/)
})

test('R1-E2E-2 node message → AC stamps identityId → hub finds the sender shadow, not the node-local id', { skip }, async t => {
  const { createBotNetwork } = await load('node/bot-network.js')
  const sent = []
  const network = createBotNetwork({ nodeId: 'node011', send: (type, data) => { sent.push({ type, data }); return true }, identityOf: id => (id === 'e11' ? ID11 : undefined) })
  t.after(() => network.dispose())
  const node = await runtime(t, NODE_TEAM, { 'remote-agent:bot-network': network })
  const hub = await hubWorld(t)
  network.receiveDirectory({ bots: directoryOf(hub.rt), machines: machinesOf(hub.rt), rooms: [] })
  const target = Object.values(node.rt.state.bots).find(bot => bot.origin === 'peer' && bot.name === 'node010执行')
  const result = sendToPeer(node.rt, { fromId: 'e11', toId: target.id, text: '第 1 回合', exchangeId: 'x-1' })
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  const frame = sent[0].data
  assert.equal(frame.from.id, 'e11', 'the node names its Bot by its own id')
  assert.equal(frame.from.identityId, ID11, 'AC stamped the portable id from the node identity book')

  assert.equal(senderShadowOf(hub.rt, frame.from)?.id, 'joined:node011:e11')
  // Without the identityId the hub still finds it by node + node-local id.
  assert.equal(senderShadowOf(hub.rt, { ...frame.from, identityId: undefined })?.id, 'joined:node011:e11')

  const turns = []
  hub.rt.handleJoinedTurn = args => { turns.push(args); return args.exchangeId }
  await handleNodeMessage(hub.rt, frame)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].fromId, 'joined:node011:e11', 'the reply can be addressed to a Bot the hub knows')
  assert.equal(turns[0].toId, 'joined:node010:e10')
})
