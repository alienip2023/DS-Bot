// P10: the hub's own machine has no node identity, so a Bot here cannot use the
// federated backend. The roster refuses it, and the tools refuse it again if a Bot
// row still names it (an older row, or a bypass of the roster).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { TEAM, startNode } from './memory-node-ctx.js'

function start({ state = TEAM } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-m4guard-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  const tool = (name, args, sessionId = 'b1') => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, home, tool, stop }
}

const withoutMemory = () => {
  const state = structuredClone(TEAM)
  for (const bot of Object.values(state.bots)) delete bot.memoryConfig
  return state
}

test('the roster refuses the federated backend on a machine without a node identity', async (t) => {
  const { rt, stop } = start({ state: withoutMemory() })
  t.after(() => stop())
  await rt.load()

  await assert.rejects(
    () => rt.updateBot('b2', { memoryConfig: { backend: 'federation' } }),
    error => error?.code === 'memory/federation-requires-node',
  )
  // Refused before anything was written: the row still has no backend.
  assert.equal(rt.state.bots.b2.memoryConfig, undefined)
})

test('the tools refuse a federated Bot row on the hub itself and queue nothing', async (t) => {
  const { rt, tool, stop } = start()
  t.after(() => stop())
  await rt.load()
  assert.equal(rt.memoryNode.nodeId(), undefined)

  await assert.rejects(
    () => tool('remember', { text: '- this must not be queued' }),
    error => error?.code === 'memory/federation-unsupported' && /no node identity/.test(error.message),
  )
  assert.equal(rt.memoryNode.outbox().length, 0)
})

test('only a node offers the federated backend, and the preference switches it off', async (t) => {
  const node = startNode({ nodeId: 'n1' })
  t.after(() => node.stop())
  await node.rt.load()
  assert.deepEqual(node.rt.memoryFederationView(), { nodeId: 'n1', canFederate: true, hub: false })

  const hub = start()
  t.after(() => hub.stop())
  await hub.rt.load()
  // A hub lists machines once the remote-agent registry is there; without it, false.
  assert.deepEqual(hub.rt.memoryFederationView(), { nodeId: null, canFederate: false, hub: false })
})
