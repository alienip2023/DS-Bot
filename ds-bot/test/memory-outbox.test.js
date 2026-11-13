import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeHub, fakeLink, startNode } from './memory-node-ctx.js'

const writes = link => link.sent.filter(frame => frame.type === 'mem/write')

test('offline writes wait in the outbox and go out in order once the link is back', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: false, hub })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  assert.match(await tool('remember', { text: 'first fact' }), /This node is offline, so the change waits in its outbox/)
  assert.match(await tool('remember', { text: 'second fact' }), /waits in its outbox/)
  assert.match(await tool('remember', { text: 'third fact' }), /waits in its outbox/)
  const queued = rt.memoryNode.outbox()
  assert.equal(queued.length, 3)
  assert.deepEqual(queued.map(item => item.text), ['first fact', 'second fact', 'third fact'])
  assert.equal(writes(link).length, 0)
  assert.equal(hub.received.length, 0)

  link.goUp()
  assert.equal(await rt.memoryNode.flush(), 3)
  assert.equal(rt.memoryNode.outbox().length, 0)
  const frames = writes(link)
  assert.deepEqual(frames.map(frame => frame.payload.text), ['first fact', 'second fact', 'third fact'])
  assert.equal(new Set(frames.map(frame => frame.payload.requestId)).size, 3)
  // The hub applied each change once, and the outbox used the same requestIds it queued.
  assert.equal(hub.applied.length, 3)
  assert.deepEqual(hub.applied.map(item => item.requestId).sort(), queued.map(item => item.requestId).sort())
})

test('a lost reply keeps the change queued and the retry reuses its requestId', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: true, hub })
  const { rt, tool, stop } = startNode({ link, config: { memoryReplyMs: 40 } })
  t.after(() => stop())
  await rt.load()

  hub.silent = true
  assert.match(await tool('remember', { text: 'written once' }), /waits in its outbox/)
  const queued = rt.memoryNode.outbox()
  assert.equal(queued.length, 1)
  const requestId = queued[0].requestId
  assert.equal(writes(link)[0].payload.requestId, requestId)

  // The hub did write it, but its answer never arrived. The retry carries the same
  // requestId, so the hub replays the old answer instead of writing a second entry.
  hub.silent = false
  assert.equal(await rt.memoryNode.flush(), 1)
  assert.equal(rt.memoryNode.outbox().length, 0)
  assert.equal(hub.applied.length, 1)
  assert.equal(hub.applied[0].requestId, requestId)
  assert.deepEqual(writes(link).map(frame => frame.payload.requestId), [requestId, requestId])
})

test('a full outbox refuses the change and keeps what is already queued', async (t) => {
  const link = fakeLink({ online: false })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  rt.state.memoryOutbox = Array.from({ length: 500 }, (_, index) => ({
    requestId: `queued-${index}`,
    remoteBotId: 'b1',
    op: 'add',
    scope: 'own',
    text: `queued ${index}`,
    at: Date.now(),
  }))
  await assert.rejects(tool('remember', { text: 'one too many' }), error => {
    assert.equal(error.code, 'memory/outbox-full')
    assert.match(error.message, /500 memory changes waiting/)
    return true
  })
  assert.equal(rt.memoryNode.outbox().length, 500)
  assert.equal(writes(link).length, 0)
})

test('a team write is refused before a frame or an outbox entry exists', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: true, hub })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  await assert.rejects(tool('remember', { text: 'team fact', scope: 'team' }), error => {
    assert.equal(error.code, 'memory/team-read-only')
    assert.match(error.message, /written on the hub by a Main Bot or a group admin/)
    return true
  })
  assert.equal(rt.memoryNode.outbox().length, 0)
  assert.equal(writes(link).length, 0)
  assert.equal(hub.received.filter(frame => frame.type === 'mem/write').length, 0)

  // The same refusal happens with the node offline: nothing may be queued for the team.
  link.goDown()
  await assert.rejects(tool('forget', { entry: 'anything', scope: 'team' }), error => error.code === 'memory/team-read-only')
  assert.equal(rt.memoryNode.outbox().length, 0)
})

test('a hub without memory-sync/1 fails closed instead of queueing', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: true, hub, caps: [] })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  await assert.rejects(tool('remember', { text: 'nowhere to go' }), error => {
    assert.equal(error.code, 'memory/federation-unsupported')
    assert.match(error.message, /does not support federated memory \(memory-sync\/1\)/)
    return true
  })
  assert.equal(rt.memoryNode.outbox().length, 0)
  assert.equal(writes(link).length, 0)
})

test('a non-terminal refusal keeps the entry and a terminal one lets it go', async (t) => {
  const link = fakeLink({ online: false })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()
  await tool('remember', { text: '- retry me' })
  assert.equal(rt.memoryNode.outbox().length, 1)

  // The hub answered, but could not write: the request stays and keeps its id, so the
  // next attempt replays the same inbox answer instead of writing twice.
  link.hub.fail = 'memory/failed'
  link.goUp()
  assert.equal(await rt.memoryNode.flush(), 0)
  assert.equal(rt.memoryNode.outbox().length, 1)

  // A terminal code means the hub will never take it: drop it rather than retry forever.
  link.hub.fail = 'memory/too-large'
  assert.equal(await rt.memoryNode.flush(), 1)
  assert.equal(rt.memoryNode.outbox().length, 0)

  // A good answer still dequeues: the terminal code only governs the stuck item.
  link.goDown()
  link.hub.fail = undefined
  await tool('remember', { text: '- accepted now' })
  assert.equal(rt.memoryNode.outbox().length, 1)
  link.goUp()
  assert.equal(await rt.memoryNode.flush(), 1)
  assert.equal(rt.memoryNode.outbox().length, 0)
})
