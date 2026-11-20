// DS-1: inflight.json is written through a temp file and renamed, carries a version, and a
// corrupt file is kept aside instead of being read. Synthetic files, mocked sinks only.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import './harness-resolve.mjs'
import { fakeContext } from './fake-ctx.js'

const { install } = await import('../src/host/resume.js')

const legacy = { turns: { s1: { botId: 'a', since: 1 } }, queued: { 'chat-a': [{ at: 5, args: { toId: 'a', exchangeId: 'e1', text: 'hi' } }] } }
const dirOf = t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-inflight-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  return home
}

function start(home, over = {}) {
  const ctx = fakeContext()
  const delivered = []
  const failures = []
  const warnings = []
  const rt = {
    ctx, home,
    load: async () => {},
    readOnly: () => undefined,
    botOf: () => undefined, chatOf: () => undefined, isBotSession: () => false, selfOf: () => undefined,
    resolveAgent: async () => ({ inbox: { nextStep: [], nextTurn: [] } }),
    deliver: async args => { delivered.push(args) },
    warn: (...a) => { warnings.push(a) },
    noteFailure: f => { failures.push(f) },
    ...over,
  }
  install(rt)
  return { rt, ctx, delivered, failures, warnings }
}

// The 03fd913c readNotes, verbatim (see the fixture header).
const { readNotes: oldReadNotes } = await import('./fixtures/old-read-notes.js')

test('legacy file without version loads as is (3)', async t => {
  const home = dirOf(t)
  writeFileSync(join(home, 'inflight.json'), JSON.stringify(legacy))
  const h = start(home)
  assert.deepEqual(h.rt.readOnly(), undefined)
  assert.deepEqual(oldReadNotes(join(home, 'inflight.json')), legacy)
  assert.equal(h.failures.length, 0)
  assert.deepEqual(readdirSync(home), ['inflight.json'])
  await h.ctx.dispose()
})

test('a written file has a version and the old reader reads it identically (4)', async t => {
  const home = dirOf(t)
  const file = join(home, 'inflight.json')
  writeFileSync(file, JSON.stringify(legacy))
  const h = start(home)
  const before = oldReadNotes(file)
  h.rt.deliver({ toId: 'a', sessionId: 'chat-a', text: 'x', exchangeId: 'e2' })
  await h.ctx.dispose()
  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(typeof written.version, 'number')
  assert.deepEqual(Object.keys(written).sort(), ['queued', 'turns', 'version'])
  const after = oldReadNotes(file)
  assert.deepEqual(after, { turns: written.turns, queued: written.queued })
  assert.ok(Array.isArray(after.queued['chat-a']) && after.queued['chat-a'].length >= 1)
  assert.deepEqual(before.turns, legacy.turns)
})

for (const point of ['temp-write', 'rename', 'between']) {
  test(`failure at ${point}: target holds old bytes or complete new bytes (1)`, async t => {
    const home = dirOf(t)
    const file = join(home, 'inflight.json')
    const oldBytes = JSON.stringify(legacy)
    writeFileSync(file, oldBytes)
    const h = start(home)
    const realWrite = fsp.writeFile
    const realRename = fsp.rename
    if (point === 'temp-write') {
      t.mock.method(fsp, 'writeFile', async (p, data, enc) => { await realWrite(p, String(data).slice(0, 7), enc); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) })
    } else if (point === 'rename') {
      t.mock.method(fsp, 'rename', async () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }) })
    } else {
      // The temp file is complete; the process is gone before the rename happens.
      t.mock.method(fsp, 'rename', async () => { throw Object.assign(new Error('killed'), { code: 'EIO' }) })
      t.mock.method(fsp, 'rm', async () => {})
    }
    h.rt.deliver({ toId: 'a', sessionId: 'chat-a', text: 'x', exchangeId: 'e3' })
    await h.ctx.dispose()
    t.mock.restoreAll()
    const bytes = readFileSync(file, 'utf8')
    assert.equal(bytes, oldBytes, 'old bytes intact after a failed write')
    assert.ok(h.warnings.length >= 1)
    // And a later successful write gives the complete new content.
    const h2 = start(home)
    h2.rt.deliver({ toId: 'a', sessionId: 'chat-a', text: 'y', exchangeId: 'e4' })
    await h2.ctx.dispose()
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(parsed.version)
    void realRename
  })
}

test('success leaves no temp file behind', async t => {
  const home = dirOf(t)
  const h = start(home)
  h.rt.deliver({ toId: 'a', sessionId: 'chat-a', text: 'x', exchangeId: 'e5' })
  await h.ctx.dispose()
  assert.deepEqual(readdirSync(home), ['inflight.json'])
})

for (const [name, bytes] of [['truncated JSON', '{"turns":{"s1":{"botId":'], ['not an object', '[1,2]'], ['garbage', 'xx\u0000yy']]) {
  test(`corrupt file (${name}) is kept aside, warned once, nothing delivered (2)`, async t => {
    const home = dirOf(t)
    const file = join(home, 'inflight.json')
    writeFileSync(file, bytes)
    const h = start(home)
    h.ctx.dispose && await Promise.resolve()
    const kept = readdirSync(home).filter(n => n.startsWith('inflight.json.corrupt-'))
    assert.equal(kept.length, 1)
    assert.equal(readFileSync(join(home, kept[0]), 'utf8'), bytes)
    assert.equal(existsSync(file), false)
    assert.equal(h.failures.length, 1)
    assert.equal(h.failures[0].level, 'warn')
    await new Promise(r => setTimeout(r, 3300))
    await h.ctx.dispose()
    assert.equal(h.delivered.length, 0, 'rt.deliver not called from corrupt data')
    assert.equal(h.failures.length, 1, 'still exactly one warning')
    assert.deepEqual(readdirSync(home).filter(n => n.startsWith('inflight.json.corrupt-')), kept)
  })
}

test('readOnly() !== undefined writes nothing, for any value (5)', async t => {
  for (const value of [null, 0, '', false, 'follower']) {
    const home = dirOf(t)
    const h = start(home, { readOnly: () => value })
    h.rt.deliver({ toId: 'a', sessionId: 'chat-a', text: 'x', exchangeId: 'e6' })
    await h.ctx.dispose()
    assert.deepEqual(readdirSync(home), [], `value ${JSON.stringify(value)}`)
  }
})

test('readOnly host does not rename a corrupt file either', async t => {
  const home = dirOf(t)
  writeFileSync(join(home, 'inflight.json'), '{bad')
  const h = start(home, { readOnly: () => 'follower' })
  await h.ctx.dispose()
  assert.deepEqual(readdirSync(home), ['inflight.json'])
  assert.equal(h.failures.length, 1)
})

// M6 characterization: the non-room `record.resumed` guard (resume.js, resumeTurn) had no
// assertion. A turn already picked up once and cut off again is not delivered a second time.
const { RESUME_DELAY_MS } = await import('../src/host/resume.js')
for (const [name, resumed, expected] of [['picked up once before: stays stopped', true, 0], ['first time without flags: not replayed', false, 0]]) {
  test(`non-room turn ${name} (record.resumed guard)`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 17) })
    const home = dirOf(t)
    writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns: { 'chat-a': { botId: 'a', since: Date.now(), ...(resumed ? { resumed: true } : {}) } }, queued: {} }))
    const finished = Promise.withResolvers()
    const h = start(home, {
      botOf: id => (id === 'a' ? { id: 'a' } : undefined),
      chatOf: id => (id === 'a' ? 'chat-a' : undefined),
      isBotSession: id => id === 'chat-a',
      selfOf: id => (id === 'chat-a' ? 'a' : undefined),
      settleRoomBatches: () => { finished.resolve() },
    })
    t.mock.timers.tick(RESUME_DELAY_MS)
    await finished.promise
    await h.ctx.dispose()
    assert.equal(h.delivered.filter(a => a.resumed === true).length, expected)
  })
}
