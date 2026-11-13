// A joined Bot has no "new thread" in the client, so its one Session is the only place a
// newer hub snapshot can be read. The federated section therefore freezes per applied
// snapshot, not for the life of the Session. File memory keeps its own freeze.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeLink, snapshot, startNode } from './memory-node-ctx.js'

test('the same Session re-renders when a newer snapshot is applied', async (t) => {
  const { rt, section, stop } = startNode({ link: fakeLink() })
  t.after(() => stop())
  await rt.load()
  const bot = rt.state.bots.b1

  await rt.memoryNode.apply(snapshot(1, { node: '- node keeps tea', team: '- team prefers pnpm' }))
  const first = section('b1')
  assert.match(first, /## Your node's memory \(node:n1\)\n- node keeps tea/)
  const at = rt.memoryNode.cached(bot).at
  assert.ok(at > 0)

  await rt.memoryNode.apply(snapshot(2, { node: '- node keeps coffee', team: '- team prefers pnpm' }))
  assert.ok(rt.memoryNode.cached(bot).at > at, 'applying a snapshot must move cached.at')
  const second = section('b1')
  assert.match(second, /- node keeps coffee/)
  assert.doesNotMatch(second, /- node keeps tea/)
  assert.notEqual(second, first)
})

test('two renders with no new snapshot return the same string', async (t) => {
  const { rt, section, stop } = startNode({ link: fakeLink() })
  t.after(() => stop())
  await rt.load()

  await rt.memoryNode.apply(snapshot(3, { node: '- steady' }))
  const first = section('b1')
  assert.equal(section('b1'), first)
  assert.equal(section('b1'), first)
})

test('a change of role re-renders even though the snapshot did not move', async (t) => {
  const { rt, section, stop } = startNode({ link: fakeLink() })
  t.after(() => stop())
  await rt.load()

  await rt.memoryNode.apply(snapshot(4, { node: '- held' }))
  const before = section('b1')
  assert.match(before, /tell a Main Bot with message_bot/)
  assert.equal(section('b1'), before)

  await rt.setMain('b1', true)
  const promoted = section('b1')
  assert.match(promoted, /As a Main Bot you write it with remember scope "team"/)
  assert.doesNotMatch(promoted, /tell a Main Bot with message_bot/)
  assert.match(promoted, /- held/)
  assert.equal(section('b1'), promoted)

  await rt.setMain('b1', false)
  const demoted = section('b1')
  assert.match(demoted, /tell a Main Bot with message_bot/)
  assert.doesNotMatch(demoted, /As a Main Bot you write it/)
})

test('turning federation off shows the off text in the same Session, and on again shows the snapshot', async (t) => {
  const { rt, section, stop } = startNode({ link: fakeLink() })
  t.after(() => stop())
  await rt.load()

  await rt.memoryNode.apply(snapshot(5, { node: '- node keeps tea' }))
  const shown = section('b1')
  assert.match(shown, /- node keeps tea/)

  rt.state.prefs = { ...(rt.state.prefs ?? {}), memoryFederation: false }
  const off = section('b1')
  assert.match(off, /Federated memory is turned off on this node/)
  assert.doesNotMatch(off, /- node keeps tea/)

  rt.state.prefs.memoryFederation = true
  const back = section('b1')
  assert.match(back, /- node keeps tea/)
  assert.doesNotMatch(back, /turned off on this node/)
})
