// test/bot-store.test.js — unit tests for BotRecord + bySessionId index
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toBotRecord, buildBySessionId, updateBySessionId } from '../src/host/bot-store.js'

test('toBotRecord: local bot has kind=local, sessionId from string', () => {
  const raw = { id: 'b1', name: 'Alpha', role: 'worker', model: 'p/m', sessionId: 'sess-1', segments: [] }
  const rec = toBotRecord(raw)
  assert.equal(rec.id, 'b1')
  assert.equal(rec.kind, 'local')
  assert.equal(rec.sessionId, 'sess-1')
})

test('toBotRecord: joined bot has kind=joined, sessionId null when absent', () => {
  const raw = { id: 'j1', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'r1', hostname: 'h', home: 'remote', online: true, lastSeen: null } }
  const rec = toBotRecord(raw)
  assert.equal(rec.kind, 'joined')
  assert.equal(rec.sessionId, null)
  assert.ok(rec.worker)
})

test('toBotRecord: sessionId null if missing or null', () => {
  assert.equal(toBotRecord({ id: 'x' }).sessionId, null)
  assert.equal(toBotRecord({ id: 'x', sessionId: null }).sessionId, null)
})

test('buildBySessionId: indexes only bots with non-empty sessionId', () => {
  const bots = [
    { id: 'b1', sessionId: 'sess-1' },
    { id: 'b2', sessionId: null },
    { id: 'b3', sessionId: 'sess-3' },
    { id: 'b4', sessionId: '' },
  ]
  const m = buildBySessionId(bots)
  assert.equal(m.get('sess-1'), 'b1')
  assert.equal(m.get('sess-3'), 'b3')
  assert.equal(m.size, 2)
})

test('updateBySessionId: adds new entry, removes old one', () => {
  const m = new Map([['sess-old', 'b1']])
  updateBySessionId(m, 'b1', 'sess-old', 'sess-new')
  assert.equal(m.has('sess-old'), false)
  assert.equal(m.get('sess-new'), 'b1')
})

test('updateBySessionId: clear old without setting new (null newSessionId)', () => {
  const m = new Map([['sess-old', 'b1']])
  updateBySessionId(m, 'b1', 'sess-old', null)
  assert.equal(m.has('sess-old'), false)
  assert.equal(m.size, 0)
})

test('updateBySessionId: does not remove if index points to a different bot', () => {
  const m = new Map([['sess-shared', 'b2']])
  updateBySessionId(m, 'b1', 'sess-shared', 'sess-new')
  // b1 owned sess-shared only if m.get('sess-shared') === 'b1' — it points to 'b2', so no delete
  assert.equal(m.get('sess-shared'), 'b2')
  assert.equal(m.get('sess-new'), 'b1')
})
