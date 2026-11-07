// Tests for pickTargets() in src/client/create-bot.js.
// Must import the product function directly — no logic rewrite in the test.
// Knife: delete the `if (Array.isArray(res)) return res` branch → test 1 fails on length.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickTargets } from '../src/client/pick-targets.js'

test('pickTargets([{nodeId:"n1"}]) returns the array directly (real backend shape)', () => {
  const result = pickTargets([{ nodeId: 'n1' }])
  assert.equal(result.length, 1, `expected length 1, got ${result.length}`)
  assert.equal(result[0].nodeId, 'n1')
})

test('pickTargets({value:[{nodeId:"n1"}]}) unwraps legacy shell', () => {
  const result = pickTargets({ value: [{ nodeId: 'n1' }] })
  assert.equal(result.length, 1)
  assert.equal(result[0].nodeId, 'n1')
})

test('pickTargets(undefined) returns []', () => {
  assert.deepEqual(pickTargets(undefined), [])
})

test('pickTargets("x") returns []', () => {
  assert.deepEqual(pickTargets('x'), [])
})
