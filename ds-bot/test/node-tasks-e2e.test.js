// Both plugins together: a node's running background tasks go through the REAL AC roster path
// (bindRosterReport → hub registry ingest, with its field whitelist) and land on the hub's shadow
// row through the REAL ds-bot applyRosterReport. Needs the AC repo: REMOTE_AGENT_REPO, or a
// sibling `dsh-ai-cluster`; skipped (with a message) when it is not there.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { applyRosterReport, reportableBots } from '../src/host/roster-join.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const candidates = [process.env.REMOTE_AGENT_REPO, resolve(PLUGIN, '../../dsh-ai-cluster'), resolve(PLUGIN, '../../../Projects/dsh-ai-cluster')]
  .filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
const repo = candidates.find(dir => existsSync(join(dir, 'lib/roster-report.js')))
const skip = repo === undefined ? 'AC repo not found (set REMOTE_AGENT_REPO)' : false

const load = async (file) => import(pathToFileURL(join(repo, 'lib', file)).href)

function hubRegistry(withIngest, nodeId) {
  const listeners = {}
  class Core {
    constructor() { this.nodes = new Map([[nodeId, { nodeId, lastSeen: 0, online: true }]]); this.tasks = new Map() }
    log() {}
    send() {}
    on(name, fn) { (listeners[name] ??= []).push(fn); return () => {} }
    emit(name, payload) { for (const fn of listeners[name] ?? []) fn(payload) }
  }
  return new (withIngest(Core))()
}

test('running tasks of a node Bot reach the hub row through the real AC roster path', { skip }, async () => {
  const { bindRosterReport } = await load('roster-report.js')
  const { withIngest } = await load('hub/registry-ingest.js')
  const registry = hubRegistry(withIngest, 'n1')
  const hubState = { bots: {}, mainBotIds: [] }
  registry.on('roster', report => applyRosterReport(hubState, report))

  // the node side: ds-bot reports its Bots with their task view, AC frames and sends it
  const nodeBots = { k1: { id: 'k1', name: 'Worker', role: 'dev' }, k2: { id: 'k2', name: 'Idle', role: '' } }
  const views = {
    k1: [
      { id: 'task-1', title: 'Build the site', status: 'running', startedAt: 111, sessionId: 'session-secret' },
      { id: 'task-2', title: 'Old', status: 'completed', startedAt: 1, endedAt: 2 },
    ],
    k2: [],
  }
  const sent = []
  const report = bindRosterReport({ set() {} }, { send: (type, data) => { sent.push({ type, data }); return true }, nodeId: 'n1', hostname: 'h' })
  assert.equal(report({ bots: reportableBots(nodeBots, bot => views[bot.id]) }), true)
  assert.equal(JSON.stringify(sent[0].data).includes('session-secret'), false, 'no session id leaves the node')
  registry.handleFrameFor('n1', { t: sent[0].type, d: sent[0].data })

  const rows = Object.values(hubState.bots)
  const busy = rows.find(row => row.worker.remoteBotId === 'k1')
  const idle = rows.find(row => row.worker.remoteBotId === 'k2')
  assert.deepEqual(busy.nodeTasks, [{ id: 'task-1', title: 'Build the site', status: 'running', startedAt: 111 }])
  assert.deepEqual(idle.nodeTasks ?? [], [])

  // the task ends: the next report clears it
  views.k1 = []
  assert.equal(report({ bots: reportableBots(nodeBots, bot => views[bot.id]) }), true)
  registry.handleFrameFor('n1', { t: sent.at(-1).type, d: sent.at(-1).data })
  assert.deepEqual(Object.values(hubState.bots).find(row => row.worker.remoteBotId === 'k1').nodeTasks, [])
})

test('a node Bot\'s task report crosses the real AC bot/message path and is written on the hub page', { skip }, async () => {
  const { createBotNetwork } = await load('node/bot-network.js')
  const { withIngest } = await load('hub/registry-ingest.js')
  const { NODE_TO_HUB } = await load('protocol.js')
  const { handleNodeMessage } = await import('../src/host/bot-network.js')
  const { reportTaskToHub } = await import('../src/host/joined-turn.js')
  const { TASK_RESULT_MARK } = await import('../src/host/mirror.js')
  const { makeWorld } = await import('./joined-world.js')

  const w = makeWorld({ tracker: true })
  const registry = hubRegistry(withIngest, 'n1')
  registry.on('botMessage', message => { void handleNodeMessage(w.rt, message) })

  // the node: the real transport, its frames go to the hub's real ingest
  const frames = []
  const network = createBotNetwork({ nodeId: 'n1', send: (type, data) => { frames.push({ type, data }); registry.handleFrameFor('n1', { t: type, d: data }); return true } })
  const nodeRt = { hubAskedBots: new Set(['rb1']), botNetwork: network }
  assert.equal(reportTaskToHub(nodeRt, { id: 'rb1', name: 'Joined' }, 'the build is done'), true)
  assert.equal(frames[0].type, NODE_TO_HUB.BOT_MESSAGE)
  for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve))

  const texts = w.sessionOf('mirror-1').log.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text)
  assert.deepEqual(texts, [`${TASK_RESULT_MARK}\n\nthe build is done`])
  assert.equal(w.frames.length, 0, 'nothing is sent back to the node')
})
