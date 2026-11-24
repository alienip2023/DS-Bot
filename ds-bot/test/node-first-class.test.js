// 2026-11-25: on a node every Bot is first-class. Opening the team on a node (bootstrap) never makes a Main Bot,
// also when its AC role is not configured as `worker`; a hub without a Main Bot still gets one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { threadWorld } from './thread-t2-world.js'

test('bootstrap on a node joined to a hub makes no Main Bot, whatever role its configuration names', async t => {
  const w = threadWorld({ services: { 'remote-agent:role': 'both', 'remote-agent:bot-network': { nodeId: 'node011' } } })
  t.after(async () => { await w.ctx.dispose?.() })
  await w.rt.load()
  const before = Object.keys(w.rt.state.bots).length
  await w.rt.bootstrap()
  assert.deepEqual(w.rt.state.mainBotIds, [])
  assert.equal(Object.keys(w.rt.state.bots).length, before, 'no whale was made')
})

test('bootstrap on a hub without a Main Bot still makes one', async t => {
  const w = threadWorld({ services: { 'remote-agent:role': 'hub', 'remote-agent:registry': { onlineNodes: () => [], on() {}, off() {} } } })
  t.after(async () => { await w.ctx.dispose?.() })
  await w.rt.load()
  await w.rt.bootstrap()
  assert.equal(w.rt.state.mainBotIds.length, 1)
})
