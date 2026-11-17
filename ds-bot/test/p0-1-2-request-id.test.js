import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nameProblem } from '../src/host/requests.js'

// The send path (tools.js) treats an empty or blank request_id as "no request identity" and never
// calls nameProblem for it; nameProblem itself refuses an empty name.
test('an empty id is not a request name', () => {
  assert.notEqual(nameProblem(''), undefined)
})

test('a 1-character id of an allowed character is accepted', () => {
  assert.equal(nameProblem('a'), undefined)
  assert.equal(nameProblem('_'), undefined)
  assert.equal(nameProblem('-'), undefined)
  assert.equal(nameProblem('7'), undefined)
})

test('a 15-character id of allowed characters is accepted', () => {
  assert.equal(nameProblem('a'.repeat(15)), undefined)
})

test('an 80-character id of allowed characters is accepted', () => {
  assert.equal(nameProblem('Z9_-'.repeat(20)), undefined)
})

test('an 81-character id is rejected', () => {
  assert.notEqual(nameProblem('a'.repeat(81)), undefined)
})

test('an id that contains a space is rejected', () => {
  assert.notEqual(nameProblem('abcdefgh ijklmnopq'), undefined)
})
