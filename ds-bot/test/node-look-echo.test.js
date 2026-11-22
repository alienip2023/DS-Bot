// A node Bot's colour, avatar shape and reasoning effort reach the hub row through the REAL AC roster path.
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

test('colour, avatar shape and effort cross AC; a bad value is dropped, not the Bot; an old report keeps what the row has', { skip }, async () => {
  const { bindRosterReport } = await load('roster-report.js')
  const { withIngest } = await load('hub/registry-ingest.js')
  const listeners = {}
  class Core {
    constructor() { this.nodes = new Map([['n1', { nodeId: 'n1', lastSeen: 0, online: true }]]); this.tasks = new Map() }
    log() {} send() { return true }
    on(name, fn) { (listeners[name] ??= []).push(fn); return () => {} }
    emit(name, payload) { for (const fn of listeners[name] ?? []) fn(payload) }
  }
  const registry = new (withIngest(Core))()
  const hub = { bots: {}, mainBotIds: [] }
  registry.on('roster', report => applyRosterReport(hub, report))
  const sent = []
  const report = bindRosterReport({ set() {} }, { send: (type, data) => { sent.push({ type, data }); return true }, nodeId: 'n1', hostname: 'h' })
  const flow = (bots) => { sent.length = 0; report({ bots: reportableBots(bots) }); registry.handleFrameFor('n1', { t: sent[0].type, d: sent[0].data }) }

  flow({ a: { id: 'a', name: 'A', color: 'violet', avatar: { shape: 'cat', image: 'data:image/png;base64,AAAA' }, effort: 'high' } })
  let row = Object.values(hub.bots)[0]
  assert.equal(row.color, 'violet')
  assert.deepEqual(row.avatar, { shape: 'cat' }, 'the photo stays on the node')
  assert.equal(row.effort, 'high')

  flow({ a: { id: 'a', name: 'A', color: 'not a colour!', effort: 'x'.repeat(40) } })
  row = Object.values(hub.bots)[0]
  assert.equal(row.name, 'A', 'the Bot survives a bad value')
  assert.equal(row.color, 'violet', 'a bad value leaves the old one')
  assert.equal(row.effort, 'high')
})
