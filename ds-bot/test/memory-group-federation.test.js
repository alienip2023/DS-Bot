// Hub group memory reaches node Bots that are members of that group, and only them.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { shadowId } from '../src/host/roster-join.js'
import { hub, rosterFor } from './memory-hub-ctx.js'
import { settle, snapshot, startNode, TEAM } from './memory-node-ctx.js'
import { GROUP_HEADING, GROUP_MEMORY_SOURCE } from '../src/host/memory-copy.js'

const groupDir = (dir, roomId) => {
  const safe = /^[A-Za-z0-9._-]{1,128}$/.test(roomId) ? roomId : createHash('sha256').update(roomId).digest('hex').slice(0, 32)
  return dir('groups', safe)
}

async function hubWithRoom(t) {
  const h = await hub({ nodes: [{ nodeId: 'n1', hostname: 'one' }, { nodeId: 'n2', hostname: 'two' }], roster: [rosterFor('n1', ['rb1', 'rb2']), rosterFor('n2', ['rc1'])] })
  t.after(h.close)
  const roomId = 'room-alpha'
  h.rt.state.rooms[roomId] = { id: roomId, name: 'Alpha', members: [shadowId('n1', 'rb1'), shadowId('n2', 'rc1')], admin: shadowId('n1', 'rb1'), mode: 'everyone', sessions: {}, seq: 0, log: [], createdAt: 1 }
  h.rt.state.rooms['room-empty'] = { id: 'room-empty', name: 'Empty', members: [shadowId('n1', 'rb2')], admin: shadowId('n1', 'rb2'), mode: 'everyone', sessions: {}, seq: 0, log: [], createdAt: 1 }
  await h.rt.save()
  const path = groupDir(h.dir, roomId)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'MEMORY.md'), '# Memory\n\n- the launch date is 3 May\n')
  return { ...h, roomId }
}

test('a node snapshot carries the memory of rooms its Bots are in, with the node-local member ids', async (t) => {
  const { rt, registry, roomId } = await hubWithRoom(t)
  await rt.memoryHub.push('n1')
  const n1 = registry.frames('mem/snapshot').filter(frame => frame.nodeId === 'n1').at(-1).payload
  assert.deepEqual(Object.keys(n1.groups), [roomId])
  assert.deepEqual(n1.groups[roomId].members, ['rb1'])
  assert.match(n1.groups[roomId].text, /launch date is 3 May/)
  await rt.memoryHub.push('n2')
  const n2 = registry.frames('mem/snapshot').filter(frame => frame.nodeId === 'n2').at(-1).payload
  assert.deepEqual(n2.groups[roomId].members, ['rc1'])
})

test('a room with no memory, or with no member on the node, is not sent', async (t) => {
  const { rt, registry, roomId } = await hubWithRoom(t)
  rt.state.rooms[roomId].members = [shadowId('n2', 'rc1')]
  await rt.memoryHub.push('n1')
  const n1 = registry.frames('mem/snapshot').at(-1).payload
  assert.equal(n1.groups, undefined)
})

test('the snapshot with groups passes the real AC validator unchanged', { skip: acRepo() ? false : 'AC repo not found' }, async (t) => {
  const { validateMemSnapshot } = await import(pathToFileURL(join(acRepo(), 'lib/protocol.js')).href)
  const { rt, registry, roomId } = await hubWithRoom(t)
  await rt.memoryHub.push('n1')
  const sent = registry.frames('mem/snapshot').at(-1).payload
  const checked = validateMemSnapshot(sent)
  assert.ok(checked, 'AC accepts the frame')
  assert.deepEqual(checked.groups[roomId].members, ['rb1'])
  assert.equal(checked.groups[roomId].text, sent.groups[roomId].text)
})

function acRepo() {
  const here = resolve(import.meta.dirname, '..')
  return [process.env.REMOTE_AGENT_REPO, resolve(here, '../../dsh-ai-cluster'), resolve(here, '../../../Projects/dsh-ai-cluster')]
    .filter(Boolean).find(dir => existsSync(join(dir, 'lib/protocol.js')))
}

// ── node side ──

const groupSession = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const nodeState = {
  ...TEAM,
  bots: { ...TEAM.bots, b1: { ...TEAM.bots.b1, remoteGroupSessions: [groupSession], remoteGroupRooms: { [groupSession]: 'room-alpha' } } },
}
const said = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

async function nodeWith(t, groups) {
  const node = startNode({ state: nodeState })
  t.after(() => node.stop())
  await node.load()
  await node.rt.memoryNode.apply({ ...snapshot(5, { team: '- team fact' }), groups })
  await settle()
  const preStep = node.ctx.listeners.get('agent/pre-step').find(listener => /federatedGroupSnapshot/.test(String(listener)))
  const step = (sessionId, messages, history = []) => preStep({ agent: { id: sessionId, session: { deriveMessages: () => history } }, messages }, async () => ({ kind: 'next', messages }))
  return { ...node, step }
}

test('a member\'s group turn on the node gets the hub group memory once; a new snapshot puts it in again', async (t) => {
  const { step, rt } = await nodeWith(t, { 'room-alpha': { text: '- the launch date is 3 May', members: ['b1'] } })
  const first = await step(groupSession, [said('when do we launch?')])
  const injected = first.messages[0]
  assert.equal(injected.source.kind, GROUP_MEMORY_SOURCE)
  assert.match(injected.content[0].text, new RegExp(GROUP_HEADING.replace(/[()]/g, '\\$&')))
  assert.match(injected.content[0].text, /launch date is 3 May/)
  // Same memory already in the conversation → nothing new.
  const again = await step(groupSession, [said('and the venue?')], [injected])
  assert.equal(again.messages.length, 1)
  // The hub changed it → put in again.
  await rt.memoryNode.apply({ ...snapshot(6), groups: { 'room-alpha': { text: '- moved to 10 May', members: ['b1'] } } })
  const changed = await step(groupSession, [said('any news?')], [injected])
  assert.match(changed.messages[0].content[0].text, /moved to 10 May/)
})

test('a non-member, the Bot\'s own chat, and a room the hub no longer sends get nothing', async (t) => {
  const { step, rt } = await nodeWith(t, { 'room-alpha': { text: '- secret plan', members: ['b2'] } })
  assert.equal((await step(groupSession, [said('hi')])).messages.length, 1)
  assert.equal((await step('b1', [said('hi')])).messages.length, 1)
  await rt.memoryNode.apply({ ...snapshot(7), groups: { 'room-alpha': { text: '- secret plan', members: ['b1'] } } })
  assert.equal((await step(groupSession, [said('hi')])).messages.length, 2)
  await rt.memoryNode.apply(snapshot(8))
  assert.equal((await step(groupSession, [said('hi')])).messages.length, 1)
  assert.equal(rt.memoryNode.groupCached(rt.botOf('b1'), 'room-alpha'), undefined)
})
