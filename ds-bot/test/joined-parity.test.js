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
