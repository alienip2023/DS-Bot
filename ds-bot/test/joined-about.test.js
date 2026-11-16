import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { joinedUpdateBot, createBotUpdateReceiver } from '../src/host/joined-page.js'
import { install as installRoster } from '../src/host/roster.js'

function hub(answer) {
  const registry = new EventEmitter()
  registry.sent = []
  registry.onlineNodes = () => [{ nodeId: 'n1' }]
  registry.send = (nodeId, type, data) => {
    registry.sent.push({ nodeId, type, data })
    Promise.resolve().then(async () => registry.emit('botUpdateResult', { requestId: data.requestId, ...await answer(data) }))
    return true
  }
  const bot = {
    id: 'joined:n1:rb1', origin: 'joined',
    worker: { home: 'remote', nodeId: 'n1', remoteBotId: 'rb1' },
    instructions: '旧的简介', workDir: '/old-workspace',
  }
  const saved = []
  const rt = {
    ctx: { get: key => key === 'remote-agent:registry' ? registry : undefined },
    botOf: id => id === bot.id ? bot : undefined,
    save: async () => { saved.push(structuredClone(bot)) }, botUpdateTimeoutMs: 200,
  }
  return { rt, bot, registry, saved }
}

test('a successful joined About edit saves the node instructions to the shadow row', async () => {
  const h = hub(async () => ({ ok: true, instructions: '新的简介' }))
  const result = await joinedUpdateBot(h.rt, h.bot.id, { instructions: '新的简介' })
  assert.equal(result.ok, true)
  assert.equal(h.registry.sent[0].type, 'bot/update')
  assert.equal(h.registry.sent[0].data.instructions, '新的简介')
  assert.equal(result.instructions, '新的简介')
  assert.equal(h.bot.instructions, '新的简介')
  assert.equal(h.saved[0].instructions, '新的简介')
})

test('instructions and workDir follow the node echo rather than the requested values', async () => {
  const applied = { instructions: 'Normalised instructions', workDir: '/node-workspace' }
  const h = hub(async () => ({ ok: true, ...applied }))
  const result = await joinedUpdateBot(h.rt, h.bot.id, { instructions: '  Requested instructions  ', workDir: '/requested-workspace' })
  assert.equal(result.ok, true)
  assert.equal(h.registry.sent[0].data.workDir, '/requested-workspace')
  for (const key of Object.keys(applied)) {
    assert.equal(h.bot[key], applied[key])
    assert.equal(result[key], applied[key])
    assert.equal(h.saved[0][key], applied[key])
  }
})

test('explicit empty strings clear the shadow instructions and workDir', async () => {
  const h = hub(async () => ({ ok: true, instructions: '', workDir: '' }))
  const result = await joinedUpdateBot(h.rt, h.bot.id, { instructions: '', workDir: '' })
  assert.equal(result.ok, true)
  for (const key of ['instructions', 'workDir']) {
    assert.equal(h.registry.sent[0].data[key], '')
    assert.equal(h.bot[key], '')
    assert.equal(h.saved[0][key], '')
  }
})

for (const value of [undefined, null, 123, false, {}]) {
  test(`non-string echoes preserve the shadow instructions and workDir: ${JSON.stringify(value)}`, async () => {
    const h = hub(async () => ({ ok: true, instructions: value, workDir: value }))
    const result = await joinedUpdateBot(h.rt, h.bot.id, { instructions: 'Requested instructions', workDir: '/requested-workspace' })
    assert.equal(result.ok, true)
    assert.equal(h.bot.instructions, '旧的简介')
    assert.equal(h.bot.workDir, '/old-workspace')
    assert.equal(h.saved[0].instructions, '旧的简介')
    assert.equal(h.saved[0].workDir, '/old-workspace')
  })
}

test('a failed update leaves the shadow and saved roster unchanged', async () => {
  const h = hub(async () => ({ ok: false, error: 'bot-update-failed', instructions: 'Rejected', workDir: '/rejected' }))
  const result = await joinedUpdateBot(h.rt, h.bot.id, { instructions: 'Rejected', workDir: '/rejected' })
  assert.deepEqual(result, { ok: false, error: 'bot-update-failed' })
  assert.equal(h.bot.instructions, '旧的简介')
  assert.equal(h.bot.workDir, '/old-workspace')
  assert.equal(h.saved.length, 0)
})

test('joined About edits reach the real node roster and save its normalised echo', async () => {
  const bot = { id: 'rb1', name: 'Scout', instructions: '旧的简介', managedBy: 'hub', kickoff: 'held' }
  const state = { bots: { rb1: bot }, rooms: {}, mainBotIds: [] }
  const saved = []
  const rt = {
    state, defaults: {}, ctx: {},
    botOf: id => state.bots[id],
    chatOf: id => id, checkPrivacyChange: async () => {},
    save: async () => { saved.push(structuredClone(bot)) },
  }
  installRoster(rt)
  const h = hub(createBotUpdateReceiver(rt))
  for (const instructions of ['  新的简介  ', '']) {
    const result = await joinedUpdateBot(h.rt, h.bot.id, { instructions })
    assert.equal(result.ok, true, result.error)
    assert.equal(bot.instructions, instructions.trim())
    assert.equal(saved.at(-1).instructions, instructions.trim())
    assert.equal(result.instructions, bot.instructions)
    assert.equal(h.bot.instructions, bot.instructions)
    assert.equal(h.saved.at(-1).instructions, bot.instructions)
  }
})
