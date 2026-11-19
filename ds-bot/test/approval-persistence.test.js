// W1-3 critical-state persistence: an approval answer is saved (state.json, temp then
// rename) before it is published; a failed save settles 'cancelled'; replays are stale;
// the 60 s coalescing of other saves is unchanged; crash points keep old-or-new data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { install as installStore } from '../src/host/store.js'
import { install as installApprovals } from '../src/host/approvals.js'

const CHILD = fileURLToPath(new URL('./fixtures/approval-crash-child.js', import.meta.url))
const RESOLVE = fileURLToPath(new URL('./harness-resolve.mjs', import.meta.url))

function host(t, saved) {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-persist-'))
  const statePath = join(home, 'state.json')
  if (saved !== undefined) fs.writeFileSync(statePath, typeof saved === 'string' ? saved : JSON.stringify(saved))
  const disposers = []
  const handlers = []
  const settled = []
  const rt = {
    home, statePath,
    ctx: {
      logger: { warn() {} },
      effect(execute) { const d = execute(); if (typeof d === 'function') disposers.push(d) },
      on: (name, handler) => { if (name === 'approval/request') handlers.push(handler) },
    },
    autoRoomName: () => 'Room', retitleRoom: async () => {}, warn() {},
  }
  installStore(rt)
  installApprovals(rt)
  rt.onApproval((kind, data) => { if (kind === 'settled') settled.push(data) })
  t.after(async () => {
    await Promise.all(disposers.splice(0).map(d => d()))
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const ask = (sessionId = 'sess', callId = 'c1') => {
    rt.chatOwners.set(sessionId, 'bot1')
    return handlers[0]({ agent: { session: { id: sessionId } }, toolName: 'shell', callId, reason: 'r', signal: new AbortController().signal }, () => new Promise(() => {}))
  }
  const onDisk = () => JSON.parse(fs.readFileSync(statePath, 'utf8'))
  return { rt, home, statePath, settled, ask, onDisk }
}
const bind = entry => ({ sessionId: entry.sessionId, fingerprint: entry.fingerprint })
const stale = error => error.code === 'bot/stale'

function patchRename(replace) {
  const original = fsp.rename
  fsp.rename = replace(original)
  syncBuiltinESMExports()
  return () => { fsp.rename = original; syncBuiltinESMExports() }
}

test('C-1 the answer and the engine resolve only after state.json holds the result', async (t) => {
  const h = host(t)
  await h.rt.load()
  await h.rt.save({ required: true })
  let release
  const gate = new Promise(r => { release = r })
  let held = false
  const restore = patchRename(original => async (from, to) => {
    if (to === h.statePath && !held) { held = true; await gate }
    return original(from, to)
  })
  t.after(restore)
  const outcome = h.ask()
  const [entry] = h.rt.approvalsView()
  const order = []
  outcome.then(value => order.push(['engine', value, h.onDisk().approvalResults?.[entry.fingerprint]?.result]))
  const answered = h.rt.answerApproval(entry.id, 'allow', bind(entry)).then(() => order.push(['ack', h.onDisk().approvalResults?.[entry.fingerprint]?.result]))
  for (let i = 0; i < 20 && !held; i += 1) await new Promise(r => setImmediate(r))
  assert.equal(held, true)
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(order, [], 'nothing published while the write is pending')
  assert.equal(h.settled.length, 0)
  assert.equal(h.onDisk().approvalResults?.[entry.fingerprint], undefined)
  release()
  await answered
  await outcome
  assert.deepEqual(order, [['engine', 'allowed-once', 'allowed-once'], ['ack', 'allowed-once']])
  assert.deepEqual(h.onDisk().resumeCursor.sess, { approval: 'settled', fp: entry.fingerprint })
})

test('C-2 a coalesced save queued earlier cannot overwrite a later immediate result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = host(t)
  await h.rt.load()
  h.rt.state.prefs.liveness = 'earlier'
  void h.rt.save({ immediate: false })
  const outcome = h.ask()
  const [entry] = h.rt.approvalsView()
  await h.rt.answerApproval(entry.id, 'reject', bind(entry))
  assert.equal(await outcome, 'rejected')
  t.mock.timers.tick(60_000)
  await h.rt.flush()
  for (let i = 0; i < 5; i += 1) await new Promise(r => setImmediate(r))
  const disk = h.onDisk()
  assert.equal(disk.approvalResults[entry.fingerprint].result, 'rejected')
  assert.equal(disk.prefs.liveness, 'earlier')
})

test('C-3 replay, wrong fingerprint, wrong session are stale; two concurrent answers give one result', async (t) => {
  const h = host(t)
  await h.rt.load()
  const outcome = h.ask()
  const [entry] = h.rt.approvalsView()
  assert.throws(() => h.rt.answerApproval(entry.id, 'allow', { sessionId: entry.sessionId, fingerprint: 'f'.repeat(64) }), stale)
  assert.throws(() => h.rt.answerApproval(entry.id, 'allow', { sessionId: 'other', fingerprint: entry.fingerprint }), stale)
  assert.equal(fs.existsSync(h.statePath) ? h.onDisk().approvalResults?.[entry.fingerprint] : undefined, undefined)
  const first = h.rt.answerApproval(entry.id, 'reject', bind(entry))
  assert.throws(() => h.rt.answerApproval(entry.id, 'allow', bind(entry)), stale)
  await first
  assert.equal(await outcome, 'rejected')
  const saved = fs.readFileSync(h.statePath)
  assert.throws(() => h.rt.answerApproval(entry.id, 'allow', bind(entry)), stale)
  assert.throws(() => h.rt.answerApproval(entry.id, 'allow'), stale)
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(fs.readFileSync(h.statePath), saved)
  assert.equal(h.onDisk().approvalResults[entry.fingerprint].result, 'rejected')
  assert.deepEqual(h.settled.map(s => s.outcome), ['rejected'])
})

test('C-4 a failed save settles cancelled and no allow is ever persisted or published', async (t) => {
  const h = host(t)
  await h.rt.load()
  await h.rt.save({ required: true })
  fs.mkdirSync(`${h.statePath}.${process.pid}.tmp`)
  const outcome = h.ask()
  const [entry] = h.rt.approvalsView()
  await assert.rejects(h.rt.answerApproval(entry.id, 'allow', bind(entry)), { code: 'EISDIR' })
  assert.equal(await outcome, 'cancelled')
  assert.deepEqual(h.settled.map(s => s.outcome), ['cancelled'])
  assert.notEqual(h.onDisk().approvalResults?.[entry.fingerprint]?.result, 'allowed-once')
  fs.rmSync(`${h.statePath}.${process.pid}.tmp`, { recursive: true })
  await h.rt.save({ required: true, force: true })
  assert.equal(h.onDisk().approvalResults[entry.fingerprint].result, 'cancelled')
  assert.throws(() => h.rt.answerApproval(entry.id, 'allow', bind(entry)), stale)
})

test('C-5 absent or invalid saved fields load as empty maps', async (t) => {
  for (const saved of [undefined, { version: 2 }, { version: 2, approvalResults: 5, resumeCursor: [] }, { version: 2, approvalResults: null, resumeCursor: 'x' }]) {
    const h = host(t, saved)
    await h.rt.load()
    assert.deepEqual(h.rt.state.approvalResults, {})
    assert.deepEqual(h.rt.state.resumeCursor, {})
  }
})

test('C-6 a non-critical save still waits the 60 s window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = host(t)
  await h.rt.load()
  await h.rt.save({ required: true })
  const before = fs.readFileSync(h.statePath, 'utf8')
  h.rt.state.prefs.liveness = 'later'
  void h.rt.save({ immediate: false })
  t.mock.timers.tick(59_999)
  for (let i = 0; i < 5; i += 1) await new Promise(r => setImmediate(r))
  assert.equal(fs.readFileSync(h.statePath, 'utf8'), before)
  t.mock.timers.tick(1)
  await h.rt.flush()
  for (let i = 0; i < 20 && fs.readFileSync(h.statePath, 'utf8') === before; i += 1) await new Promise(r => setImmediate(r))
  assert.equal(h.onDisk().prefs.liveness, 'later')
})

function crash(t, point) {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-crash-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const run = spawnSync(process.execPath, ['--import', RESOLVE, CHILD, home, point], { encoding: 'utf8', timeout: 60_000 })
  const lines = run.stdout.split('\n')
  const base = JSON.parse(JSON.parse(lines.find(l => l.startsWith('BASE ')).slice(5)))
  const fp = lines.find(l => l.startsWith('FP ')).slice(3)
  return { home, run, base, fp, acked: lines.includes('ACK'), ackBeforeRename: lines.includes('ACK') && lines.indexOf('ACK') < lines.indexOf('RENAME') }
}
async function restart(t, home) {
  const statePath = join(home, 'state.json')
  // The killed child's lock names a dead pid, so a fresh host takes it over.
  const disposers = []
  const rt = { home, statePath, ctx: { logger: { warn() {} }, effect(e) { const d = e(); if (typeof d === 'function') disposers.push(d) }, on() {} }, autoRoomName: () => 'Room', retitleRoom: async () => {}, warn() {} }
  installStore(rt)
  t.after(() => Promise.all(disposers.splice(0).map(d => d())))
  await rt.load()
  return rt
}

test('K-1 killed after the temp write: a fresh start loads the old complete file', async (t) => {
  const { home, run, base, fp, acked } = crash(t, 'after-temp-write')
  assert.equal(run.signal, 'SIGKILL')
  assert.equal(acked, false)
  const rt = await restart(t, home)
  assert.equal(rt.readOnly(), undefined)
  assert.equal(rt.state.prefs.marker, 'baseline')
  assert.equal(rt.state.revision, base.revision)
  assert.equal(rt.state.approvalResults[fp], undefined)
})

test('K-2 killed between the lock check and the rename: old complete data', async (t) => {
  const { home, run, base, fp, acked } = crash(t, 'before-rename')
  assert.equal(run.signal, 'SIGKILL')
  assert.equal(acked, false)
  const rt = await restart(t, home)
  assert.equal(rt.state.revision, base.revision)
  assert.equal(rt.state.approvalResults[fp], undefined)
})

test('K-3 killed after the rename, before the ack: new complete data and no ack', async (t) => {
  const { home, run, base, fp, acked, ackBeforeRename } = crash(t, 'after-rename')
  assert.equal(ackBeforeRename, false, 'the ack must not precede the state rename')
  assert.equal(run.signal, 'SIGKILL')
  assert.equal(acked, false, 'the ack must come after the rename, so a kill there means no ack')
  const rt = await restart(t, home)
  assert.equal(rt.state.revision, base.revision + 1)
  assert.equal(rt.state.approvalResults[fp].result, 'allowed-once')
  assert.deepEqual(rt.state.resumeCursor.sess, { approval: 'settled', fp })
})

test('K-4 the crash hooks live only in the child fixture', () => {
  const child = fs.readFileSync(CHILD, 'utf8')
  assert.match(child, /SIGKILL/)
  for (const file of ['../src/host/store.js', '../src/host/approvals.js', '../src/host/files.js', '../src/host/approval-audit.js']) {
    assert.equal(/SIGKILL|crash-child/.test(fs.readFileSync(new URL(file, import.meta.url), 'utf8')), false, file)
  }
})
