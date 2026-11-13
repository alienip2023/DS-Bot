import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeHub, fakeLink, startNode } from './memory-node-ctx.js'

const frames = (link, type) => link.sent.filter(frame => frame.type === type)

test('an online remember sends one mem/write with a requestId and waits for the hub', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: true, hub })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  assert.match(await tool('remember', { text: 'User prefers short replies' }), /^Saved\. The hub has it; recall finds it now\.$/)
  const sent = frames(link, 'mem/write')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.op, 'add')
  assert.equal(sent[0].payload.scope, 'own')
  assert.equal(sent[0].payload.remoteBotId, 'b1')
  assert.equal(sent[0].payload.text, 'User prefers short replies')
  assert.match(sent[0].payload.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(hub.applied.length, 1)
  assert.equal(rt.memoryNode.outbox().length, 0)
})

test('replace and forget map to the hub operations and keep their match text', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: true, hub })
  const { tool, stop } = startNode({ link })
  t.after(() => stop())
  await tool('remember', { text: 'User drinks coffee' })

  assert.match(await tool('remember', { text: 'User drinks tea', replace: 'coffee' }), /^Saved\./)
  const replace = frames(link, 'mem/write').at(-1).payload
  assert.equal(replace.op, 'replace')
  assert.equal(replace.replace, 'coffee')
  assert.equal(replace.text, 'User drinks tea')

  assert.match(await tool('forget', { entry: 'tea' }), /^Removed\./)
  const forget = frames(link, 'mem/write').at(-1).payload
  assert.equal(forget.op, 'forget')
  assert.equal(forget.replace, 'tea')
  assert.equal(hub.entries.get('own:b1').length, 0)
})

test('a node scope is named in the frame, and recall reads it back', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: true, hub })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  await tool('remember', { text: 'The node runs Node 24', scope: 'node' })
  assert.equal(frames(link, 'mem/write').at(-1).payload.scope, 'node')
  const answer = await tool('recall', { scope: 'node' })
  assert.match(answer, /This node's memory: 1 entries\./)
  assert.match(answer, /\[node\] The node runs Node 24/)
  assert.equal(frames(link, 'mem/read').at(-1).payload.scope, 'node')
})

test('recall sends the query and formats what the hub returns', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: true, hub })
  const { tool, stop } = startNode({ link })
  t.after(() => stop())
  await tool('remember', { text: 'User prefers pnpm' })
  await tool('remember', { text: 'User lives in Hangzhou' })
  await tool('remember', { text: 'Ship on Friday' }, 'b2')

  const answer = await tool('recall', { query: 'pnpm' })
  assert.match(answer, /Entries with "pnpm" in your memory:/)
  assert.match(answer, /\[yours\] User prefers pnpm/)
  assert.doesNotMatch(answer, /Hangzhou/)
  const read = frames(link, 'mem/read').at(-1).payload
  assert.equal(read.query, 'pnpm')
})

test('recall with no scope reads your memory and the team memory', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: true, hub })
  const { rt, tool, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  const answer = await tool('recall', {})
  assert.match(answer, /Your memory: nothing saved yet\./)
  assert.match(answer, /The team memory: nothing saved yet\./)
  assert.deepEqual(frames(link, 'mem/read').map(frame => frame.payload.scope), ['own', 'team'])
})

test('a node that is offline cannot answer a recall, and says so', async (t) => {
  const link = fakeLink({ online: false })
  const { tool, stop } = startNode({ link })
  t.after(() => stop())

  const answer = await tool('recall', { query: 'anything' })
  assert.match(answer, /This node is not connected to its hub, so federated memory cannot be reached now\./)
  assert.equal(frames(link, 'mem/read').length, 0)
})

test('a topic is saved and read through the frame', async (t) => {
  const hub = fakeHub()
  const link = fakeLink({ online: true, hub })
  const { tool, stop } = startNode({ link })
  t.after(() => stop())
  await tool('remember', { text: 'Booking number 42', topic: 'travel' })
  assert.equal(frames(link, 'mem/write').at(-1).payload.topic, 'travel')

  const answer = await tool('recall', { topic: 'travel' })
  assert.match(answer, /Topic \[\[travel\]\] in your memory:/)
  assert.match(answer, /Booking number 42/)
})
