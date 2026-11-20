import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bodySize, fitSnapshot, SNAPSHOT_TRUNCATED } from '../src/host/memory-entries.js'
import { install as installFederation } from '../src/host/memory-federation.js'
import { install as installMemory, scopeDir } from '../src/host/memory.js'
import { shadowId } from '../src/host/roster-join.js'
import { fakeContext } from './fake-ctx.js'

export function externalFakes(t) {
  const trap = t.mock.fn(() => { throw new Error('Unexpected external call in an offline fixture') })
  t.after(() => assert.equal(trap.mock.callCount(), 0, 'zero external calls'))
  return { llm: trap, model: trap, embed: trap, assembleLlm: trap }
}

export async function memoryWorld(t, { privateIds = [] } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) })
  const home = mkdtempSync(join(tmpdir(), 'ds-w22-memory-'))
  const listeners = new Map()
  const sent = []
  const registry = {
    on: (name, fn) => listeners.set(name, fn),
    off: name => listeners.delete(name),
    getNode: nodeId => ({ nodeId, caps: ['memory-sync/1'] }),
    // Test explicit frames without an unsolicited startup push.
    onlineNodes: () => [],
    send: (nodeId, type, payload) => { sent.push({ nodeId, type, payload }); return true },
  }
  const ctx = fakeContext({ services: { 'remote-agent:registry': registry } })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const bots = {}
  for (const remoteBotId of ['public-bot', ...privateIds]) {
    const id = shadowId('node-a', remoteBotId)
    bots[id] = { id, name: remoteBotId, origin: 'joined', worker: { home: 'remote', nodeId: 'node-a', remoteBotId } }
  }
  const rooms = { 'room-only': { id: 'room-only', name: 'Fixture room', members: [shadowId('node-a', 'public-bot')] } }
  const warnings = []
  const rt = {
    ctx, home, state: { bots, rooms, prefs: {} }, teamTools: [],
    config: { memoryReview: false, memoryTidy: false, timeZone: 'UTC' },
    load: async () => {}, readOnly: () => undefined,
    botOf: id => bots[id], roomOf: id => rooms[id], isMain: () => false,
    isPrivate: id => privateIds.includes(bots[id]?.worker.remoteBotId),
    warn: (...args) => warnings.push(args),
    ...externalFakes(t),
  }
  installMemory(rt)
  installFederation(rt)
  await rt.memoryMetaReady
  return {
    rt, home, registry, warnings, sent,
    frame: async (name, extra) => {
      const start = sent.length
      await listeners.get(name)({ nodeId: 'node-a', remoteBotId: 'public-bot', ...extra })
      assert.equal(sent.length, start + 1, 'one reply per incoming frame')
      return sent.at(-1).payload
    },
  }
}

if (import.meta.main) registerMemoryNodeTests()

export function registerMemoryNodeTests() {
  test('node-cap-enforced', async t => {
    const { rt, frame } = await memoryWorld(t)
    const scope = { kind: 'node', nodeId: 'node-a' }
    const note = i => `Fixture fact ${i}: `.padEnd(300, 'z')
    const write = (i, text) => frame('memoryWrite', { requestId: `cap-${i}`, scope: 'node', op: 'add', text })
    assert.equal((await write('long', `${note(0)}z`)).error, 'memory/too-large')
    assert.equal(rt.memoryHub.seq(), 0)
    for (let i = 0; i < 26; i++) assert.equal((await write(i, note(i))).ok, true)
    assert.equal((await write('edge', 'Boundary fact'.padEnd(200, 'z'))).ok, true)
    assert.equal(bodySize((await rt.memoryHost.readScope(scope))[0]), 8_000)
    const latest = 'The latest node fact.'
    assert.equal((await write('overflow', latest)).ok, true)
    const [main, ...topics] = await rt.memoryHost.readScope(scope)
    assert.ok(bodySize(main) <= 8_000, 'node scope cap must hold')
    assert.ok(main.entries.some(entry => entry.text === latest))
    assert.ok(topics.some(topic => topic.entries.some(entry => entry.text === note(0))))
  })

  test('snapshot-order', () => {
    const bot = { kind: 'bot', text: 'bot fact' }
    const node = { kind: 'node', text: 'first node fact\nsecond node fact' }
    const team = { kind: 'team', text: 'team fact' }
    const full = fitSnapshot([bot, node, team])
    assert.deepEqual(full.sections.map(section => section.kind), ['team', 'node', 'bot'], 'team must be kept before node before bot')
    const cut = fitSnapshot([bot, node, team], team.text.length + 'first node fact\n'.length)
    assert.equal(cut.truncated, true)
    assert.deepEqual(cut.sections, [
      { ...team, truncated: false },
      { kind: 'node', text: `first node fact\n\n${SNAPSHOT_TRUNCATED}`, truncated: true },
      { kind: 'bot', text: SNAPSHOT_TRUNCATED, truncated: true },
    ])
  })

  test('node-write-and-retry-stay-in-the-own-directory', async t => {
    const { rt, home, frame } = await memoryWorld(t)
    const write = { requestId: 'retry-a', scope: 'node', op: 'add', text: 'A fact for node A' }
    const first = await frame('memoryWrite', write)
    assert.deepEqual(first, { requestId: 'retry-a', ok: true, seq: 1, changed: true })
    assert.deepEqual(await frame('memoryWrite', write), first)
    assert.equal(rt.memoryHub.seq(), 1)
    const root = join(home, 'memory')
    const own = scopeDir(root, { kind: 'node', nodeId: 'node-a' })
    assert.equal(own, join(root, 'nodes', 'node-a'))
    assert.equal(readFileSync(join(own, 'MEMORY.md'), 'utf8').split(write.text).length - 1, 1)
    assert.equal(readFileSync(join(own, 'journal.jsonl'), 'utf8').trim().split('\n').length, 1)
    for (const scope of [{ kind: 'node', nodeId: 'node-b' }, { kind: 'team' }, { kind: 'bot', nodeId: 'node-a', botId: 'public-bot' }]) {
      assert.equal(existsSync(join(scopeDir(root, scope), 'MEMORY.md')), false)
    }
  })
}
