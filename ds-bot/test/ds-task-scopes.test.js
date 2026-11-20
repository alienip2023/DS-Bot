import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, normalizeScopes, scopesOverlap } from '../src/host/tasks.js'

function fakeHost() {
  const bots = { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } }
  const room = { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'a', tasks: {} }
  const otherRoom = { id: 'r2', name: 'Other', members: ['a', 'b'], admin: 'a', tasks: {} }
  const members = { ga: 'a', gb: 'b', gb2: 'b' }
  const calls = { save: 0 }
  const rt = {
    teamTools: [],
    async load() {},
    async save() { calls.save += 1 },
    selfOf: id => members[id],
    botOf: id => bots[id],
    roomOf: id => ({ r1: room, r2: otherRoom })[id],
    groupOwners: new Map([['ga', { roomId: 'r1' }], ['gb', { roomId: 'r1' }], ['gb2', { roomId: 'r2' }]]),
    isMain: id => id === 'a',
    isAdminOf: (group, id) => group.admin === id,
  }
  install(rt)
  const groupTask = rt.teamTools.find(entry => entry.name === 'group_task')
  const tool = (args, sessionId = 'gb') => groupTask.execute(args, { agent: { id: sessionId } })
  const open = (scopes, sessionId = 'gb', goal = 'Write the draft') => (
    tool(scopes === undefined ? { action: 'open', goal } : { action: 'open', goal, scopes }, sessionId)
  )
  return { room, otherRoom, calls, tool, open }
}

const eightPaths = Array.from({ length: 8 }, (_, i) => `/file-${i}`)

function assertConflict(line, task, name, path) {
  for (const detail of [task.id, name, path]) assert.ok(line.includes(detail), `Missing ${detail} in ${line}`)
}

test('normalizes backslashes and trailing slashes, deduplicates paths and drops blank strings', () => {
  assert.deepEqual(normalizeScopes(['  \\x\\draft\\\\ ', '/x/draft/', '', ' \t ', '/x/other///']), {
    scopes: ['/x/draft', '/x/other'],
  })
})

test('open rejects every glob character without creating or saving a task', async () => {
  const host = fakeHost()
  for (const char of '*?[]{}') assert.match(await host.open(['/valid', `/x/${char}`]), /glob/i)
  assert.deepEqual(host.room.tasks, {})
  assert.equal(host.calls.save, 0)
})

test('open rejects relative paths and root scopes', async () => {
  const host = fakeHost()
  assert.match(await host.open(['x/file']), /absolute/i)
  assert.match(await host.open(['/']), /root/i)
  assert.match(await host.open(['///']), /root/i)
  assert.deepEqual(host.room.tasks, {})
})

test('open rejects non-array scopes and non-string entries', async () => {
  const host = fakeHost()
  assert.match(normalizeScopes('/x/file').error, /array/i)
  assert.match(normalizeScopes(['/x/file', 123]).error, /string/i)
  await assert.rejects(host.open('/x/file'), { code: 'INVALID_ARGS' })
  await assert.rejects(host.open(['/x/file', 123]), { code: 'INVALID_ARGS' })
  assert.deepEqual(host.room.tasks, {})
})

test('open limits distinct normalized scopes to eight', async () => {
  const host = fakeHost()
  assert.match(await host.open([...eightPaths, '/extra']), /\b8\b/)
  assert.deepEqual(host.room.tasks, {})
  assert.match(await host.open([...eightPaths, '/file-0///', ' ']), /^Opened /)
  assert.deepEqual(Object.values(host.room.tasks)[0].scopes, eightPaths)
})

test('open stores normalized scopes on the task', async () => {
  const host = fakeHost()
  assert.match(await host.open(['\\x\\draft\\', '/x/draft', '/x/notes']), /^Opened /)
  assert.deepEqual(Object.values(host.room.tasks)[0].scopes, ['/x/draft', '/x/notes'])
  assert.equal(host.calls.save, 1)
})

test('open without scopes or with only blank entries leaves the field absent', async () => {
  const host = fakeHost()
  assert.match(await host.tool({ action: 'open', goal: 'Write the draft' }), /^Opened /)
  assert.match(await host.open([' ', '']), /^Opened /)
  const records = Object.values(host.room.tasks)
  assert.equal(records.length, 2)
  for (const task of records) assert.equal(Object.hasOwn(task, 'scopes'), false)
})

test('different Bots cannot open the same path and all conflicts identify task, owner and path', async () => {
  const host = fakeHost()
  await host.open(['/x/draft'], 'ga')
  await host.open(['/x/notes'], 'ga')
  const [draft, notes] = Object.values(host.room.tasks)
  const former = { ...draft, id: 'former', botId: 'former-member', status: 'blocked', scopes: ['/x/former'] }
  host.room.tasks[former.id] = former
  const error = await host.open(['/x/draft/', '/x/notes', '/x/former'])
  assert.match(error, /^Task scopes conflict/)
  const lines = error.split('\n')
  assertConflict(lines.find(line => line.includes(draft.id)) ?? '', draft, 'Chief', '/x/draft')
  assertConflict(lines.find(line => line.includes(notes.id)) ?? '', notes, 'Chief', '/x/notes')
  assertConflict(lines.find(line => line.includes('former-member')) ?? '', former, 'former-member', '/x/former')
  assert.equal(Object.keys(host.room.tasks).length, 3)
  assert.equal(host.calls.save, 2)
})

test('a directory conflicts with its descendant file in either declaration order', async () => {
  for (const [held, requested] of [['/x/docs', '/x/docs/2026/draft'], ['/x/docs/2026/draft', '/x/docs']]) {
    const host = fakeHost()
    await host.open([held], 'ga')
    const [task] = Object.values(host.room.tasks)
    const error = await host.open([requested])
    assert.match(error, /^Task scopes conflict/)
    assertConflict(error, task, 'Chief', held)
    assert.equal(Object.keys(host.room.tasks).length, 1)
    assert.equal(host.calls.save, 1)
  }
})

test('sibling paths sharing a prefix are allowed', async () => {
  assert.equal(scopesOverlap('/x/ab', '/x/abc'), false)
  const host = fakeHost()
  await host.open(['/x/ab'], 'ga')
  assert.match(await host.open(['/x/abc']), /^Opened /)
  assert.equal(Object.keys(host.room.tasks).length, 2)
})

test('one Bot can open multiple overlapping tasks', async () => {
  const host = fakeHost()
  await host.open(['/x'])
  assert.match(await host.open(['/x/draft']), /^Opened /)
  assert.equal(Object.keys(host.room.tasks).length, 2)
})

test('scope declarations are independent between rooms', async () => {
  const host = fakeHost()
  await host.open(['/x/draft'], 'ga')
  assert.match(await host.open(['/x/draft'], 'gb2'), /^Opened /)
  assert.equal(Object.keys(host.otherRoom.tasks).length, 1)
})

test('update adds normalized scopes to the existing set', async () => {
  const host = fakeHost()
  await host.open(['/x/draft'], 'ga')
  assert.match(await host.tool({ action: 'update', scopes: ['/x/draft///', '\\x\\notes', ' '], progress: 'Edited' }, 'ga'), /^Updated /)
  const [task] = Object.values(host.room.tasks)
  assert.deepEqual(task.scopes, ['/x/draft', '/x/notes'])
  assert.equal(task.progress, 'Edited')
  assert.equal(host.calls.save, 2)
})

test('update checks the union for conflicts and leaves the entire task unchanged on rejection', async () => {
  const host = fakeHost()
  await host.open(['/x/chief'], 'ga')
  await host.open(['/x/writer'])
  await host.tool({ action: 'update', status: 'review', progress: 'Drafted' })
  const [held, own] = Object.values(host.room.tasks)
  const before = structuredClone(own)
  const error = await host.tool({ action: 'update', scopes: ['/free', '/x/chief/draft'], status: 'blocked', progress: 'Changed' })
  assert.match(error, /^Task scopes conflict/)
  assertConflict(error, held, 'Chief', '/x/chief')
  assert.deepEqual(own, before)
  assert.equal(own.status, 'review')
  assert.equal(own.progress, 'Drafted')

  held.scopes = ['/x/writer']
  const unionError = await host.tool({ action: 'update', scopes: ['/free'], status: 'blocked' })
  assert.match(unionError, /^Task scopes conflict/)
  assertConflict(unionError, held, 'Chief', '/x/writer')
  assert.deepEqual(own, before)
  assert.equal(host.calls.save, 3)
})

test('update rejects an oversized union or an invalid path without mutating the task', async () => {
  const host = fakeHost()
  await host.open(eightPaths)
  const [task] = Object.values(host.room.tasks)
  const before = structuredClone(task)
  assert.match(await host.tool({ action: 'update', scopes: ['/extra'], progress: 'Changed' }), /\b8\b/)
  assert.match(await host.tool({ action: 'update', scopes: ['/x/*'], status: 'review' }), /glob/i)
  assert.deepEqual(task, before)
  assert.equal(host.calls.save, 1)
})

test('ledger includes scopes below scoped tasks and omits the line for unscoped tasks', async () => {
  const host = fakeHost()
  await host.open(['/x/draft', '/x/notes'], 'ga', 'Scoped work')
  await host.open(undefined, 'gb', 'Unscoped work')
  const ledger = await host.tool({ action: 'show' })
  assert.match(ledger, /Scoped work\n  scopes: \/x\/draft, \/x\/notes\n- /)
  assert.match(ledger, /Unscoped work \(yours\)$/)
  assert.equal(ledger.match(/\n  scopes:/g)?.length, 1)
})

test('legacy records without scopes can be shown and can acquire scopes by updating', async () => {
  const host = fakeHost()
  const legacy = { id: 'legacy', botId: 'b', goal: 'Old work', status: 'active', startedAt: 1, updatedAt: 1, progress: '' }
  host.room.tasks.legacy = legacy
  assert.match(await host.tool({ action: 'show' }), /legacy · Writer · active · Old work \(yours\)$/)
  assert.match(await host.open(['/x/new'], 'ga'), /^Opened /)
  assert.match(await host.tool({ action: 'update', id: 'legacy', scopes: ['/x/old'] }), /^Updated /)
  assert.deepEqual(legacy.scopes, ['/x/old'])
})

test('completing or cancelling a task releases its declared scopes and preserves the record', async () => {
  for (const [args, status] of [[{ action: 'complete', result: 'Delivered' }, 'done'], [{ action: 'cancel' }, 'cancelled']]) {
    const host = fakeHost()
    await host.open(['/x/draft'], 'ga')
    const [task] = Object.values(host.room.tasks)
    await host.tool(args, 'ga')
    assert.equal(task.status, status)
    assert.deepEqual(task.scopes, ['/x/draft'])
    assert.match(await host.open(['/x/draft']), /^Opened /)
  }
})
