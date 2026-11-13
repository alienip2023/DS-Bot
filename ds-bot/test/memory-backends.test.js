import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canFederate, canShowMemoryHub, memoryBackendChoices } from '../src/client/memory-backends.js'

const values = choices => choices.map(choice => choice.value)

test('the federated backend is only offered where a node identity exists', () => {
  assert.deepEqual(values(memoryBackendChoices()), ['auto', 'mneme', 'file', 'none'])
  assert.deepEqual(values(memoryBackendChoices({ federate: true })), ['auto', 'mneme', 'file', 'federation', 'none'])
  // The host refuses federation without a node; the menu must not offer it there either.
  assert.equal(memoryBackendChoices({ federate: false }).some(choice => choice.value === 'federation'), false)
})

test('canFederate reads the roster flag the host adds', () => {
  assert.equal(canFederate({ memoryFederation: { canFederate: true } }), true)
  assert.equal(canFederate({ memoryFederation: { canFederate: false } }), false)
  assert.equal(canFederate({ memoryFederation: {} }), false)
  assert.equal(canFederate({}), false)
  assert.equal(canFederate(undefined), false)
})

test('canShowMemoryHub is true only when a hub answered', () => {
  assert.equal(canShowMemoryHub({ memoryFederation: { hub: true } }), true)
  assert.equal(canShowMemoryHub({ memoryFederation: { hub: false } }), false)
  assert.equal(canShowMemoryHub({ memoryFederation: {} }), false)
  assert.equal(canShowMemoryHub({}), false)
  assert.equal(canShowMemoryHub(undefined), false)
})
