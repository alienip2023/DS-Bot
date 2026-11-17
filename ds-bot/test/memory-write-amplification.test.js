import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import { install } from '../src/host/memory-federation.js'
import { shadowId } from '../src/host/roster-join.js'
import { fakeContext } from './fake-ctx.js'

const files = root => Object.fromEntries(fs.readdirSync(root, { recursive: true })
  .filter(name => fs.statSync(join(root, name)).isFile())
  .map(name => {
    const stat = fs.statSync(join(root, name))
    return [name, { mtime: stat.mtimeMs, size: stat.size }]
  }))

test('hello, ack and node bookkeeping stay in bounded metadata sidecars', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 2_000_000_000_000 })
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-memory-amplification-'))
  const nodes = Array.from({ length: 8 }, (_, i) => `node-${i}`)
  const handlers = new Map()
  const sent = []
  const registry = {
    on: (name, handler) => handlers.set(name, handler),
    off: name => handlers.delete(name),
    getNode: nodeId => ({ nodeId, hello: { hostname: nodeId, caps: ['memory-sync/1'] } }),
    onlineNodes: () => nodes.map(nodeId => ({ nodeId })),
    send: (nodeId, type, payload) => { sent.push({ nodeId, type, payload }); return true },
  }
  const saves = []
  const contentWrites = []
  const warnings = []
  const bots = Object.fromEntries(nodes.map(nodeId => {
    const id = shadowId(nodeId, 'b1')
    return [id, { id, name: 'Bot', origin: 'joined', worker: { home: 'remote', nodeId, remoteBotId: 'b1' } }]
  }))
  const ctx = fakeContext({ services: { 'remote-agent:registry': registry } })
  const rt = {
    ctx, home, config: {}, state: { bots, memoryFederation: {} },
    load: async () => {},
    save: async (...args) => { saves.push(args) },
    warn: (...args) => warnings.push(args),
    readOnly: () => undefined,
    botOf: id => bots[id],
    memoryHost: {
      readScope: async () => [],
      entryProblem: () => undefined,
      addEntry: async ({ scope, text }) => {
        const path = join(home, 'memory', 'nodes', scope.nodeId, 'bots', scope.botId, 'MEMORY.md')
        const body = `# Memory\n\n- ${text}\n`
        if (fs.readFileSync(path, 'utf8') === body) return { changed: false }
        fs.writeFileSync(path, body)
        contentWrites.push(path)
        return { changed: true }
      },
    },
  }
  t.after(async () => { await ctx.dispose(); fs.rmSync(home, { recursive: true, force: true }) })
  // Seed distinct existing files so an unrelated rewrite is visible too.
  for (const nodeId of nodes) {
    const dir = join(home, 'memory', 'nodes', nodeId, 'bots', 'b1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n')
    fs.utimesSync(join(dir, 'MEMORY.md'), 1, 1)
  }
  const beforeFrames = files(home)
  const writes = []
  const replacements = []
  let writing = false
  for (const name of ['writeFileSync', 'appendFileSync', 'renameSync']) {
    const original = fs[name]
    t.mock.method(fs, name, (...args) => {
      // appendFileSync delegates to writeFileSync; count the append only once.
      if (writing) return original(...args)
      writes.push(String(name === 'renameSync' ? args[1] : args[0]))
      if (name === 'renameSync') replacements.push(String(args[1]))
      writing = true
      try { return original(...args) } finally { writing = false }
    })
  }
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  install(rt)
  await rt.memoryMetaReady

  const start = Date.now()
  for (let i = 0; i < 1000; i++) {
    const nodeId = nodes[i % nodes.length]
    await handlers.get('memoryHello')({ nodeId, appliedSeq: 0 })
    await handlers.get('memoryAck')({ nodeId, seq: 0 })
    t.mock.timers.tick(30)
  }
  for (let i = 0; i < 100; i++) {
    await handlers.get('memoryRead')({ nodeId: nodes[i % nodes.length], remoteBotId: 'b1', requestId: `read-${i}`, scope: 'own' })
  }
  if (saves.length !== 0) t.diagnostic("assert.equal(saves.length, 0, 'hello and ack must not save the team state')")
  assert.equal(saves.length, 0, 'hello and ack must not save the team state')
  assert.equal(sent.filter(frame => frame.type === 'mem/read-result').length, 100)
  assert.equal(writes.length, 0, 'bookkeeping waits for the first fixed window')
  t.mock.timers.tick(29_999)
  assert.equal(writes.length, 0)
  t.mock.timers.tick(1)
  assert.equal(replacements.length, 1, 'later updates must not postpone the first flush')
  const metaDir = join(home, 'memory', '_meta') + sep
  assert.ok(writes.every(path => path.startsWith(metaDir)))
  const afterFrames = files(home)
  for (const [path, stat] of Object.entries(beforeFrames)) assert.deepEqual(afterFrames[path], stat)
  assert.ok(Object.keys(afterFrames).filter(path => !(path in beforeFrames)).every(path => path.startsWith(`memory${sep}_meta${sep}`)))
  assert.ok(fs.statSync(join(metaDir, 'federation.json')).size < 8 * 1024)
  t.mock.timers.tick(60_000)
  assert.equal(replacements.length, 1, 'an idle window must not rewrite clean metadata')

  const beforeChange = files(home)
  const priorWrites = writes.length
  await handlers.get('memoryWrite')({ nodeId: nodes[0], remoteBotId: 'b1', requestId: 'write-1', scope: 'own', op: 'add', text: 'one changed entry' })
  const afterChange = files(home)
  const changedMarkdown = Object.keys(afterChange).filter(path => path.endsWith('.md') && JSON.stringify(beforeChange[path]) !== JSON.stringify(afterChange[path]))
  assert.deepEqual(changedMarkdown, [join('memory', 'nodes', nodes[0], 'bots', 'b1', 'MEMORY.md')])
  assert.equal(contentWrites.length, 1)
  assert.ok(writes.slice(priorWrites).every(path => path.startsWith(metaDir) || path === contentWrites[0]))
  assert.equal(rt.memoryHub.seq(), 1)
  assert.deepEqual(sent.filter(frame => frame.type === 'mem/write-result').at(-1).payload, { requestId: 'write-1', ok: true, seq: 1, changed: true })
  assert.equal(saves.length, 0, 'a content change must not save the team state')
  const windows = Math.floor((Date.now() - start) / 60_000)
  const snapshots = replacements.filter(path => path.endsWith('federation.json')).length
  assert.equal(snapshots, 2)
  // A temp write followed by rename is one file write; inbox appends count too.
  const sidecarWrites = writes.filter(path => path.startsWith(metaDir)).length - replacements.length
  assert.equal(sidecarWrites, 3)
  assert.ok(sidecarWrites <= windows + contentWrites.length, 'sidecar writes are bounded by windows plus content changes')
  assert.equal(JSON.parse(fs.readFileSync(join(metaDir, 'federation.json'), 'utf8')).seq, 1)
  const afterWrite = files(home)
  await handlers.get('memoryWrite')({ nodeId: nodes[0], remoteBotId: 'b1', requestId: 'write-1', scope: 'own', op: 'add', text: 'one changed entry' })
  assert.deepEqual(files(home), afterWrite, 'replaying an accepted write must not touch any file')
  await handlers.get('memoryWrite')({ nodeId: nodes[0], remoteBotId: 'b1', requestId: 'write-noop', scope: 'own', op: 'add', text: 'one changed entry' })
  assert.equal(rt.memoryHub.seq(), 1, 'an unchanged entry must not advance the sequence')
  assert.equal(contentWrites.length, 1)
  assert.equal(replacements.filter(path => path.endsWith('federation.json')).length, 2)
  assert.equal(saves.length, 0)
  assert.equal(warnings.length, 0)
  t.diagnostic(`1000 hello + 1000 ack + 100 reads: ${windows} windows, ${sidecarWrites} sidecar writes (${snapshots} snapshots and one inbox append), one content change`)
})
