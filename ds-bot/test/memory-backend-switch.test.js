// §61 A: once the backend on the Bot row changes, the next turn renders and routes from
// the new value — federated section gone, then back — without restarting the plugin.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeLink, snapshot, startNode } from './memory-node-ctx.js'

test('switching a managed Bot between federation and file changes the next section', async (t) => {
  const { rt, section, stop } = startNode({ link: fakeLink() })
  t.after(() => stop())
  await rt.load()

  await rt.memoryNode.apply(snapshot(7, {
    team: '- team prefers pnpm',
    node: '- node runs Node 24',
    bots: { b1: { text: '- one writes short replies' } },
  }))
  assert.match(section('b1'), /## Team memory, shared by every Bot\n- team prefers pnpm/)

  await rt.updateBot('b1', { memoryConfig: { backend: 'file' } })
  assert.equal(rt.state.bots.b1.memoryConfig.backend, 'file')
  const fileText = section('b1')
  // The file backend renders its own team section from team/MEMORY.md; what must be
  // gone is the hub's federated text and the node segment.
  assert.doesNotMatch(fileText, /- team prefers pnpm/)
  assert.doesNotMatch(fileText, /## Your node's memory/)
  assert.doesNotMatch(fileText, /- one writes short replies/)

  await rt.updateBot('b1', { memoryConfig: { backend: 'federation' } })
  assert.equal(rt.state.bots.b1.memoryConfig.backend, 'federation')
  const federated = section('b1')
  assert.match(federated, /## Team memory, shared by every Bot\n- team prefers pnpm/)
  assert.match(federated, /- one writes short replies/)
})
