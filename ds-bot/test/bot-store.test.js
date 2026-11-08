// test/bot-store.test.js — unit tests for bot-store.js (BotRecord, buildBySessionId, updateBySessionId)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toBotRecord, buildBySessionId, updateBySessionId } from '../src/host/bot-store.js'

const raw_local = { id: 'bot-1', sessionId: 'sid-1', model: 'm/a', segments: [{ sessionId: 'seg-old' }] }
const raw_joined = { id: 'bot-2', origin: 'joined', sessionId: 'sid-2', worker: { nodeId: 'n1', remoteBotId: 'rb1', hostname: 'h1', home: 'remote', online: true, lastSeen: null } }

test('toBotRecord: local bot', () => {
  const r = toBotRecord(raw_local)
  assert.equal(r.id, 'bot-1')
  assert.equal(r.kind, 'local')
  assert.equal(r.sessionId, 'sid-1')
  assert.equal(r.model, 'm/a')
  assert.deepEqual(r.parts, ['seg-old']) // segment.sessionId extracted
})

test('toBotRecord: joined bot preserves origin + worker for joinedShadow()', () => {
  const r = toBotRecord(raw_joined)
  assert.equal(r.id, 'bot-2')
  assert.equal(r.kind, 'joined')
  assert.equal(r.origin, 'joined')   // joinedShadow reads origin
  assert.equal(r.worker?.home, 'remote')  // joinedShadow reads worker.home
  assert.equal(r.sessionId, 'sid-2')
})

test('toBotRecord: no sessionId gives null', () => {
  const r = toBotRecord({ id: 'x' })
  assert.equal(r.sessionId, null)
})

test('buildBySessionId indexes current sessionId', () => {
  const bots = [raw_local, raw_joined]
  const m = buildBySessionId(bots)
  assert.equal(m.get('sid-1'), 'bot-1')
  assert.equal(m.get('sid-2'), 'bot-2')
})

test('buildBySessionId also indexes segment sessionIds', () => {
  const m = buildBySessionId([raw_local])
  assert.equal(m.get('seg-old'), 'bot-1', 'historical segment sessionId must be indexed')
})

test('buildBySessionId skips null/empty sessionId', () => {
  const m = buildBySessionId([{ id: 'x', sessionId: null }, { id: 'y', sessionId: '' }])
  assert.equal(m.size, 0)
})

test('updateBySessionId replaces entry', () => {
  const m = new Map([['old', 'bot-1']])
  updateBySessionId(m, 'bot-1', 'old', 'new')
  assert.equal(m.has('old'), false)
  assert.equal(m.get('new'), 'bot-1')
})

test('updateBySessionId clears when newSessionId is null', () => {
  const m = new Map([['old', 'bot-1']])
  updateBySessionId(m, 'bot-1', 'old', null)
  assert.equal(m.has('old'), false)
})
