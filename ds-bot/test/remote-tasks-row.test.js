import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pickRemoteTasks } from '../src/host/remote-tasks.js'

const rows = [
  { taskId: 'newest', fromId: 'chief', toId: 'worker' },
  { taskId: 'middle', fromId: 'worker', toId: 'chief' },
  { taskId: 'oldest', fromId: 'other', toId: 'helper' },
]

test('non-array rows return an empty list', () => {
  for (const value of [undefined, null, {}, 'rows', 42]) assert.deepEqual(pickRemoteTasks(value), [])
})

test('filters by fromId', () => {
  assert.deepEqual(pickRemoteTasks(rows, 'other'), [rows[2]])
})

test('filters by toId', () => {
  assert.deepEqual(pickRemoteTasks(rows, 'helper'), [rows[2]])
})

test('unknown Bot returns an empty list', () => {
  assert.deepEqual(pickRemoteTasks(rows, 'missing'), [])
})

test('empty, absent and non-string botId keep all rows', () => {
  for (const botId of ['', undefined, null, 42]) assert.deepEqual(pickRemoteTasks(rows, botId), rows)
})

for (const [limit, expected] of [[0, 1], [999, 50], [undefined, 20], [3.5, 20], ['5', 20], [null, 20]]) {
  test(`limit ${JSON.stringify(limit)} returns at most ${expected} rows`, () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ taskId: `task-${i}` }))
    assert.deepEqual(pickRemoteTasks(many, '', limit), many.slice(0, expected))
  })
}

test('filtering and limiting preserve input order without mutating the input', () => {
  const input = Object.freeze([rows[2], rows[1], rows[0]])
  assert.deepEqual(pickRemoteTasks(input, 'chief', 2), [rows[1], rows[0]])
  assert.deepEqual(pickRemoteTasks(input, 'chief', 1), [rows[1]])
  assert.deepEqual(input, [rows[2], rows[1], rows[0]])
})
