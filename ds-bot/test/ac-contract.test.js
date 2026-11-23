// ds-bot fits AC completely: every frame ds-bot really sends is run through AC's real validator, and no
// field it carries may be dropped or changed on the way (the way `tasks` once was). The frames are
// captured from ds-bot's own senders, not retyped here. Needs the AC repo (REMOTE_AGENT_REPO, or a sibling
// `dsh-ai-cluster`); skipped with a message when it is not there.
//
// Not covered here, each by its own tests: peer/roster, bot/directory, mem/*, node/config, bot/stop (an
// inline send inside a tool), and the results (AC's own validators build those).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { test } from 'node:test'
import { createBotOnNode } from '../src/host/joined-create.js'
import { joinedChatPage, joinedDeleteBot, joinedUpdateBot } from '../src/host/joined-page.js'
import { reportTaskToHub } from '../src/host/joined-turn.js'
import { sendBotAction } from '../src/host/node-cards.js'
import { nodeCardsOf } from '../src/host/node-cards.js'
import { reportableBots } from '../src/host/roster-join.js'
import { sendToPeer } from '../src/host/bot-network.js'
import { makeWorld, textRequest } from './joined-world.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const candidates = [process.env.REMOTE_AGENT_REPO, resolve(PLUGIN, '../../dsh-ai-cluster'), resolve(PLUGIN, '../../../Projects/dsh-ai-cluster')]
  .filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
const repo = candidates.find(dir => existsSync(join(dir, 'lib/protocol.js')))
const skip = repo === undefined ? 'AC repo not found (set REMOTE_AGENT_REPO)' : false
const load = file => import(pathToFileURL(join(repo, 'lib', file)).href)

const present = value => value !== undefined && value !== null && value !== ''
// Every field the frame carries comes out of AC's validator with the same value (strings may be trimmed).
function survives(name, sent, kept) {
  for (const [key, value] of Object.entries(sent)) {
    if (!present(value)) continue
    assert.ok(Object.hasOwn(kept, key), `${name}: AC dropped "${key}"`)
    const same = typeof value === 'string' ? String(kept[key]).trim() === value.trim() : isDeepStrictEqual(kept[key], value)
    assert.ok(same, `${name}: AC changed "${key}": ${JSON.stringify(value)} -> ${JSON.stringify(kept[key])}`)
  }
}

// A registry that records what ds-bot sends, and a Bot living on node n1.
function recorder() {
  const frames = []
  const registry = {
    send: (nodeId, type, payload) => { frames.push({ nodeId, type, payload: structuredClone(payload) }); return true },
    on() {}, off() {},
    onlineNodes: () => [{ nodeId: 'n1', hello: { caps: ['memory-sync/1', 'bot-memory-update/1', 'bot-profile-update/1'] } }],
    nodes: new Map([['n1', { online: true }]]),
    getNode: () => ({ hello: { caps: ['bot-turn-mode/1', 'bot-action/1', 'roster-cards/1'] } }),
  }
  const bot = { id: 'joined:n1:b1', name: 'Worker', role: 'dev', origin: 'joined', type: 'remote-worker', sessionId: 'mirror-1', worker: { nodeId: 'n1', remoteBotId: 'b1', home: 'remote', online: true } }
  const rt = {
    ctx: { get: name => (name === 'remote-agent:registry' ? registry : undefined) },
    state: { bots: { [bot.id]: bot }, prefs: {} }, botOf: id => (id === bot.id ? bot : undefined),
    load: async () => {}, save: async () => {}, warn: () => {}, botCreateTimeoutMs: 10, joinedHistoryTimeoutMs: 10, joinedUpdateTimeoutMs: 10, joinedDeleteTimeoutMs: 10,
  }
  return { rt, registry, bot, frames }
}

test('bot/turn: a page turn, a steer and a queued message keep every field', { skip }, async () => {
  const { validateBotTurn } = await load('protocol.js')
  const w = makeWorld({ tracker: true })
  await w.prompt(textRequest('first', 'req-1'))
  await w.prompt({ ...textRequest('and this', 'req-2'), mode: 'steer' })
  assert.equal(w.frames.length, 2)
  for (const frame of w.frames) {
    const checked = validateBotTurn(frame.payload)
    assert.equal(checked.ok, true, checked.error)
    survives(`bot/turn(${frame.payload.mode ?? 'plain'})`, frame.payload, checked.turn)
  }
  assert.equal(w.frames[1].payload.mode, 'steer', 'the steer carries its mode across AC')
})

test('bot/action: every action keeps every field', { skip }, async () => {
  const { validateBotAction } = await load('protocol.js')
  const { rt, bot, frames } = recorder()
  const actions = [
    ['card-answer', { cardId: 'question:q1', choice: '1', text: 'in words' }],
    ['task-stop', { taskId: 't1' }],
    ['task-send', { taskId: 't1', text: 'also x' }],
    ['task-start', { text: 'do x', relation: 'independent' }],
  ]
  for (const [action, params] of actions) {
    void sendBotAction(rt, bot, action, params, { timeoutMs: 5 }).catch(() => {})
    const frame = frames.at(-1)
    assert.equal(frame.type, 'bot/action')
    const checked = validateBotAction(frame.payload)
    assert.equal(checked.ok, true, `${action}: ${checked.error}`)
    survives(`bot/action(${action})`, frame.payload, checked.action)
    survives(`bot/action(${action}).params`, frame.payload.params, checked.action.params)
  }
})

test('the roster entry: model, clusterBotId, tasks and cards all cross AC\'s whitelist', { skip }, async () => {
  const { cleanRosterBots } = await load('roster-report.js')
  const nodeRt = {
    state: { bots: { k1: { id: 'k1', name: 'Worker', role: 'dev', model: 'deepseek/flash', clusterBotId: 'cluster-1' } }, questions: { 'chat-k1': { id: 'q1', question: 'Ship it?', options: [{ label: 'yes' }], askedAt: 3 } } },
    chatOf: id => `chat-${id}`, approvalsView: () => [], learningView: () => ({}),
  }
  const tasks = [{ id: 't1', title: 'Build', status: 'running', startedAt: 5 }]
  const [entry] = reportableBots(nodeRt.state.bots, () => tasks, bot => nodeCardsOf(nodeRt, bot))
  const [kept] = cleanRosterBots([entry])
  survives('roster entry', entry, kept)
  assert.ok(kept.cards.length === 1 && kept.tasks.length === 1)
})

test('bot/message: a task report and a message to a peer keep every field', { skip }, async () => {
  const { validateBotMessage } = await load('protocol.js')
  const sent = []
  const network = { nodeId: 'n1', send: payload => { sent.push(structuredClone(payload)); return true } }
  const rt = { hubAskedBots: new Set(['b1']), botNetwork: network, state: { bots: { b1: { id: 'b1', name: 'Worker' }, 'peer:x': { id: 'peer:x', origin: 'peer', remoteBotId: 'r1', name: 'Peer', homeNodeId: 'n2', hubId: 'hub-1' } } }, botOf: id => rt.state.bots[id] }
  assert.equal(reportTaskToHub(rt, rt.state.bots.b1, 'the build is done'), true)
  assert.equal(sendToPeer(rt, { fromId: 'b1', toId: 'peer:x', text: 'hello', kind: 'ask' }).ok, true)
  assert.equal(sent.length, 2)
  for (const payload of sent) {
    const checked = (() => { try { return { ok: true, message: validateBotMessage(payload) } } catch (error) { return { ok: false, error } } })()
    assert.equal(checked.ok, true, String(checked.error?.code ?? checked.error))
    survives('bot/message', payload, checked.message)
  }
})

test('bot/create, bot/update, bot/delete, bot/history keep every field', { skip }, async () => {
  const { validateBotCreate, validateBotUpdate, validateBotDelete, validateBotHistory } = await load('protocol.js')
  const { rt, bot, frames } = recorder()
  void createBotOnNode(rt, { nodeId: 'n1', name: 'New Bot', role: 'qa', modelRef: null, effort: 'high', workDir: '/srv/work', instructions: 'Be brief.', memoryConfig: { backend: 'federation' } }).catch(() => {})
  void joinedUpdateBot(rt, bot.id, { model: 'deepseek/flash', effort: 'high', instructions: 'Be brief.', workDir: '/srv/work' }).catch(() => {})
  void joinedChatPage(rt, bot.id, null).catch(() => {})
  void joinedDeleteBot(rt, bot).catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
  const byType = Object.fromEntries(frames.map(frame => [frame.type, frame.payload]))
  assert.deepEqual(Object.keys(byType).sort(), ['bot/create', 'bot/delete', 'bot/history', 'bot/update'])
  for (const [type, validate, field] of [['bot/create', validateBotCreate, 'create'], ['bot/update', validateBotUpdate, 'update'], ['bot/delete', validateBotDelete, 'del'], ['bot/history', validateBotHistory, 'hist']]) {
    const checked = validate(byType[type])
    assert.equal(checked.ok, true, `${type}: ${checked.error}`)
    const kept = checked[field] ?? checked.delete ?? Object.values(checked).find(value => value && typeof value === 'object')
    survives(type, byType[type], kept)
  }
})

// The pairing itself: the real AC's node hello advertises every capability ds-bot reads (NODE_FEATURES), carries its
// own version, and AC_NEEDED is the version of the AC this ds-bot was tested against. A new ds-bot feature that
// waits on a capability AC does not advertise (or an AC that stops advertising one) fails here, not on a cluster.
test('the real AC advertises every capability ds-bot depends on, and AC_NEEDED is the AC it was tested with', { skip }, async () => {
  const protocol = await load('protocol.js')
  const { NODE_FEATURES, AC_NEEDED } = await import('../src/host/node-compat.js')
  const caps = protocol.nodeCaps([])
  for (const [feature, { cap }] of Object.entries(NODE_FEATURES)) assert.ok(caps.includes(cap), `AC's hello lacks ${cap} (${feature})`)
  const hello = protocol.validateHello({ nodeId: 'n1', protocol: protocol.PROTOCOL_VERSION, os: 'linux', acVersion: AC_NEEDED, caps })
  assert.equal(hello.ok, true)
  assert.equal(hello.hello.acVersion, AC_NEEDED, 'the hub keeps the version a node reports')
  const { version } = JSON.parse((await import('node:fs')).readFileSync(join(repo, 'package.json'), 'utf8'))
  assert.equal(version, AC_NEEDED, `AC_NEEDED (${AC_NEEDED}) must be the AC this ds-bot pairs with (the AC repo is at ${version})`)
})
