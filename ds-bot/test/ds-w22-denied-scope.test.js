import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applySharedSkills, sharedSkillSnapshot } from '../src/host/skill-share.js'
import { memoryWorld } from './ds-w22-memory-nodes.test.js'

const entry = (i, content) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `scope-fixture-${i}`, description: 'A fixture instruction', content,
})
const snapshot = (...items) => ({ version: 1, items })
const localSkill = (item, createdBy) => ({ ...item, kind: 'skill', teamReusable: true, sharedId: item.id, createdBy })
const skillHost = items => ({ state: { bots: {}, capabilities: { items } } })
const seed = (rt, scope, text) => rt.memoryHost.addEntry({ scope, text, meta: { id: 'fixture-id' }, actor: { id: 'user' } })

test('private-skill-never-snapshotted', () => {
  const privateEntry = entry(1, 'Private fixture skill.')
  const publicEntry = entry(2, 'Public fixture skill.')
  const rt = skillHost({ secret: localSkill(privateEntry, 'private-bot'), open: localSkill(publicEntry, 'public-bot') })
  rt.isPrivate = id => id === 'private-bot'
  for (const forward of [false, true]) {
    assert.deepEqual(sharedSkillSnapshot(rt, { forward }), snapshot(publicEntry), 'private creator skill must not be snapshotted')
  }
})

test('other-source-item-untouched', async () => {
  const rt = skillHost({})
  let saves = 0
  rt.save = async () => { saves++ }
  const foreign = entry(1, 'Keep source B content.')
  const owned = entry(2, 'Source A may withdraw this.')
  assert.equal(await applySharedSkills(rt, 'node:source-b', snapshot(foreign)), true)
  const before = structuredClone(rt.state.capabilities.items)
  assert.equal(await applySharedSkills(rt, 'node:source-a', snapshot(owned)), true)
  assert.equal(await applySharedSkills(rt, 'node:source-a', snapshot({ ...foreign, content: 'Attempted replacement.' })), true)
  assert.deepEqual(rt.state.capabilities.items, before, 'source must not overwrite another source')
  assert.equal(await applySharedSkills(rt, 'node:source-a', snapshot()), true)
  assert.deepEqual(rt.state.capabilities.items, before, 'source must not delete another source')
  assert.equal(saves, 3)
})

test('unknown-source-cannot-write-or-withdraw-skills', async () => {
  const own = entry(1, 'Keep the locally approved instruction.')
  const rt = skillHost({ [own.name]: localSkill(own, 'worker') })
  let saves = 0
  rt.save = async () => { saves++ }
  const before = structuredClone(rt.state)
  assert.equal(await applySharedSkills(rt, undefined, snapshot()), false, 'an absent source cannot withdraw a local skill')
  assert.equal(await applySharedSkills(rt, 'unknown:source', snapshot(entry(2, 'An unsolicited instruction.'))), false)
  assert.equal(await applySharedSkills(rt, 'node:', snapshot()), false)
  assert.deepEqual(rt.state, before)
  assert.equal(saves, 0)
})

test('private-bot-not-in-roster', async t => {
  const { rt, registry, sent } = await memoryWorld(t, { privateIds: ['private-bot'] })
  await seed(rt, { kind: 'bot', nodeId: 'node-a', botId: 'public-bot' }, 'Public node fixture fact.')
  await seed(rt, { kind: 'bot', nodeId: 'node-a', botId: 'private-bot' }, 'Private node fixture fact.')
  registry.onlineNodes = () => [{ nodeId: 'node-a' }]
  const { nodes: [node] } = await rt.memoryHub.scopes()
  assert.deepEqual(node.bots.map(bot => bot.remoteBotId), ['public-bot'], 'private Bot must not be exposed to nodes')
  assert.equal(await rt.memoryHub.push('node-a'), true)
  assert.equal(sent.at(-1).type, 'mem/snapshot')
  assert.deepEqual(sent.at(-1).payload.bots, { 'public-bot': { text: '- Public node fixture fact.' } }, 'private Bot must not be exposed to nodes')
})

test('private-bot-no-node-memory', async t => {
  const { rt, frame } = await memoryWorld(t, { privateIds: ['private-bot'] })
  const scope = { kind: 'node', nodeId: 'node-a' }
  const text = 'A node fixture fact.'
  await seed(rt, scope, text)
  assert.equal((await frame('memoryRead', { requestId: 'public-read', scope: 'node' })).entries[0].text, text)
  for (const [event, op] of [['memoryRead'], ['memoryWrite', 'add']]) {
    const requestId = `private-${event}`
    const reply = await frame(event, { requestId, remoteBotId: 'private-bot', scope: 'node', op, text: 'Private fixture fact.' })
    assert.deepEqual(reply, { requestId, ok: false, seq: 0, error: 'memory/not-on-roster' }, 'private Bot memory must not sync')
  }
  assert.deepEqual((await rt.memoryHost.readScope(scope)).flatMap(file => file.entries.map(item => item.text)), [text])
})

// A group's memory reaches a node only in the snapshot, only for the node Bots that are members of that
// group (docs/plans/2026-10-09-context-and-memory.md: members read their group's memory). Direct reads and
// writes of a group scope from a node stay refused.
test('room-memory-reaches-members-only-and-denial-carries-only-the-code', async t => {
  const { rt, frame, warnings } = await memoryWorld(t)
  const room = { kind: 'group', roomId: 'room-only' }
  const text = 'A fact only for this room.'
  await seed(rt, room, text)
  assert.equal((await rt.memoryHost.readScope(room))[0].entries[0].text, text)
  for (const scope of ['node', 'team']) {
    const reply = await frame('memoryRead', { requestId: `read-${scope}`, scope })
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.entries, [])
  }
  const rendered = await rt.memoryHub.snapshotOf('node-a')
  assert.deepEqual(rendered, { seq: 0, team: '', node: '', bots: {}, groups: { 'room-only': { members: ['public-bot'], text: `- ${text}` } } })
  rt.state.rooms['room-only'].members = []
  assert.deepEqual(await rt.memoryHub.snapshotOf('node-a'), { seq: 0, team: '', node: '', bots: {} })
  for (const [event, op] of [['memoryRead'], ['memoryWrite', 'add']]) {
    const requestId = `denied-${event}`
    const reply = await frame(event, { requestId, scope: 'group', roomId: room.roomId, op, text })
    assert.deepEqual(reply, { requestId, ok: false, seq: 0, error: 'memory/denied' })
  }
  assert.equal((await rt.memoryHost.readScope(room))[0].entries[0].text, text)
  assert.deepEqual(warnings, [])
})
