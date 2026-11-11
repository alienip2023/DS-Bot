// Pure decisions behind the sidebar's Thread list, tested without React.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortThreads, canCreateThread, threadTargetOf } from '../src/client/thread-target.js'

const main = { id: 'b:main', botId: 'b', title: 'Main', isMain: true, createdAt: 50 }
const older = { id: 't-old', botId: 'b', title: 'Older', isMain: false, createdAt: 10 }
const newer = { id: 't-new', botId: 'b', title: 'Newer', isMain: false, createdAt: 90 }

test('sortThreads puts Main first and the rest by creation time', () => {
  assert.deepEqual(sortThreads([newer, main, older]).map(thread => thread.id), ['b:main', 't-old', 't-new'])
})

test('sortThreads keeps the input order for Threads created in the same millisecond', () => {
  const first = { id: 'first', createdAt: 7 }
  const second = { id: 'second', createdAt: 7 }
  assert.deepEqual(sortThreads([first, second]).map(thread => thread.id), ['first', 'second'])
})

test('canCreateThread stops at the host limit, counting archived Threads', () => {
  const threads = Array.from({ length: 9 }, (_, index) => ({ id: `t${index}` }))
  assert.equal(canCreateThread(threads), true)
  assert.equal(canCreateThread([...threads, { id: 'tenth', archived: true }]), false)
})

test('threadTargetOf opens Main and an empty Session on the Bot page', () => {
  assert.deepEqual(threadTargetOf(main, 'b'), { kind: 'bot', id: 'b' })
  assert.deepEqual(threadTargetOf({ id: 't', isMain: false, sessionId: null }, 'b'), { kind: 'bot', id: 'b' })
  assert.deepEqual(threadTargetOf(undefined, 'b'), { kind: 'bot', id: 'b' })
})

test('threadTargetOf opens a Thread with its own Session on that Session', () => {
  assert.deepEqual(threadTargetOf({ id: 't', isMain: false, sessionId: 'session-2' }, 'b'), { kind: 'session', id: 'session-2' })
})
