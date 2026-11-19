// W1-3 additive state fields across the real legacy store (git archive of the baseline
// commit) and the current one: old → new → old → new on one home. The legacy store path
// is given by DS_BOT_LEGACY_STORE (absolute path to the baseline's src/host/store.js);
// without it the test locates it at /private/tmp/ds-p2-w13-gate/legacy and skips when absent.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { install as installNew } from '../src/host/store.js'

const LEGACY = process.env.DS_BOT_LEGACY_STORE ?? '/private/tmp/ds-p2-w13-gate/legacy/ds-bot/src/host/store.js'
const hasLegacy = fs.existsSync(LEGACY)
// The legacy tree resolves @deepseek-ai/* through its own copy of the resolve hook.
const legacyResolve = join(LEGACY, '../../../test/harness-resolve.mjs')
if (hasLegacy && fs.existsSync(legacyResolve)) await import(pathToFileURL(legacyResolve).href)
const installOld = hasLegacy ? (await import(pathToFileURL(LEGACY).href)).install : undefined

const RESULTS = { ['a'.repeat(64)]: { result: 'allowed-once', at: 1, sessionId: 's1' }, ['b'.repeat(64)]: { result: 'cancelled', at: 2, sessionId: 's2' } }
const CURSOR = { s1: { since: 10, approval: 'settled', fp: 'a'.repeat(64) }, s2: { approval: 'open', fp: 'b'.repeat(64) } }

// One host at a time on `home`; each is disposed (its lock released) before the next.
async function withHost(install, home, body) {
  const disposers = []
  const rt = {
    home, statePath: join(home, 'state.json'),
    ctx: { logger: { warn() {} }, effect(e) { const d = e(); if (typeof d === 'function') disposers.push(d) } },
    autoRoomName: () => 'Room', retitleRoom: async () => {}, warn() {},
  }
  install(rt)
  try {
    await rt.load()
    assert.equal(rt.readOnly(), undefined)
    return await body(rt)
  } finally {
    await Promise.all(disposers.splice(0).map(d => d()))
  }
}
const disk = home => JSON.parse(fs.readFileSync(join(home, 'state.json'), 'utf8'))

// The four steps share one home; R-1..R-4 each assert after their own step.
const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-roundtrip-'))
test.after(() => fs.rmSync(home, { recursive: true, force: true }))

test('R-1 the old store writes a v2 file', { skip: !hasLegacy && 'legacy store not extracted' }, async () => {
  await withHost(installOld, home, async (rt) => {
    rt.state.prefs.step = 1
    await rt.save({ required: true })
  })
  const saved = disk(home)
  assert.equal(saved.version, 2)
  assert.equal(saved.approvalResults, undefined)
  assert.equal(saved.resumeCursor, undefined)
})

test('R-2 the new store loads it and saves both fields', { skip: !hasLegacy && 'legacy store not extracted' }, async () => {
  await withHost(installNew, home, async (rt) => {
    assert.deepEqual(rt.state.approvalResults, {})
    rt.state.approvalResults = structuredClone(RESULTS)
    rt.state.resumeCursor = structuredClone(CURSOR)
    rt.state.prefs.step = 2
    await rt.save({ required: true })
  })
  await withHost(installNew, home, async (rt) => {
    assert.deepStrictEqual(rt.state.approvalResults, RESULTS)
    assert.deepStrictEqual(rt.state.resumeCursor, CURSOR)
  })
})

test('R-3 the old store loads and rewrites the file; both fields survive', { skip: !hasLegacy && 'legacy store not extracted' }, async () => {
  const before = disk(home).revision
  await withHost(installOld, home, async (rt) => {
    rt.state.prefs.step = 3
    await rt.save({ required: true })
  })
  const saved = disk(home)
  assert.equal(saved.revision, before + 1, 'the legacy host really rewrote the file')
  assert.equal(saved.prefs.step, 3)
  assert.deepStrictEqual(saved.approvalResults, RESULTS)
  assert.deepStrictEqual(saved.resumeCursor, CURSOR)
})

test('R-4 the new store loads both fields after the legacy rewrite', { skip: !hasLegacy && 'legacy store not extracted' }, async () => {
  await withHost(installNew, home, async (rt) => {
    assert.deepStrictEqual(rt.state.approvalResults, RESULTS)
    assert.deepStrictEqual(rt.state.resumeCursor, CURSOR)
    assert.equal(rt.state.prefs.step, 3)
  })
})

test('R-5 empty or missing fields read as {}', async () => {
  for (const saved of [undefined, { version: 2 }, { version: 2, approvalResults: [], resumeCursor: null }]) {
    const h = fs.mkdtempSync(join(tmpdir(), 'ds-bot-roundtrip-empty-'))
    try {
      if (saved !== undefined) fs.writeFileSync(join(h, 'state.json'), JSON.stringify(saved))
      await withHost(installNew, h, async (rt) => {
        assert.deepStrictEqual(rt.state.approvalResults, {})
        assert.deepStrictEqual(rt.state.resumeCursor, {})
      })
    } finally {
      fs.rmSync(h, { recursive: true, force: true })
    }
  }
})

test('R-6 a version 3 file is refused by the old and the new loader alike', { skip: !hasLegacy && 'legacy store not extracted' }, async () => {
  for (const install of [installOld, installNew]) {
    const h = fs.mkdtempSync(join(tmpdir(), 'ds-bot-roundtrip-v3-'))
    try {
      const bytes = JSON.stringify({ version: 3, approvalResults: RESULTS, revision: 7 })
      fs.writeFileSync(join(h, 'state.json'), bytes)
      const disposers = []
      const rt = { home: h, statePath: join(h, 'state.json'), ctx: { logger: { warn() {} }, effect(e) { const d = e(); if (typeof d === 'function') disposers.push(d) } }, autoRoomName: () => 'Room', retitleRoom: async () => {}, warn() {} }
      install(rt)
      await rt.load()
      assert.match(rt.readOnly(), /saved by a newer DS Bot; update DS Bot/)
      await assert.rejects(rt.save({ required: true }))
      await Promise.all(disposers.splice(0).map(d => d()))
      assert.equal(fs.readFileSync(join(h, 'state.json'), 'utf8'), bytes)
    } finally {
      fs.rmSync(h, { recursive: true, force: true })
    }
  }
})
