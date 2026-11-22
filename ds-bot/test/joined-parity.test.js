// A node Bot is used exactly like a hub Bot: a control that cannot act on the node refuses with an
// explicit reason instead of returning ok and editing only the hub's shadow row.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureMainThread } from '../src/host/bot-store.js'
import { NODE_ONLY_REASON } from '../src/host/roster-join.js'
import { makeBot, threadWorld } from './thread-t2-world.js'

const JOINED = 'joined:n1:rb1'

async function world() {
  const w = threadWorld()
  const local = await makeBot(w, 'Alpha')
  const bot = {
    id: JOINED, name: 'Remote', origin: 'joined', type: 'remote-worker', createdAt: 5, capabilities: [], packs: [],
    worker: { nodeId: 'n1', remoteBotId: 'rb1', hostname: 'box-1', home: 'remote', online: true },
  }
  w.rt.state.bots[JOINED] = bot
  ensureMainThread(w.rt.state, bot)
  return { w, local, bot }
}

test('update-bot refuses permission, private, type and worker edits of a node Bot and changes nothing', async () => {
  const { w, bot } = await world()
  const before = JSON.stringify(bot)
  w.rt.joinedUpdateBot = async () => { throw new Error('the node must not be asked') }
  for (const patch of [{ permission: 'full-access' }, { private: true }, { type: null }, { worker: { hubUrl: 'x' } }, { browserGrants: {} }]) {
    const result = await w.call('update-bot', { id: JOINED, ...patch })
    assert.equal(result.ok, false, JSON.stringify(patch))
    assert.equal(result.error.code, 'bot/refused')
    assert.equal(result.error.message, NODE_ONLY_REASON)
  }
  assert.equal(JSON.stringify(w.rt.state.bots[JOINED]), before)
})

test('update-bot still sends what the node can take (name, model, folder) through bot/update', async () => {
  const { w } = await world()
  const sent = []
  w.rt.joinedUpdateBot = async (id, patch) => { sent.push({ id, patch }); return { ok: true } }
  const result = await w.call('update-bot', { id: JOINED, name: 'Renamed', workDir: '/srv/x' })
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].patch.workDir, '/srv/x')
})

test('capability attach, browser control and computer control refuse for a node Bot, and work for a hub Bot', async () => {
  const { w, local } = await world()
  for (const [endpoint, body] of [
    ['bot-capability', { botId: JOINED, name: 'anything', attached: true }],
    ['browser-takeover', { botId: JOINED }],
    ['browser-give-back', { botId: JOINED }],
    ['browser-stop', { botId: JOINED }],
    ['computer-set-level', { botId: JOINED, level: 'ask' }],
    ['computer-revoke-app', { botId: JOINED, appKey: 'x' }],
    ['computer-takeover', { botId: JOINED }],
    ['computer-handback', { botId: JOINED }],
    ['computer-allow-foreground', { botId: JOINED }],
  ]) {
    const result = await w.call(endpoint, body)
    assert.equal(result.ok, false, endpoint)
    assert.equal(result.error.code, 'bot/refused', endpoint)
    assert.equal(result.error.message, NODE_ONLY_REASON, endpoint)
  }
  // A hub Bot is not caught by the guard: it reaches the endpoint's own answer.
  const hub = await w.call('bot-capability', { botId: local.id, name: 'nothing-here', attached: true })
  assert.notEqual(hub.error?.message, NODE_ONLY_REASON)
})

test('duplicate-bot refuses a node Bot instead of making a hub Bot with the node\'s model and folder', async () => {
  const { w, local } = await world()
  const before = Object.keys(w.rt.state.bots).sort()
  w.rt.state.bots[JOINED].model = 'node-only/model'
  w.rt.state.bots[JOINED].workDir = '/srv/node-only'
  const result = await w.call('duplicate-bot', { id: JOINED })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/refused')
  assert.match(result.error.message, /node Bot cannot be copied/)
  assert.deepEqual(Object.keys(w.rt.state.bots).sort(), before)
  const hub = await w.call('duplicate-bot', { id: local.id })
  assert.equal(hub.ok, true, 'a hub Bot still duplicates')
})

test('a node clock that is ahead of the hub, or a month behind, does not show a nonsense age', async () => {
  const { applyRosterReport, clampNodeTime } = await import('../src/host/roster-join.js')
  const { installHub } = await import('../src/host/node-cards.js')
  const now = 1_800_000_000_000
  const DAY = 24 * 60 * 60 * 1000
  assert.equal(clampNodeTime(now - 60_000, now), now - 60_000, 'a normal timestamp is kept')
  assert.equal(clampNodeTime(now + 4_000, now), now + 4_000, 'a few seconds ahead is clock skew, kept')
  assert.equal(clampNodeTime(now + 6_000, now), now, 'more than 5 s in the future uses the receive time')
  assert.equal(clampNodeTime(now - 31 * DAY, now), now, 'older than 30 days uses the receive time')
  assert.equal(clampNodeTime(now - 31 * DAY, now + 9_000, now), now, 'the first receive time is kept, so rows do not change on every report')
  assert.equal(clampNodeTime(0, now), 0, '0 is unknown')
  assert.equal(clampNodeTime(Number.NaN, now), 0)

  const state = { bots: {} }
  const report = at => ({
    nodeId: 'n1', hostname: 'box', online: true,
    bots: [{ id: 'rb1', name: 'Remote', role: '', tasks: [{ id: 't1', title: 'Build', status: 'running', startedAt: at }], cards: [{ id: 'question:q1', kind: 'question', title: 'Which?', options: [{ id: '0', label: 'A' }], at }] }],
  })
  applyRosterReport(state, report(now + 3_600_000), now)
  const row = state.bots[JOINED]
  assert.equal(row.nodeTasks[0].startedAt, now, 'a task start an hour ahead becomes the receive time')
  assert.equal(row.nodeCards[0].at, now)
  applyRosterReport(state, report(now + 3_600_000), now + 30_000)
  assert.equal(state.bots[JOINED].nodeTasks[0].startedAt, now, 'the next report keeps the first receive time')
  applyRosterReport(state, report(now - 40 * DAY), now + 60_000)
  assert.equal(state.bots[JOINED].nodeCards[0].at, now, 'a month-old node timestamp does not make the card ancient')
  applyRosterReport(state, report(now - 5_000), now + 90_000)
  assert.equal(state.bots[JOINED].nodeTasks[0].startedAt, now - 5_000, 'a believable timestamp is used as sent')

  // The views read a row stored before the clamp the same way.
  const rt = { state, approvalsView: () => [], chatOf: () => 'mirror-1', ctx: {} }
  state.bots[JOINED].worker.lastSeen = now + 90_000
  state.bots[JOINED].nodeCards[0].at = now + 10 * DAY
  installHub(rt)
  assert.equal(rt.nodeQuestionsView()['mirror-1'].askedAt, now + 90_000)
})
