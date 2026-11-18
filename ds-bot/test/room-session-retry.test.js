import assert from 'node:assert/strict'
import { test } from 'node:test'
import { format } from 'node:util'
import { install } from '../src/host/models.js'

function bench(t, failure = new Error('Session unavailable')) {
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  const attempts = []
  const warnings = []
  const listeners = new Map()
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'mock' }],
      listModels: async () => [{ id: 'model' }],
    },
    on: (name, listener) => { listeners.set(name, listener) },
    sessionController: {
      selectModel: async ({ sessionId }) => {
        attempts.push(sessionId)
        if (failure !== undefined) throw failure
      },
    },
  }
  const rt = {
    ctx,
    state: { bots: {}, prefs: {}, rooms: { room: { id: 'room', sessionId: 'broken' } } },
    sessionOfRoom: room => room.sessionId,
    warn: (...args) => warnings.push(format(...args)),
  }
  install(rt)
  return { rt, attempts, warnings, listeners, advance: ms => { now += ms }, fail: error => { failure = error } }
}

for (const [name, failure] of [
  ['format error', Object.assign(new Error('unreadable stored Session'), { name: 'SessionFormatError' })],
  ['remote corruption', new Error('RemoteError: resume failed: SessionQueryError: stored session broken is corrupt: turn/start does not open the expected turn\n    at resume (session.js:1:1)')],
  ['invalid turn', new Error('turn/start does not open the expected turn')],
  ['nested cause', new Error('resume failed', { cause: Object.assign(new Error('invalid log'), { name: 'SessionFormatError' }) })],
]) {
  test(`a permanent ${name} is quarantined and logged once`, async (t) => {
    const { rt, attempts, warnings, advance } = bench(t, failure)
    await rt.syncModels()
    advance(600_000)
    await rt.syncModels()
    await rt.syncRoomSessions()
    await rt.selectRoomSession('broken')
    assert.deepEqual(attempts, ['broken'])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /broken.*stored session is corrupt/i)
    assert.match(warnings[0], /fresh Session/i)
    assert.doesNotMatch(warnings[0], /\n|at resume/)
  })
}

test('transient retries wait exponentially and stop growing at five minutes', async (t) => {
  const { rt, attempts, warnings, advance } = bench(t)
  await rt.syncModels()
  assert.equal(attempts.length, 1)
  await rt.syncModels()
  assert.equal(attempts.length, 2)
  let expected = 2
  for (const delay of [1500, 3000, 6000, 12000, 24000, 48000, 96000, 192000, 300000, 300000]) {
    advance(delay - 1)
    await rt.syncModels()
    await rt.syncRoomSessions()
    assert.equal(attempts.length, expected, 'ticks before the deadline must not select')
    advance(1)
    await rt.syncModels()
    expected += 1
  }
  assert.equal(attempts.length, 12)
  assert.equal(warnings.length, 4, 'first failure, then failures at the cap')
  assert.match(warnings[0], /attempt 1\b/)
  assert.match(warnings[1], /attempt 10\b/)
  assert.match(warnings.at(-1), /attempt 12\b/)
})

test('a distinct transient error logs its total attempt count without bypassing backoff', async (t) => {
  const { rt, attempts, warnings, advance, fail } = bench(t)
  await rt.syncRoomSessions()
  await rt.syncRoomSessions()
  assert.equal(warnings.length, 1)
  fail(new Error('connection closed'))
  await rt.selectRoomSession('broken')
  assert.equal(attempts.length, 2)
  advance(1500)
  await rt.syncRoomSessions()
  assert.equal(warnings.length, 2)
  assert.match(warnings[1], /attempt 3\b.*connection closed/)
})

test('a first failure retries at the next sync, a second waits, and success resets the sequence', async (t) => {
  const { rt, attempts, warnings, advance, fail } = bench(t)
  await rt.syncModels()
  await rt.syncModels()
  assert.equal(attempts.length, 2)
  await rt.syncModels()
  await rt.syncRoomSessions()
  assert.equal(attempts.length, 2)
  advance(1499)
  await rt.syncModels()
  assert.equal(attempts.length, 2)
  fail(undefined)
  advance(1)
  await rt.syncModels()
  assert.equal(attempts.length, 3)

  rt.ctx.llm.listModels = async () => [{ id: 'replacement' }]
  rt.dropCatalog()
  fail(new Error('Session unavailable'))
  await rt.syncRoomSessions()
  assert.equal(attempts.length, 4)
  await rt.syncModels()
  assert.equal(attempts.length, 5, 'the first failure after success retries immediately again')
  await rt.syncModels()
  await rt.syncRoomSessions()
  assert.equal(attempts.length, 5, 'the second consecutive failure waits again')
  assert.equal(warnings.length, 2)
  assert.match(warnings[1], /attempt 1\b/)
})

test('a fresh room Session is selected and the quarantined id is forgotten', async (t) => {
  const { rt, attempts, advance, fail } = bench(t, new Error('stored session is corrupt'))
  await rt.syncModels()
  rt.state.rooms.room.sessionId = 'fresh'
  fail(undefined)
  await rt.syncModels()
  assert.deepEqual(attempts, ['broken', 'fresh'])
  rt.state.rooms.room.sessionId = 'broken'
  await rt.syncModels()
  advance(600_000)
  await rt.syncModels()
  assert.deepEqual(attempts, ['broken', 'fresh', 'broken'])
})

test('deleting a room forgets its quarantine even when no retry is due', async (t) => {
  const { rt, attempts, fail } = bench(t, new Error('stored session is corrupt'))
  await rt.syncModels()
  delete rt.state.rooms.room
  await rt.syncModels()
  rt.state.rooms.room = { id: 'room', sessionId: 'broken' }
  fail(undefined)
  await rt.syncModels()
  assert.deepEqual(attempts, ['broken', 'broken'])
})

test('deselecting a room Session drops its quarantine before the same id is reset', async (t) => {
  const { rt, attempts, fail } = bench(t, new Error('stored session is corrupt'))
  await rt.syncModels()
  delete rt.state.rooms.room.sessionId
  await rt.syncModels()
  rt.state.rooms.room.sessionId = 'broken'
  fail(undefined)
  await rt.syncModels()
  assert.deepEqual(attempts, ['broken', 'broken'])
})

test('success clears transient failures and restart does not preserve quarantine', async (t) => {
  const { rt, attempts, warnings, advance, fail } = bench(t)
  await rt.syncModels()
  fail(undefined)
  advance(1500)
  await rt.syncModels()
  await rt.syncRoomSessions()
  assert.deepEqual(attempts, ['broken', 'broken'])
  assert.equal(warnings.length, 1)
  const restarted = bench(t, new Error('stored session is corrupt'))
  await restarted.rt.syncModels()
  install(restarted.rt)
  await restarted.rt.syncModels()
  assert.deepEqual(restarted.attempts, ['broken', 'broken'])
})

test('concurrent direct and sync calls cannot select a failing Session twice', async (t) => {
  const { rt, attempts, warnings } = bench(t, new Error('stored session is corrupt'))
  await Promise.all([rt.selectRoomSession('broken'), rt.syncRoomSessions(), rt.syncModels()])
  assert.deepEqual(attempts, ['broken'])
  assert.equal(warnings.length, 1)
})
