import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { handlePeerRoster, pushPeerRoster } from '../src/host/federation.js'
import { ownerSkillId, sharedSkillSnapshot, skillShareStatus } from '../src/host/skill-share.js'
import { fakeContext } from './fake-ctx.js'

const skill = { name: 'release-checks', kind: 'skill', description: 'Use for release checks.', content: 'Run the checks before delivering the result.' }
const proposal = { ...skill, id: 'proposal', kind: 'skill', action: 'create', botId: 'worker', at: 1, why: 'A repeated check was missed.' }
const tick = () => new Promise(resolve => setImmediate(resolve))

async function world(t, { privateBot = false, proposals = { proposal } } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-skill-share-'))
  const bots = Object.fromEntries(['chief', 'worker', 'helper'].map(id => [id, { id, name: id, sessionId: id, capabilities: [], private: id === 'worker' && privateBot, createdAt: 1 }]))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, revision: 1, bots, mainBotIds: ['chief'], rooms: {}, threads: {}, capabilities: { items: {} } }))
  mkdirSync(join(home, 'learning'))
  writeFileSync(join(home, 'learning/state.json'), JSON.stringify({ proposals, pending: {}, learned: {} }))
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


// fork.131 (capability sharing, docs: ds-bot-cluster/DESIGN-capability-sharing.md §3.2): what the owner made on the hub
// goes to every node by default and is on for every Bot there, without anyone marking it reusable or attaching it.
const addSkill = (rt, name, content = 'Run the checks before delivering the result.', extra = {}) => {
  rt.state.capabilities.items[name] = { name, kind: 'skill', description: `Use for ${name}.`, content, createdBy: null, createdAt: 1, updatedAt: 1, ...extra }
}
const importedOf = (rt, sharedName) => Object.values(rt.state.capabilities.items).find(item => item.sharedFrom && item.sharedName === sharedName)
async function toNode(hub, node) {
  await pushPeerRoster(hub.rt, 'n1')
  await handlePeerRoster(node.rt, hub.sent.at(-1).data)
}

test('SHARE-1 a skill nobody marked reusable reaches a node and is on for a Bot that attached nothing', async t => {
  const hub = await world(t)
  const node = await world(t)
  addSkill(hub.rt, 'release-checks')
  await toNode(hub, node)
  const imported = importedOf(node.rt, 'release-checks')
  assert.ok(imported, 'the node has the hub\'s skill')
  assert.equal(imported.sharedFrom.startsWith('hub:'), true)
  assert.deepEqual(node.rt.state.bots.helper.capabilities, [], 'nothing was attached')
  await node.rt.ensureCapabilities('helper')
  assert.equal(node.skills.get('helper').get(imported.name).content, 'Run the checks before delivering the result.')
})

test('SHARE-2 a Bot turns a shared skill off and on again; the others keep it', async t => {
  const hub = await world(t)
  const node = await world(t)
  addSkill(hub.rt, 'release-checks')
  await toNode(hub, node)
  const name = importedOf(node.rt, 'release-checks').name
  await node.rt.ensureCapabilities('helper')
  await node.rt.ensureCapabilities('worker')
  await node.rt.changeCapabilityAttachment('detach', { name }, 'helper')
  assert.deepEqual(node.rt.state.bots.helper.capabilityOff, [name])
  await node.rt.ensureCapabilities('helper')
  assert.equal(node.skills.get('helper').has(name), false, 'off for helper')
  await node.rt.ensureCapabilities('worker')
  assert.equal(node.skills.get('worker').has(name), true, 'still on for worker')
  await node.rt.changeCapabilityAttachment('attach', { name }, 'helper')
  assert.deepEqual(node.rt.state.bots.helper.capabilityOff, [])
  await node.rt.ensureCapabilities('helper')
  assert.equal(node.skills.get('helper').has(name), true, 'on again')
})

test('SHARE-3 the hub\'s own Bots are not given what came from nodes by default, and nothing implied there', async t => {
  const hub = await world(t)
  const node = await world(t)
  addSkill(node.rt, 'node-made', 'Check the node before delivering.', { teamReusable: true, sharedId: '00000000-0000-4000-8000-000000000001' })
  hub.registry.emit('roster', { ...(await (async () => { await node.rt.publishSkillRoster(); return node.reports.at(-1) })()), nodeId: 'n1', hostname: 'node' })
  await tick(); await tick()
  const imported = importedOf(hub.rt, 'node-made')
  assert.ok(imported, 'the hub imported it')
  await hub.rt.ensureCapabilities('chief')
  assert.equal(hub.skills.get('chief')?.has(imported.name) ?? false, false, 'a node\'s skill is not on for the hub\'s Bots unless attached')
})

test('SHARE-4 an absolute path is allowed between the owner\'s own machines; a secret never is; a private Bot\'s skill stays home', async t => {
  const hub = await world(t)
  const node = await world(t)
  addSkill(hub.rt, 'uses-path', 'Open /Users/example/project/notes.md and summarise it.')
  addSkill(hub.rt, 'has-secret', 'Call it with $DSH_SECRET_EXAMPLE as the key.')
  addSkill(hub.rt, 'private-one', 'Keep this to yourself.', { createdBy: 'worker' })
  hub.rt.isPrivate = id => id === 'worker'
  const status = Object.fromEntries(skillShareStatus(hub.rt).map(item => [item.name, item]))
  assert.equal(status['uses-path'].shared, true)
  assert.equal(status['has-secret'].shared, false)
  assert.match(status['has-secret'].reason, /secrets/)
  assert.equal(status['private-one'], undefined, 'a private Bot\'s skill is not even listed')
  await toNode(hub, node)
  assert.ok(importedOf(node.rt, 'uses-path'))
  assert.equal(importedOf(node.rt, 'has-secret'), undefined)
  assert.equal(importedOf(node.rt, 'private-one'), undefined)
})

test('SHARE-5 between people nothing changed: an unmarked skill, or one with a path, is not in the ordinary snapshot', async t => {
  const w = await world(t)
  addSkill(w.rt, 'unmarked')
  addSkill(w.rt, 'marked', 'Open /Users/example/x.', { teamReusable: true, sharedId: '00000000-0000-4000-8000-000000000002' })
  assert.deepEqual(sharedSkillSnapshot(w.rt).items, [], 'without toNodes only an approved, clean skill goes')
  assert.equal(sharedSkillSnapshot(w.rt, { toNodes: true }).items.length, 2)
})

test('SHARE-6 the share id is the same on every push and different for each skill', async t => {
  const w = await world(t)
  addSkill(w.rt, 'one-skill')
  addSkill(w.rt, 'two-skill')
  const first = sharedSkillSnapshot(w.rt, { toNodes: true }).items
  const second = sharedSkillSnapshot(w.rt, { toNodes: true }).items
  assert.deepEqual(first.map(item => item.id), second.map(item => item.id))
  assert.equal(new Set(first.map(item => item.id)).size, 2)
  assert.equal(first.find(item => item.name === 'one-skill').id, ownerSkillId('one-skill'))
})

test('SHARE-7 one bad item from the hub is left out and the rest still arrive; a skill the hub withdrew goes from the node', async t => {
  const hub = await world(t)
  const node = await world(t)
  addSkill(hub.rt, 'keep-me')
  addSkill(hub.rt, 'drop-me')
  await toNode(hub, node)
  assert.ok(importedOf(node.rt, 'keep-me') && importedOf(node.rt, 'drop-me'))
  // The next push has a forged item with a secret in it, and one skill less.
  delete hub.rt.state.capabilities.items['drop-me']
  await pushPeerRoster(hub.rt, 'n1')
  const frame = structuredClone(hub.sent.at(-1).data)
  frame.skills.items.push({ id: '00000000-0000-4000-8000-0000000000aa', name: 'forged', description: 'Use it.', content: 'The key is api_key=fixture-secret-value' })
  await handlePeerRoster(node.rt, frame)
  assert.ok(importedOf(node.rt, 'keep-me'), 'the good one stays')
  assert.equal(importedOf(node.rt, 'drop-me'), undefined, 'a withdrawn skill is gone')
  assert.equal(importedOf(node.rt, 'forged'), undefined, 'the bad one is not taken')
})

test('SHARE-8 a push that arrives while the node runs mounts the skill for Bots that attached nothing, with no other call', async t => {
  const hub = await world(t)
  const node = await world(t)
  addSkill(hub.rt, 'release-checks')
  await toNode(hub, node)
  for (let i = 0; i < 12; i += 1) await tick()
  const name = importedOf(node.rt, 'release-checks').name
  assert.equal(node.skills.get('helper')?.has(name), true, 'mounted for helper')
  assert.equal(node.skills.get('worker')?.has(name), true, 'mounted for worker')
})

test('SHARE-9 list_capabilities says which skills go to the nodes and why one does not, and which the hub shares with this Bot', async t => {
  const hub = await world(t)
  const node = await world(t)
  addSkill(hub.rt, 'release-checks')
  addSkill(hub.rt, 'has-secret', 'Use $DSH_SECRET_EXAMPLE here.')
  const list = rt => rt.teamTools.find(def => def.name === 'list_capabilities').execute({}, { agent: { id: 'chief' } })
  const onHub = String(await list(hub.rt))
  assert.match(onHub, /release-checks \(skill\).*goes to every node/)
  assert.match(onHub, /has-secret \(skill\).*not shared with the nodes: Shared skills cannot contain secrets/)
  await toNode(hub, node)
  const onNode = String(await node.rt.teamTools.find(def => def.name === 'list_capabilities').execute({}, { agent: { id: 'helper' } }))
  assert.match(onNode, /shared by the hub; on for you/)
  await node.rt.changeCapabilityAttachment('detach', { name: importedOf(node.rt, 'release-checks').name }, 'helper')
  assert.doesNotMatch(String(await node.rt.teamTools.find(def => def.name === 'list_capabilities').execute({}, { agent: { id: 'helper' } })), /on for you/)
})
