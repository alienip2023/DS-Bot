import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRosterReport, reportableBots } from '../src/host/roster-join.js'

const bot = { id: 'rb', name: 'Bot', role: 'r', model: 'node/model' }
const report = { nodeId: 'n1', hostname: 'host1', bots: [bot] }
const invalidFields = [
  ['empty', { clusterBotId: '' }],
  ['blank', { clusterBotId: '   ' }],
  ['space', { clusterBotId: 'cb 1' }],
  ['leading hyphen', { clusterBotId: '-cb-1' }],
  ['65 characters', { clusterBotId: 'a'.repeat(65) }],
  ['number', { clusterBotId: 12 }],
  ['null', { clusterBotId: null }],
  ['undefined', { clusterBotId: undefined }],
  ['missing', {}],
]

test('clusterBotId is copied and stored, trims whitespace, and accepts exactly 64 characters', () => {
  const bots = reportableBots({ rb: { ...bot, clusterBotId: 'cb-1.alpha_2' } })
  assert.equal(bots[0].clusterBotId, 'cb-1.alpha_2')
  const state = { bots: {} }
  applyRosterReport(state, { ...report, bots }, 100)
  const row = state.bots['joined:n1:rb']
  assert.equal(row.clusterBotId, 'cb-1.alpha_2')
  assert.equal(row.id, 'joined:n1:rb')
  assert.equal(row.type, 'remote-worker')
  assert.equal(row.origin, 'joined')

  const padded = { ...bot, clusterBotId: '  cb-2.alpha_3  ' }
  assert.equal(reportableBots({ rb: padded })[0].clusterBotId, 'cb-2.alpha_3')
  applyRosterReport(state, { ...report, bots: [padded] }, 200)
  assert.equal(state.bots[row.id].clusterBotId, 'cb-2.alpha_3')

  const longest = 'a'.repeat(64)
  const boundary = { ...bot, clusterBotId: longest }
  assert.equal(reportableBots({ rb: boundary })[0].clusterBotId, longest)
  applyRosterReport(state, { ...report, bots: [boundary] }, 300)
  assert.equal(state.bots[row.id].clusterBotId, longest)
})

test('reportableBots omits invalid or missing clusterBotId without adding other keys', () => {
  for (const [label, fields] of invalidFields) {
    const [entry] = reportableBots({ rb: { ...bot, ...fields } })
    assert.equal(Object.hasOwn(entry, 'clusterBotId'), false, label)
    assert.deepEqual(entry, bot, label)
  }
})

test('applyRosterReport keeps a stored clusterBotId for invalid or missing values', () => {
  const state = { bots: {} }
  const [existing] = applyRosterReport(state, report, 100)
  existing.clusterBotId = 'cb-stored'
  for (const [label, fields] of invalidFields) {
    const changes = []
    const [row] = applyRosterReport(state, { ...report, bots: [{ ...bot, ...fields }] }, 200, value => changes.push(value))
    assert.equal(row.clusterBotId, 'cb-stored', label)
    assert.deepEqual(changes, [false], label)
  }
})

test('a second report omitting clusterBotId preserves it without marking a change', () => {
  const state = { bots: {} }
  const [existing] = applyRosterReport(state, report, 100)
  existing.clusterBotId = 'cb-stored'
  const changes = []
  const [row] = applyRosterReport(state, report, 200, value => changes.push(value))
  assert.equal(row.clusterBotId, 'cb-stored')
  assert.deepEqual(changes, [false])
})

test('reports without clusterBotId retain the legacy row keys and changed flags', () => {
  const state = { bots: {} }
  const changes = []
  const [row] = applyRosterReport(state, report, 100, value => changes.push(value))
  const expected = {
    id: 'joined:n1:rb',
    name: 'Bot',
    role: 'r',
    type: 'remote-worker',
    origin: 'joined',
    homeNodeId: 'n1',
    createdAt: 100,
    capabilities: [],
    worker: {
      nodeId: 'n1',
      remoteBotId: 'rb',
      hostname: 'host1',
      home: 'remote',
      online: true,
      lastSeen: 100,
      missingFromReport: false,
    },
    model: 'node/model',
    threadIds: ['joined:n1:rb:main'],
  }
  assert.equal(Object.hasOwn(row, 'clusterBotId'), false)
  assert.deepEqual(Object.keys(row).sort(), Object.keys(expected).sort())
  assert.deepEqual(row, expected)
  const [next] = applyRosterReport(state, report, 200, value => changes.push(value))
  assert.equal(Object.hasOwn(next, 'clusterBotId'), false)
  assert.deepEqual(Object.keys(next).sort(), Object.keys(expected).sort())
  assert.deepEqual(next, { ...expected, worker: { ...expected.worker, lastSeen: 200 } })
  assert.deepEqual(changes, [true, false])
})
