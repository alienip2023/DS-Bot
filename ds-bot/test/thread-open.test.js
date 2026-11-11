import assert from 'node:assert/strict'
import { test } from 'node:test'
import { threadSessionOpener } from '../src/client/thread-open.js'

function sessions(ids = [], { admit = true, onRefresh } = {}) {
  const byId = Object.fromEntries(ids.map(id => [id, { id }]))
  const added = []
  const face = {
    list: { getSnapshot: () => ({ byId: { ...byId } }) },
    refresh: async () => { await onRefresh?.(byId) },
    added,
  }
  if (admit) {
    face.handleSessionAdded = summary => {
      added.push(summary)
      byId[summary.sessionId] = { id: summary.sessionId, blank: true }
    }
  }
  return face
}

test('a blank Thread Session is admitted to the list and then opened', async () => {
  const face = sessions()
  const opened = []
  const openThreadSession = threadSessionOpener({
    sessions: face, open: id => opened.push(id), report: error => assert.fail(error),
  })

  assert.equal(await openThreadSession('session-9'), true)
  assert.deepEqual(opened, ['session-9'])
  assert.equal(face.added.length, 1)
  const summary = face.added[0]
  assert.equal(summary.sessionId, 'session-9')
  assert.equal(summary.agentAvailable, true)
  assert.equal(summary.running, false)
  assert.equal(summary.blank, true)
  assert.equal(typeof summary.updatedAt, 'number')
})

test('a list that catches up after a refresh opens the Session without admitting it', async () => {
  const face = sessions([], { admit: false, onRefresh: async byId => { byId['session-9'] = { id: 'session-9' } } })
  const opened = []
  const openThreadSession = threadSessionOpener({
    sessions: face, open: id => opened.push(id), report: error => assert.fail(error),
  })

  assert.equal(await openThreadSession('session-9'), true)
  assert.deepEqual(opened, ['session-9'])
})

test('a Session that cannot be opened is reported instead of leaving the click silent', async () => {
  // No record is kept and nothing is listed later: the open cannot be honoured.
  const face = sessions([], { admit: false })
  const opened = []
  const reported = []
  const openThreadSession = threadSessionOpener({
    sessions: face, open: id => opened.push(id), report: error => reported.push(error),
  })

  assert.equal(await openThreadSession('session-9'), false)
  assert.deepEqual(opened, [])
  assert.equal(reported.length, 1)
  assert.match(reported[0].message, /Could not open this Thread/)
})

test('a Session already in the list opens without a write or a refresh', async () => {
  const face = sessions(['session-9'])
  let refreshed = 0
  face.refresh = async () => { refreshed += 1 }
  const opened = []
  const openThreadSession = threadSessionOpener({
    sessions: face, open: id => opened.push(id), report: error => assert.fail(error),
  })

  assert.equal(await openThreadSession('session-9'), true)
  assert.deepEqual(opened, ['session-9'])
  assert.equal(face.added.length, 0)
  assert.equal(refreshed, 0)
})
