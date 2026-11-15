import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { joinedUpdateBot, createBotUpdateReceiver } from '../src/host/joined-page.js'
import { install as installRoster } from '../src/host/roster.js'

const cap = 'bot-profile-update/1'
const profile = { name: 'Scout', role: 'Research', color: 'blue', avatar: { shape: 'cat' } }
const fields = Object.keys(profile)

function hub({ caps = [cap], answer = async data => ({ ok: true, ...data }), hello = true } = {}) {
  const registry = new EventEmitter()
  registry.sent = []
  registry.onlineNodes = () => [{ nodeId: 'n1', ...(hello ? { hello: { caps } } : { caps }) }]
  registry.send = (nodeId, type, data) => {
    registry.sent.push({ nodeId, type, data })
    Promise.resolve().then(async () => registry.emit('botUpdateResult', { requestId: data.requestId, ...await answer(data) }))
    return true
  }
  const bot = { id: 'joined:n1:rb1', origin: 'joined', worker: { home: 'remote', nodeId: 'n1', remoteBotId: 'rb1' }, name: 'Old', role: 'Old role', color: 'red', avatar: { shape: 'dog' }, sectionId: 'hub-section' }
  let saves = 0
  const rt = {
    ctx: { get: key => key === 'remote-agent:registry' ? registry : undefined },
    botOf: id => id === bot.id ? bot : undefined,
    save: async () => { saves++ }, botUpdateTimeoutMs: 200,
  }
  return { rt, bot, registry, saves: () => saves }
}

function node() {
  const bot = { id: 'rb1', name: 'Old', role: 'Old role', color: 'red', avatar: { shape: 'dog' }, managedBy: 'hub', kickoff: 'held', sectionId: 'node-section' }
  const state = { bots: { rb1: bot, rb2: { id: 'rb2', name: 'Taken' } }, rooms: {}, mainBotIds: [] }
  const rt = {
    state, defaults: {},
    ctx: { get: () => undefined, sessionTitle: { rename: async () => {} } },
    botOf: id => state.bots[id],
    findBot: name => Object.values(state.bots).find(b => b.name.toLowerCase() === name.toLowerCase()),
    checkPrivacyChange: async () => {}, chatOf: id => id,
    resolveAgent: async id => ({ session: { id } }), save: async () => {},
  }
  installRoster(rt)
  return { rt, bot, accept: createBotUpdateReceiver(rt) }
}

test('hub sends profile fields only with the capability, never section assignment', async () => {
  for (const hello of [true, false]) {
    const h = hub({ hello })
    const result = await joinedUpdateBot(h.rt, h.bot.id, { ...profile, sectionId: 'ignored', section: 'ignored' })
    assert.equal(result.ok, true)
    for (const key of fields) assert.deepEqual(h.registry.sent[0].data[key], profile[key])
    assert.equal(Object.hasOwn(h.registry.sent[0].data, 'sectionId'), false)
    assert.equal(Object.hasOwn(h.registry.sent[0].data, 'section'), false)
  }
})

test('profile-only edits on old nodes fail explicitly before sending or saving', async () => {
  for (const patch of [{ name: 'New' }, { role: '' }, { color: 'blue' }, { avatar: { shape: 'cat' } }, { avatar: null, color: null }]) {
    const h = hub({ caps: [] })
    assert.deepEqual(await joinedUpdateBot(h.rt, h.bot.id, patch), { ok: false, error: 'bot-update-profile-unsupported' })
    assert.equal(h.registry.sent.length, 0)
    assert.equal(h.saves(), 0)
    assert.equal(h.bot.name, 'Old')
  }
})

test('old nodes still receive supported model changes without profile fields', async () => {
  const h = hub({ caps: [] })
  const result = await joinedUpdateBot(h.rt, h.bot.id, { ...profile, model: 'p/m' })
  assert.equal(result.ok, true)
  assert.equal(h.registry.sent[0].data.model, 'p/m')
  for (const key of fields) assert.equal(Object.hasOwn(h.registry.sent[0].data, key), false)
  assert.equal(h.bot.name, 'Old')
})

test('shadow and return value follow the node echo rather than the requested profile', async () => {
  const applied = { name: 'Applied', role: '', color: 'green', avatar: { shape: 'bird' } }
  const h = hub({ answer: async () => ({ ok: true, ...applied }) })
  const result = await joinedUpdateBot(h.rt, h.bot.id, profile)
  for (const key of fields) {
    assert.deepEqual(h.bot[key], applied[key])
    assert.deepEqual(result[key], applied[key])
  }
  assert.equal(h.saves(), 1)
  assert.equal(h.bot.sectionId, 'hub-section')
})

test('node receiver applies the profile through the real roster and echoes normalised values', async () => {
  const n = node()
  const result = await n.accept({ remoteBotId: 'rb1', ...profile, name: ' Scout ', role: ' Research ' })
  assert.equal(result.ok, true, result.error)
  for (const key of fields) {
    assert.deepEqual(n.bot[key], profile[key])
    assert.deepEqual(result[key], profile[key])
  }
  assert.equal(n.bot.sectionId, 'node-section')
})

test('hub-to-node profile edit updates authoritative roster and shadow together', async () => {
  const n = node()
  const h = hub({ answer: n.accept })
  const result = await joinedUpdateBot(h.rt, h.bot.id, profile)
  assert.equal(result.ok, true, result.error)
  for (const key of fields) assert.deepEqual(h.bot[key], n.bot[key])
  assert.equal(n.bot.name, 'Scout')
})

test('avatar reset and empty label survive the wire and clear both rows from the echo', async () => {
  const n = node()
  const h = hub({ answer: n.accept })
  const result = await joinedUpdateBot(h.rt, h.bot.id, { role: '', color: null, avatar: null })
  assert.equal(result.ok, true, result.error)
  assert.equal(h.registry.sent[0].data.role, '')
  assert.equal(h.registry.sent[0].data.color, '')
  assert.deepEqual(h.registry.sent[0].data.avatar, {})
  for (const bot of [n.bot, h.bot]) {
    assert.equal(bot.role, '')
    assert.equal(Object.hasOwn(bot, 'color'), false)
    assert.equal(Object.hasOwn(bot, 'avatar'), false)
  }
  assert.equal(result.color, null)
  assert.equal(result.avatar, null)
})

test('node name clash surfaces its exact error and leaves shadow unchanged', async () => {
  const n = node()
  const h = hub({ answer: n.accept })
  const result = await joinedUpdateBot(h.rt, h.bot.id, { name: 'Taken' })
  assert.deepEqual(result, { ok: false, error: 'bot-update-failed: Name Taken is not available' })
  assert.equal(h.bot.name, 'Old')
  assert.equal(n.bot.name, 'Old')
  assert.equal(h.saves(), 0)
})

test('profile support does not bypass the node model allowlist', async () => {
  const n = node()
  n.rt.catalog = async () => [{ ref: 'p/allowed' }]
  const result = await n.accept({ remoteBotId: 'rb1', ...profile, model: 'p/unknown' })
  assert.deepEqual(result, { ok: false, error: 'bot-update-model-not-on-node' })
  assert.equal(n.bot.name, 'Old')
})

test('peer roster rows remain read-only, including through the receiver', async () => {
  const n = node()
  n.bot.origin = 'peer'
  await assert.rejects(n.rt.updateBot('rb1', profile), { code: 'E_SHADOW_READONLY' })
  const result = await n.accept({ remoteBotId: 'rb1', ...profile })
  assert.equal(result.ok, false)
  assert.match(result.error, /read-only/)
  assert.equal(n.bot.name, 'Old')
})

test('unsupported memory does not block a profile update the node can apply', async () => {
  const h = hub()
  const result = await joinedUpdateBot(h.rt, h.bot.id, { name: 'Scout', memoryConfig: { backend: 'file' } })
  assert.equal(result.ok, true)
  assert.equal(h.registry.sent[0].data.name, 'Scout')
  assert.equal(Object.hasOwn(h.registry.sent[0].data, 'memoryConfig'), false)
})
