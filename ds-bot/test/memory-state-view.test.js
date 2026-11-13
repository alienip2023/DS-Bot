// The state endpoint carries the three-layer view: a plain machine answers with the
// closed default, and a node passes its own view through unchanged.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function start({ services = {}, config = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-m4state-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['m1'],
    bots: { m1: { id: 'm1', name: 'Main', role: '' }, m2: { id: 'm2', name: 'Second', role: '' } },
    rooms: { r1: { id: 'r1', name: 'Room A', members: ['m1', 'm2'], admin: null, mode: 'everyone' } },
  }))
  const ctx = fakeContext({ services })
  const register = ctx.connection.fetch.register
  let route
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, ...config })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, call, stop }
}

test('a machine with memory off answers with the closed federation default', async t => {
  const app = start({ config: { memory: false } })
  t.after(() => app.stop())
  const answer = await app.call('state')
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.memoryFederation, { nodeId: null, canFederate: false, hub: false })
})

test('a node passes its own federation view through', async t => {
  const app = start({ services: { 'remote-agent:node-policy': { nodeId: 'n1', roots: [] } } })
  t.after(() => app.stop())
  await app.rt.load()
  const answer = await app.call('state')
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.memoryFederation, { nodeId: 'n1', canFederate: true, hub: false })
})

test('update-room ignores a memory backend instead of silently half-applying it', async t => {
  const app = start()
  t.after(() => app.stop())
  let seen
  const original = app.rt.updateRoom
  app.rt.updateRoom = (id, patch, actor) => { seen = patch; return original(id, patch, actor) }
  const updated = await app.call('update-room', { id: 'r1', name: 'Room B', memoryConfig: { backend: 'federation' } })
  assert.equal(updated.ok, true, 'a room patch with a memory backend must not fail')
  assert.equal(updated.value.room.name, 'Room B')
  assert.equal(updated.value.room.memoryConfig, undefined)
  assert.equal(app.rt.roomOf('r1').memoryConfig, undefined)
  assert.equal(Object.hasOwn(seen, 'memoryConfig'), false, 'the room patch must not carry a memory backend')
})
