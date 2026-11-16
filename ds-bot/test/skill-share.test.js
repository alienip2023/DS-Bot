import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { handlePeerRoster, pushPeerRoster } from '../src/host/federation.js'
import { applySharedSkills, sharedSkillSnapshot } from '../src/host/skill-share.js'
import { hashOf } from '../src/host/learning.js'
import { fakeContext } from './fake-ctx.js'

const skill = { name: 'release-checks', kind: 'skill', description: 'Use for release checks.', content: 'Run the checks before delivering the result.' }
const proposal = { ...skill, id: 'proposal', kind: 'skill', action: 'create', botId: 'worker', at: 1, why: 'A repeated check was missed.' }
const tick = () => new Promise(resolve => setImmediate(resolve))

async function world(t, { privateBot = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-skill-share-'))
  const bots = Object.fromEntries(['chief', 'worker', 'helper'].map(id => [id, { id, name: id, sessionId: id, capabilities: [], private: id === 'worker' && privateBot, createdAt: 1 }]))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, revision: 1, bots, mainBotIds: ['chief'], rooms: {}, threads: {}, capabilities: { items: {} } }))
  mkdirSync(join(home, 'learning'))
  writeFileSync(join(home, 'learning/state.json'), JSON.stringify({ proposals: { proposal }, pending: {}, learned: {} }))
  const registry = new EventEmitter()
  const sent = []
  registry.getNode = () => ({ hello: { caps: ['peer/v1'] } })
  registry.onlineNodes = () => [{ nodeId: 'n1', hello: { caps: ['peer/v1'] } }]
  registry.send = (nodeId, type, data) => { sent.push({ nodeId, type, data: structuredClone(data) }); return true }
  const reports = []
  const ctx = fakeContext({ services: {
    'remote-agent:registry': registry,
    'remote-agent:roster-report': report => reports.push(structuredClone(report)),
  } })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false, agentsMd: false, learningTimes: { tickMs: 100_000 } })
  await rt.load()
  const agents = new Map()
  const skills = new Map()
  rt.resolveAgent = async id => {
    if (agents.has(id)) return agents.get(id)
    const registered = new Map()
    skills.set(id, registered)
    const agent = { session: { id }, ctx: {
      effect() {},
      plugin(plugin) {
        let dispose
        plugin.apply({ skills: { register(item) { registered.set(item.name, item); return () => registered.delete(item.name) } }, effect(fn) { dispose = fn() } })
        return { await: async () => {}, dispose: async () => dispose?.() }
      },
    } }
    agents.set(id, agent)
    return agent
  }
  t.after(async () => { await ctx.dispose(); await tick(); rmSync(home, { recursive: true, force: true }) })
  return { rt, ctx, home, registry, sent, reports, skills }
}

async function approve(rt, teamReusable = true) {
  return rt.learningEndpoint('learning-answer', { id: 'proposal', approve: true, teamReusable })
}

async function publish(w) {
  await w.rt.publishSkillRoster()
  return w.reports.at(-1)
}

test('approved reusable learning is saved locally and another Bot loads the exact skill', async t => {
  const w = await world(t)
  await approve(w.rt)
  const item = w.rt.state.capabilities.items[skill.name]
  assert.equal(item.teamReusable, true)
  assert.ok(w.rt.state.bots.worker.capabilities.includes(skill.name))
  const list = w.rt.teamTools.find(tool => tool.name === 'list_capabilities')
  assert.match(await list.execute({}, { agent: { id: 'helper' } }), /release-checks/)
  await w.rt.changeCapabilityAttachment('attach', { name: skill.name }, 'helper')
  await w.rt.ensureCapabilities('helper')
  assert.equal(w.skills.get('helper').get(skill.name).content, skill.content)
  assert.equal(JSON.parse(readFileSync(join(w.home, 'state.json'))).capabilities.items[skill.name].teamReusable, true)
})

test('ordinary approval and declined proposals never enter the cross-machine snapshot', async t => {
  const local = await world(t)
  await approve(local.rt, false)
  assert.equal((await publish(local)).skills.items.length, 0)
  const declined = await world(t)
  await declined.rt.learningEndpoint('learning-answer', { id: 'proposal', approve: false, teamReusable: true })
  assert.equal((await publish(declined)).skills.items.length, 0)
})

test('node learning returns through roster, hub sends it onward, receiving Bot can use it', async t => {
  const node = await world(t)
  const hub = await world(t)
  const other = await world(t)
  const memory = { team: 'fixture-team', node: 'fixture-node', bots: { helper: { text: 'fixture-own' } } }
  other.rt.state.memoryCache = structuredClone(memory)
  await approve(node.rt)
  const report = await publish(node)
  hub.registry.emit('roster', { ...report, nodeId: 'n1', hostname: 'node' })
  await tick()
  await tick()
  const imported = Object.values(hub.rt.state.capabilities.items).find(item => item.sharedFrom)
  assert.ok(imported, 'the hub must receive node-approved skill text')
  assert.equal(imported.content, skill.content)
  await pushPeerRoster(hub.rt, 'n1')
  const frame = hub.sent.at(-1)
  assert.equal(frame.type, 'peer/roster')
  await handlePeerRoster(other.rt, frame.data)
  const received = Object.values(other.rt.state.capabilities.items).find(item => item.sharedFrom)
  assert.ok(received, 'the receiving node must expose the skill as a capability')
  await other.rt.changeCapabilityAttachment('attach', { name: received.name }, 'helper')
  await other.rt.ensureCapabilities('helper')
  assert.equal(other.skills.get('helper').get(received.name).content, skill.content)
  assert.equal((await publish(other)).skills.items.length, 0, 'imports must not echo upstream')
  assert.deepEqual(other.rt.state.memoryCache, memory)
})

test('hub-approved learning reaches a node even with the peer roster display off', async t => {
  const hub = await world(t)
  const node = await world(t)
  await approve(hub.rt)
  assert.equal(hub.rt.state.prefs.federation, 'off')
  await pushPeerRoster(hub.rt, 'n1')
  await handlePeerRoster(node.rt, hub.sent.at(-1).data)
  assert.equal(Object.values(node.rt.state.capabilities.items).find(item => item.sharedFrom)?.content, skill.content)
})

test('snapshot uses a text-only whitelist and never includes memory, proposal context or MCP configuration', async t => {
  const w = await world(t)
  await approve(w.rt)
  Object.assign(w.rt.state.capabilities.items[skill.name], { env: { LOCAL_ONLY: 'fixture-env' }, path: '/fixture-only/path', why: 'fixture-conversation' })
  w.rt.state.memoryCache = { team: 'fixture-team-memory', bots: { worker: { text: 'fixture-private-memory' } } }
  const report = await publish(w)
  assert.deepEqual(Object.keys(report.skills).sort(), ['items', 'version'])
  assert.deepEqual(Object.keys(report.skills.items[0]).sort(), ['content', 'description', 'id', 'name'])
  assert.doesNotMatch(JSON.stringify(report.skills), /fixture-|learning|env|path|why/)
})

test('sharing refuses unsafe text and keeps the approval card open', async t => {
  for (const content of ['Read /Users/example/private/project', 'Read C:\\Users\\example\\private', 'Read \\\\server\\private\\file', 'Use $DSH_SECRET_EXAMPLE', 'User: private conversation\nAssistant: private answer', 'The root password is fixture-password']) {
    const w = await world(t)
    const path = join(w.home, 'learning/state.json')
    writeFileSync(path, JSON.stringify({ proposals: { proposal: { ...proposal, content } } }))
    await assert.rejects(approve(w.rt), /shar|secret|private|path/i)
    assert.ok(w.rt.learningView().worker?.length)
    assert.equal(Object.keys(w.rt.state.capabilities.items).length, 0)
  }
})

test('private Bot learning cannot be marked reusable', async t => {
  const w = await world(t, { privateBot: true })
  await assert.rejects(approve(w.rt), /private/i)
})

test('only the user can grant sharing and a Bot edit revokes the reviewed export', async t => {
  const w = await world(t)
  await assert.rejects(w.rt.capabilitySave({ ...skill, teamReusable: true }, { botId: 'worker' }), /user|approv/i)
  await approve(w.rt)
  await w.rt.capabilitySave({ ...skill, content: 'New unreviewed instructions.' }, { botId: 'worker' })
  assert.equal((await publish(w)).skills.items.length, 0)
})

test('replayed snapshots preserve local collisions and withdrawal unmounts only imported skills', async t => {
  const hub = await world(t)
  const node = await world(t)
  await approve(hub.rt)
  await node.rt.capabilitySave({ ...skill, content: 'Local instructions.' }, { ui: true })
  await pushPeerRoster(hub.rt, 'n1')
  const frame = hub.sent.at(-1).data
  await handlePeerRoster(node.rt, frame)
  const imported = Object.values(node.rt.state.capabilities.items).find(item => item.sharedFrom)
  assert.ok(imported)
  await node.rt.changeCapabilityAttachment('attach', { name: imported.name }, 'helper')
  await node.rt.ensureCapabilities('helper')
  await handlePeerRoster(node.rt, frame)
  assert.equal(Object.values(node.rt.state.capabilities.items).filter(item => item.sharedFrom).length, 1)
  await hub.rt.capabilityEndpoint('capability-delete', { name: skill.name })
  await pushPeerRoster(hub.rt, 'n1')
  await handlePeerRoster(node.rt, hub.sent.at(-1).data)
  await node.rt.reconcileCapabilities()
  assert.equal(node.skills.get('helper').has(imported.name), false)
  assert.equal(node.rt.state.capabilities.items[skill.name].content, 'Local instructions.')
})

test('unknown versions and legacy rosters do not mutate skill or memory state', async t => {
  const w = await world(t)
  const memory = { team: 'fixture-team', bots: { helper: { text: 'fixture-own' } } }
  w.rt.state.memoryCache = structuredClone(memory)
  await w.rt.capabilitySave(skill, { ui: true })
  for (const skills of [undefined, { version: 999, items: [{ ...skill, id: 'unknown' }] }]) {
    await handlePeerRoster(w.rt, { hubId: 'hub-old', level: 'roster', bots: [], skills })
  }
  assert.deepEqual(w.rt.state.memoryCache, memory)
  assert.deepEqual(Object.keys(w.rt.state.capabilities.items), [skill.name])
})

test('receiver rejects unsafe, duplicate, oversized and MCP entries without changing its library', async t => {
  const hub = await world(t)
  const node = await world(t)
  await approve(hub.rt)
  const snapshot = sharedSkillSnapshot(hub.rt)
  const entry = snapshot.items[0]
  for (const items of [
    [{ ...entry, content: 'Read /etc/private' }],
    [{ ...entry, content: 'Use $DSH_SECRET_EXAMPLE' }],
    [{ ...entry, content: 'User: personal words' }],
    [{ ...entry, content: 'x'.repeat(8001) }],
    [{ ...entry, name: '../escape' }],
    [{ name: 'server', kind: 'mcp', command: 'node' }],
    [entry, entry],
    Array(65).fill(entry),
  ]) {
    assert.equal(await applySharedSkills(node.rt, 'node:n1', { version: 1, items }), false)
    assert.deepEqual(node.rt.state.capabilities.items, {})
  }
})

test('import refresh updates mounted group and own-chat skills and survives restart', async t => {
  const hub = await world(t)
  const node = await world(t)
  await approve(hub.rt)
  const apply = () => applySharedSkills(node.rt, 'hub:one', sharedSkillSnapshot(hub.rt))
  await apply()
  const item = Object.values(node.rt.state.capabilities.items)[0]
  node.rt.state.rooms.room = { id: 'room', members: ['helper'], admin: 'helper', sessions: { helper: 'group-helper' } }
  await node.rt.save()
  await node.rt.changeCapabilityAttachment('attach', { name: item.name }, 'helper')
  await node.rt.ensureCapabilities('helper')
  await node.rt.ensureCapabilities('group-helper')
  await hub.rt.capabilityEndpoint('capability-save', { ...skill, content: 'Review the checks again.', teamReusable: true })
  await apply()
  await node.rt.reconcileCapabilities()
  for (const session of ['helper', 'group-helper']) assert.equal(node.skills.get(session).get(item.name).content, 'Review the checks again.')
  const saved = JSON.parse(readFileSync(join(node.home, 'state.json')))
  const restarted = await world(t)
  Object.assign(restarted.rt.state, saved)
  assert.equal((await publish(restarted)).skills.items.length, 0)
  await restarted.rt.ensureCapabilities('helper')
  assert.equal(restarted.skills.get('helper').get(item.name).content, 'Review the checks again.')
})

test('failed import persistence rolls back attachments and library, then retries cleanly', async t => {
  const hub = await world(t)
  const node = await world(t)
  await approve(hub.rt)
  const snapshot = sharedSkillSnapshot(hub.rt)
  const save = node.rt.save
  node.rt.save = async () => { throw new Error('fixture-save-failed') }
  await assert.rejects(applySharedSkills(node.rt, 'node:n1', snapshot), /fixture-save-failed/)
  assert.deepEqual(node.rt.state.capabilities.items, {})
  node.rt.save = save
  assert.equal(await applySharedSkills(node.rt, 'node:n1', snapshot), true)
})

test('user-approved learning can update a skill another Bot already uses', async t => {
  const w = await world(t)
  await w.rt.capabilitySave(skill, { botId: 'worker' })
  await w.rt.changeCapabilityAttachment('attach', { name: skill.name }, 'helper')
  await w.rt.ensureCapabilities('helper')
  const content = 'Run the revised checks before delivering.'
  await assert.rejects(w.rt.capabilitySave({ ...skill, content }, { botId: 'worker' }), /Another Bot uses/)
  writeFileSync(join(w.home, 'learning/state.json'), JSON.stringify({ proposals: { proposal: {
    ...proposal, action: 'update', content, base: hashOf(`${skill.description}\n${skill.content}`),
  } } }))
  await approve(w.rt)
  await w.rt.reconcileCapabilities()
  assert.equal(w.skills.get('helper').get(skill.name).content, content)
  assert.equal(w.rt.state.capabilities.items[skill.name].createdBy, 'worker')
})
