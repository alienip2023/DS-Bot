import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { install } from '../src/host/memory-federation.js'
import { createMemoryMeta } from '../src/host/memory-meta.js'
import { fakeContext } from './fake-ctx.js'

const DAY = 24 * 60 * 60 * 1000
const lines = path => fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

function setup(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-memory-meta-'))
  const warnings = []
  const meta = createMemoryMeta({ home, warn: (...args) => warnings.push(args) })
  t.after(() => { meta.close(); fs.rmSync(home, { recursive: true, force: true }) })
  return { home, meta, warnings, path: name => join(home, 'memory', '_meta', name) }
}

test('legacy import persists once, clears state once, and repeated imports leave identical bytes', async t => {
  const { home, path } = setup(t)
  const legacy = {
    seq: 7,
    nodes: { n1: { lastSeq: 5, sentSeq: 7, hostname: 'worker', lastSeen: Date.now() } },
    inbox: { 'n1:request': { at: Date.now(), frame: { requestId: 'request', ok: true, seq: 7, changed: true } } },
  }
  async function start(state) {
    const saves = []
    const ctx = fakeContext()
    const rt = { ctx, home, config: {}, state, memoryHost: {}, warn() {}, load: async () => {}, save: async options => saves.push(options) }
    install(rt)
    await rt.memoryMetaReady
    t.after(() => ctx.dispose())
    return { rt, saves, stop: () => ctx.dispose() }
  }
  const state = { memoryFederation: structuredClone(legacy) }
  const first = await start(state)
  assert.deepEqual(state.memoryFederation, {})
  assert.deepEqual(first.saves, [{ immediate: false }])
  assert.deepEqual(JSON.parse(fs.readFileSync(path('federation.json'), 'utf8')), { schemaVersion: 2, seq: 7, nodes: legacy.nodes })
  assert.deepEqual(lines(path('inbox.jsonl')), [{ key: 'n1:request', at: legacy.inbox['n1:request'].at, result: legacy.inbox['n1:request'].frame }])
  assert.deepEqual(first.rt.memoryMeta.lookup('n1:request'), legacy.inbox['n1:request'])
  const before = ['federation.json', 'inbox.jsonl'].map(name => fs.readFileSync(path(name)))
  await first.stop()
  const second = await start(state)
  assert.equal(second.saves.length, 0)
  await second.stop()
  // Simulate a crash after writing sidecars but before the old state was cleared.
  const third = await start({ memoryFederation: structuredClone(legacy) })
  assert.deepEqual(third.saves, [{ immediate: false }])
  for (const [i, name] of ['federation.json', 'inbox.jsonl'].entries()) assert.deepEqual(fs.readFileSync(path(name)), before[i])
})

test('deferred flushes share a fixed window and content changes cancel its timer', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2_000_000_000_000 })
  const { meta, path } = setup(t)
  await meta.load()
  const rename = fs.renameSync
  const writes = []
  t.mock.method(fs, 'renameSync', (...args) => { writes.push(args[1]); return rename(...args) })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  meta.nodeRecord('n1').lastSeq = 2
  meta.flush({ immediate: false })
  t.mock.timers.tick(30_000)
  meta.nodeRecord('n1').sentSeq = 3
  meta.flush({ immediate: false })
  t.mock.timers.tick(29_999)
  assert.equal(writes.length, 0)
  t.mock.timers.tick(1)
  assert.equal(writes.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(path('federation.json'))).nodes.n1.sentSeq, 3)

  meta.bumpSeq()
  meta.flush({ immediate: false })
  meta.noteChanged()
  assert.equal(writes.length, 2)
  // A new mutation must get a full window, rather than inherit a pending timer.
  t.mock.timers.tick(30_000)
  meta.nodeRecord('n1').lastSeq = 3
  t.mock.timers.tick(30_000)
  assert.equal(writes.length, 2)
  t.mock.timers.tick(30_000)
  assert.equal(writes.length, 3)
  meta.bumpSeq()
  meta.close()
  t.mock.timers.tick(60_000)
  assert.equal(writes.length, 3)
})

test('inbox compaction keeps the newest thousand and drops expired entries on insert and recovery', async t => {
  const { home, meta, path } = setup(t)
  await meta.load()
  const at = Date.now()
  meta.remember('expired', { at: at - 8 * DAY, frame: { ok: true, seq: 0 } })
  for (let i = 0; i < 1200; i++) meta.remember(`request-${i}`, { at: at - 1200 + i, frame: { ok: true, seq: i } })
  let rows = lines(path('inbox.jsonl'))
  assert.equal(rows.length, 1000)
  assert.equal(rows[0].key, 'request-1199')
  assert.equal(rows.at(-1).key, 'request-200')
  assert.equal(meta.lookup('expired'), undefined)
  assert.equal(meta.lookup('request-199'), undefined)
  assert.equal(meta.lookup('request-200').frame.seq, 200)
  fs.appendFileSync(path('inbox.jsonl'), JSON.stringify({ key: 'expired-on-recovery', at: at - 8 * DAY, result: { ok: true } }) + '\n')
  const recovered = createMemoryMeta({ home })
  t.after(() => recovered.close())
  const loaded = await recovered.load()
  assert.equal(Object.keys(loaded.inbox).length, 1000)
  assert.equal(recovered.lookup('expired-on-recovery'), undefined)
  rows = lines(path('inbox.jsonl'))
  assert.equal(rows.length, 1000)
  assert.equal(rows.some(row => row.key === 'expired-on-recovery'), false)
  recovered.appendJournal({ seq: 1, op: 'add' })
  recovered.appendJournal({ seq: 2, op: 'forget' })
  assert.deepEqual(lines(path('journal.jsonl')), [{ seq: 1, op: 'add' }, { seq: 2, op: 'forget' }])
})

test('equal-time inserts retain the latest answers and a capped legacy import is idempotent', async t => {
  const { home, meta, path } = setup(t)
  await meta.load()
  const at = Date.now()
  const inbox = {}
  for (let i = 0; i < 1200; i++) {
    const entry = { at, frame: { ok: true, seq: i } }
    inbox[`request-${i}`] = entry
    meta.remember(`request-${i}`, entry)
  }
  assert.equal(meta.lookup('request-199'), undefined)
  assert.equal(meta.lookup('request-200').frame.seq, 200)
  const legacy = { seq: 7, nodes: { n1: { lastSeq: 5, sentSeq: 7 } }, inbox }
  meta.importLegacy(legacy)
  const before = ['federation.json', 'inbox.jsonl'].map(name => fs.readFileSync(path(name)))
  const recovered = createMemoryMeta({ home })
  t.after(() => recovered.close())
  await recovered.load()
  recovered.importLegacy(legacy)
  for (const [i, name] of ['federation.json', 'inbox.jsonl'].entries()) assert.deepEqual(fs.readFileSync(path(name)), before[i])
  recovered.bumpSeq()
  recovered.nodeRecord('n1').lastSeq = 8
  recovered.noteChanged()
  recovered.importLegacy(legacy)
  assert.equal(recovered.seq(), 8)
  assert.equal(recovered.nodeRecord('n1').lastSeq, 8)
})
