// A form (show_view) a node Bot waits on is drawn on the hub, answered there, and the answer is applied on
// the node. Both plugins together: the card goes through the REAL AC roster path (field whitelist and
// size cap) and the answer through the REAL AC bot/action validator.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createBotActionReceiver, installHub, nodeCardsOf } from '../src/host/node-cards.js'
import { applyRosterReport, reportableBots } from '../src/host/roster-join.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const candidates = [process.env.REMOTE_AGENT_REPO, resolve(PLUGIN, '../../dsh-ai-cluster'), resolve(PLUGIN, '../../../Projects/dsh-ai-cluster')]
  .filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
const repo = candidates.find(dir => existsSync(join(dir, 'lib/roster-report.js')))
const skip = repo === undefined ? 'AC repo not found (set REMOTE_AGENT_REPO)' : false
const load = async (file) => import(pathToFileURL(join(repo, 'lib', file)).href)

const VIEW = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }

function nodeRt(answers) {
  const rt = {
    state: { bots: { k1: { id: 'k1', name: 'Worker' } }, views: { 'chat-k1': { id: 'v1', title: 'Pick one', view: VIEW, askedAt: Date.now() - 5000 } }, secretRequests: {
      k1: [{ id: 's1', name: 'GITHUB_TOKEN', purpose: 'push the branch', kind: 'fill', status: 'pending', askedAt: Date.now() - 4000 }, { id: 's0', name: 'old', status: 'canceled' }],
    } },
    botOf: id => rt.state.bots[id], chatOf: id => `chat-${id}`,
    approvalsView: () => [], learningView: () => ({}),
    answerView: async (...args) => { answers.push(args); delete rt.state.views['chat-k1'] },
  }
  return rt
}

test('the node reports its form and a waiting secret request as cards', () => {
  const rt = nodeRt([])
  const cards = nodeCardsOf(rt, rt.state.bots.k1)
  assert.deepEqual(cards.map(card => [card.id, card.kind]), [['view:v1', 'view'], ['secret:s1', 'secret']])
  assert.deepEqual(JSON.parse(cards[0].data), { title: 'Pick one', view: VIEW })
  assert.match(cards[1].body, /不会经过主控/)
  assert.equal(cards[1].body.includes('GITHUB_TOKEN'), false, 'the secret name is in the title, never a value')
})

test('a form travels through AC, is drawn on the hub, answered there and applied on the node', { skip }, async () => {
  const { bindRosterReport } = await load('roster-report.js')
  const { withIngest } = await load('hub/registry-ingest.js')
  const { validateBotAction } = await load('protocol.js')

  const answers = []
  const node = nodeRt(answers)
  const nodeBot = node.state.bots.k1

  // node → AC frame → AC hub ingest → ds-bot hub row
  const listeners = {}
  class Core {
    constructor() { this.nodes = new Map([['n1', { nodeId: 'n1', lastSeen: 0, online: true }]]); this.tasks = new Map() }
    log() {} send() { return true }
    on(name, fn) { (listeners[name] ??= []).push(fn); return () => {} }
    emit(name, payload) { for (const fn of listeners[name] ?? []) fn(payload) }
  }
  const registry = new (withIngest(Core))()
  const hubState = { bots: {}, mainBotIds: [] }
  registry.on('roster', report => applyRosterReport(hubState, report))
  const sent = []
  const report = bindRosterReport({ set() {} }, { send: (type, data) => { sent.push({ type, data }); return true }, nodeId: 'n1', hostname: 'h' })
  assert.equal(report({ bots: reportableBots(node.state.bots, null, bot => nodeCardsOf(node, bot)) }), true)
  registry.handleFrameFor('n1', { t: sent[0].type, d: sent[0].data })

  const shadow = Object.values(hubState.bots)[0]
  const card = shadow.nodeCards.find(item => item.kind === 'view')
  assert.ok(card?.data, 'the form definition crossed AC')

  // the hub: the page's view list and its answer path
  const frames = []
  const hub = {
    state: hubState, ctx: { get: () => ({ send: (nodeId, type, data) => { frames.push({ nodeId, type, data }); queueMicrotask(() => hubListeners.botActionResult?.({ nodeId, requestId: data.requestId, ok: true })); return true }, on: (name, fn) => { hubListeners[name] = fn }, off() {} }) },
    botOf: id => hubState.bots[id], chatOf: () => 'mirror-1', save: async () => {},
    approvalsView: () => [], learningView: () => ({}), answerQuestion: async () => {}, answerApproval: async () => {}, learningEndpoint: async () => {}, stopTask: async () => {}, deliverToTask: async () => {},
    answerView: async () => { throw new Error('the hub must not answer a node form locally') },
  }
  const hubListeners = {}
  shadow.worker.online = true
  hub.nodeCaps = undefined
  installHub(hub)
  const shown = hub.nodeViewsView()
  assert.deepEqual(Object.keys(shown), ['mirror-1'])
  assert.deepEqual(shown['mirror-1'].view, VIEW)
  assert.equal(shown['mirror-1'].id, 'v1')

  // an invalid answer is refused on the hub, nothing goes to the node
  await assert.rejects(hub.answerView('mirror-1', 'v1', 'nope', {}), error => error.code === 'bot/invalid')
  assert.equal(frames.length, 0)

  // a valid one is sent to the node as a card-answer whose text is the answer, and the card leaves the page
  assert.equal(await hub.answerView('mirror-1', 'v1', 'pick', { selected: ['B'] }), true)
  assert.equal(frames.length, 1)
  const wire = validateBotAction({ nodeId: 'n1', ...frames[0].data })
  assert.equal(wire.ok, true, 'AC accepts the frame')
  assert.deepEqual(JSON.parse(wire.action.params.text), { action: 'pick', values: { selected: ['B'] } })
  assert.deepEqual(hub.nodeViewsView(), {})
})

test('the node applies the hub\'s form answer; a stale or malformed one is refused', async () => {
  const answers = []
  const node = nodeRt(answers)
  const receive = createBotActionReceiver(node)
  const bad = await receive({ remoteBotId: 'k1', action: 'card-answer', params: { cardId: 'view:v1', text: 'not json' } })
  assert.deepEqual(bad, { ok: false, error: 'view-answer-invalid' })
  const ok = await receive({ remoteBotId: 'k1', action: 'card-answer', params: { cardId: 'view:v1', text: JSON.stringify({ action: 'pick', values: { selected: ['A'] } }) } })
  assert.equal(ok.ok, true)
  assert.deepEqual(answers[0], ['chat-k1', 'v1', 'pick', { selected: ['A'] }])
  const stale = await receive({ remoteBotId: 'k1', action: 'card-answer', params: { cardId: 'view:v1', text: JSON.stringify({ action: 'pick', values: {} }) } })
  assert.deepEqual(stale, { ok: false, error: 'card-stale' })
})
