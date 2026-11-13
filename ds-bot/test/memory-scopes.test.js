import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { MEMORY_BACKENDS, MEMORY_LIMITS, nodeKey, remoteBotKey, safeScopeId, scopeDir, scopeKey } from '../src/host/memory.js'
import { SNAPSHOT_TRUNCATED, fitSnapshot } from '../src/host/memory-entries.js'
import { migrateMemoryFederation } from '../src/host/store.js'
import { fakeContext } from './fake-ctx.js'

const sha256 = text => createHash('sha256').update(text).digest('hex')

test('node and remote Bot scopes have keys of their own, and local keys stay as they were', () => {
  assert.equal(scopeKey({ kind: 'team' }), 'team')
  assert.equal(scopeKey({ kind: 'group', roomId: 'r1' }), 'group:r1')
  assert.equal(scopeKey({ kind: 'bot', botId: 'b2' }), 'bot:b2')
  // A joined key is not a scopeKey: it carries a colon in the middle, and the journal
  // and the panel parse scopeKey, so it must not be mixed in.
  assert.equal(scopeKey({ kind: 'node', nodeId: 'n1' }), undefined)
  assert.equal(scopeKey({ kind: 'bot', nodeId: 'n1', botId: 'b2' }), undefined)
  assert.equal(nodeKey('n1'), 'node:n1')
  assert.equal(remoteBotKey('n1', 'b2'), 'joined:n1:b2')
})

test('a node and its Bots live under memory/nodes, and an id cannot leave that tree', () => {
  const root = join(tmpdir(), 'ds-bot-m4-dirs')
  assert.equal(scopeDir(root, { kind: 'team' }), join(root, 'team'))
  assert.equal(scopeDir(root, { kind: 'group', roomId: 'r1' }), join(root, 'groups', 'r1'))
  assert.equal(scopeDir(root, { kind: 'bot', botId: 'b2' }), join(root, 'bots', 'b2'))
  assert.equal(scopeDir(root, { kind: 'node', nodeId: 'dshtest-1' }), join(root, 'nodes', 'dshtest-1'))
  assert.equal(scopeDir(root, { kind: 'bot', nodeId: 'dshtest-1', botId: 'b-2' }), join(root, 'nodes', 'dshtest-1', 'bots', 'b-2'))

  const nodes = join(root, 'nodes') + sep
  for (const id of ['../../etc', 'a/b', 'a:b', '..', 'n 1', '../\\..', '']) {
    const dir = scopeDir(root, { kind: 'node', nodeId: id })
    assert.ok(dir.startsWith(nodes), id)
    assert.equal(dir.split(sep).includes('..'), false, id)
    assert.equal(scopeDir(root, { kind: 'bot', nodeId: id, botId: id }).split(sep).includes('..'), false, id)
  }
  // Sanitising keeps the readable part, and the hash keeps two ids apart.
  assert.equal(safeScopeId('dshtest-1'), 'dshtest-1')
  assert.notEqual(safeScopeId('a/b'), safeScopeId('a_b'))
  assert.match(safeScopeId('a/b'), /^a_b-[0-9a-f]{8}$/)

  const home = mkdtempSync(join(tmpdir(), 'ds-bot-m4-iso-'))
  try {
    const memory = join(home, 'memory')
    const nodeA = scopeDir(memory, { kind: 'node', nodeId: 'node-a' })
    const nodeB = scopeDir(memory, { kind: 'node', nodeId: 'node-b' })
    assert.notEqual(nodeA, nodeB)
    mkdirSync(nodeA, { recursive: true })
    writeFileSync(join(nodeA, 'MEMORY.md'), '# Memory\n\n- only node A\n')
    assert.match(readFileSync(join(nodeA, 'MEMORY.md'), 'utf8'), /only node A/)
    assert.equal(existsSync(join(nodeB, 'MEMORY.md')), false)
    // One remote Bot belongs to its own node, and a Bot of the same id on another node
    // is another directory.
    const botOnA = scopeDir(memory, { kind: 'bot', nodeId: 'node-a', botId: 'bot-1' })
    assert.ok(botOnA.startsWith(nodeA + sep))
    assert.notEqual(botOnA, scopeDir(memory, { kind: 'bot', nodeId: 'node-b', botId: 'bot-1' }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('memory federation migration fills the shape once and never renumbers a sequence', () => {
  const fresh = {}
  assert.equal(migrateMemoryFederation(fresh), true)
  assert.deepEqual(fresh.memoryFederation, { seq: 0, schemaVersion: 1, nodes: {}, inbox: {} })
  const once = JSON.stringify(fresh)
  assert.equal(migrateMemoryFederation(fresh), false)
  assert.equal(JSON.stringify(fresh), once)

  const live = { memoryFederation: { seq: 41, schemaVersion: 1, nodes: { n1: { lastSeq: 7, sentSeq: 5, hostname: 'dshtest-1' } }, inbox: {} } }
  assert.equal(migrateMemoryFederation(live), false)
  assert.equal(live.memoryFederation.seq, 41)
  assert.deepEqual(live.memoryFederation.nodes.n1, { lastSeq: 7, sentSeq: 5, hostname: 'dshtest-1' })

  const broken = { memoryFederation: { seq: -3, schemaVersion: 2, nodes: { n1: null, n2: { lastSeq: 1.5, sentSeq: -1 } }, inbox: [] } }
  assert.equal(migrateMemoryFederation(broken), true)
  assert.deepEqual(broken.memoryFederation, { seq: 0, schemaVersion: 1, nodes: { n1: { lastSeq: 0, sentSeq: 0 }, n2: { lastSeq: 0, sentSeq: 0 } }, inbox: {} })
  const repaired = JSON.stringify(broken)
  assert.equal(migrateMemoryFederation(broken), false)
  assert.equal(JSON.stringify(broken), repaired)
})

test('an old team gets the federation shape on load, keeps its sequence, and a second load does not rewrite it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-m4-load-'))
  const team = {
    version: 2,
    revision: 3,
    whaleStored: true,
    capabilities: { items: {} },
    mainBotIds: ['m1'],
    bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 } },
    sections: [],
    memoryFederation: { seq: 17, schemaVersion: 1, nodes: { n1: { lastSeq: 9, sentSeq: 9 } }, inbox: {} },
  }
  const older = {
    version: 2,
    revision: 1,
    whaleStored: true,
    capabilities: { items: {} },
    mainBotIds: ['m1'],
    bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 } },
    sections: [],
  }
  const load = async () => {
    const ctx = fakeContext({})
    const rt = createRuntime(ctx, { home, memory: false })
    await rt.load()
    const bytes = readFileSync(join(home, 'state.json'))
    await ctx.dispose()
    return { bytes, state: JSON.parse(bytes.toString('utf8')) }
  }
  try {
    // A team saved before M4: the load writes the default shape to disk by itself.
    writeFileSync(join(home, 'state.json'), JSON.stringify(older))
    const first = await load()
    assert.deepEqual(first.state.memoryFederation, { seq: 0, schemaVersion: 1, nodes: {}, inbox: {} })

    // A sequence already on disk survives the load; it is never renumbered, so a node's
    // old snapshot cannot look newer than it is.
    writeFileSync(join(home, 'state.json'), JSON.stringify(team))
    const seeded = await load()
    assert.equal(seeded.state.memoryFederation.seq, 17)
    assert.deepEqual(seeded.state.memoryFederation.nodes.n1, { lastSeq: 9, sentSeq: 9 })

    // A second load of an already migrated team leaves the file exactly as it was (no
    // write at all), and the memory files beside it are never touched.
    mkdirSync(join(home, 'memory', 'team'), { recursive: true })
    writeFileSync(join(home, 'memory', 'team', 'MEMORY.md'), '# Memory\n\n- the team keeps this\n')
    const before = readFileSync(join(home, 'state.json'))
    const memoryBefore = sha256(readFileSync(join(home, 'memory', 'team', 'MEMORY.md')))
    const again = await load()
    assert.ok(again.bytes.equals(before), 'a migrated team is not written again')
    assert.equal(again.state.memoryFederation.seq, 17)
    assert.equal(sha256(readFileSync(join(home, 'memory', 'team', 'MEMORY.md'))), memoryBefore)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the new limits are set, and a snapshot over budget keeps team, then node, then bot', () => {
  assert.ok(MEMORY_BACKENDS.includes('federation'))
  assert.equal(MEMORY_LIMITS.entry, 300)
  assert.equal(MEMORY_LIMITS.team, 4_000)
  assert.equal(MEMORY_LIMITS.bot, 8_000)
  assert.equal(MEMORY_LIMITS.node, 8_000)
  assert.equal(MEMORY_LIMITS.snapshot, 32_768)

  const sections = [
    { kind: 'bot', id: 'b1', text: 'B'.repeat(100) },
    { kind: 'team', text: 'T'.repeat(100) },
    { kind: 'node', id: 'n1', text: 'N'.repeat(100) },
  ]
  const whole = fitSnapshot(sections, 300)
  assert.deepEqual(whole.sections.map(section => section.kind), ['team', 'node', 'bot'])
  assert.equal(whole.truncated, false)
  assert.equal(whole.size, 300)

  const cut = fitSnapshot([
    { kind: 'bot', id: 'b1', text: 'B'.repeat(60) },
    { kind: 'team', text: 'T'.repeat(60) },
    { kind: 'node', id: 'n1', text: 'N'.repeat(60) },
  ], 100)
  assert.deepEqual(cut.sections.map(section => section.kind), ['team', 'node', 'bot'])
  assert.equal(cut.truncated, true)
  assert.equal(cut.sections[0].truncated, false)
  assert.equal(cut.sections[0].text.length, 60)
  assert.equal(cut.sections[1].truncated, true)
  assert.match(cut.sections[1].text, new RegExp(SNAPSHOT_TRUNCATED.replace(/[[\]]/g, '\\$&')))
  assert.equal(cut.sections[2].text, SNAPSHOT_TRUNCATED)
})
