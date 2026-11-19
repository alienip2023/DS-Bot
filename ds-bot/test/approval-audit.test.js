// W1-3 approval audit: allowlisted JSON lines, permissions, rotation, tail recovery,
// failure isolation, and the read-only host (U6 Option A) writing nothing.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installStore } from '../src/host/store.js'
import { install as installApprovals, approvalFingerprint, APPROVAL_OUTCOME_VALUES } from '../src/host/approvals.js'
import { auditRecord, createAuditWriter, readAudit, AUDIT_DIR, AUDIT_FILE } from '../src/host/approval-audit.js'

const SECRET = { reason: 'REASON-sk-live-9f8e7d', detail: 'DETAIL-rm -rf /Users/x/secret.txt', path: '/Users/x/secret.txt', token: 'ghp_TOKENabcdef123456', callId: 'CALLID-raw-77', tool: 'TOOLNAME-shellx' }

function host(t, { home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-audit-')), lockedBy } = {}) {
  const statePath = join(home, 'state.json')
  if (lockedBy) fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: lockedBy, since: Date.now() }))
  const warnings = []
  const disposers = []
  const handlers = []
  const settled = []
  const rt = {
    home, statePath,
    ctx: {
      logger: { warn: (...a) => warnings.push(a) },
      effect(execute) { const d = execute(); if (typeof d === 'function') disposers.push(d) },
      on: (name, handler) => { if (name === 'approval/request') handlers.push(handler) },
    },
    autoRoomName: () => 'Room', retitleRoom: async () => {},
    warn: (...a) => warnings.push(a),
    callDetail: () => ({ text: SECRET.detail, code: SECRET.token }),
  }
  installStore(rt)
  const chatOwners = rt.chatOwners
  installApprovals(rt)
  rt.onApproval((kind, data) => { if (kind === 'settled') settled.push(data) })
  t.after(async () => {
    await Promise.all(disposers.splice(0).map(d => d()))
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const ask = (sessionId = 'sess') => {
    chatOwners.set(sessionId, 'bot1')
    return handlers[0]({ agent: { session: { id: sessionId } }, toolName: SECRET.tool, callId: SECRET.callId, reason: `${SECRET.reason} ${SECRET.path} ${SECRET.token}`, signal: new AbortController().signal }, () => new Promise(() => {}))
  }
  const auditPath = join(home, AUDIT_DIR, AUDIT_FILE)
  return { rt, home, statePath, warnings, settled, ask, auditPath, chatOwners }
}

const listing = (dir) => {
  const out = {}
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = join(d, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else out[p.slice(dir.length)] = createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

async function openAndAnswer(h, choice = 'allow') {
  const outcome = h.ask()
  const [entry] = h.rt.approvalsView()
  await h.rt.answerApproval(entry.id, choice, { sessionId: entry.sessionId, fingerprint: entry.fingerprint })
  await h.rt.approvalAudit.idle()
  return { entry, outcome: await outcome }
}

test('A-S1 open and settle append exactly two allowlisted lines', async (t) => {
  const h = host(t)
  await h.rt.load()
  const { entry, outcome } = await openAndAnswer(h)
  assert.equal(outcome, 'allowed-once')
  const lines = fs.readFileSync(h.auditPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.deepEqual(Object.keys(lines[0]), ['v', 'ts', 'actor', 'session', 'fp', 'phase'])
  assert.deepEqual(Object.keys(lines[1]), ['v', 'ts', 'actor', 'session', 'fp', 'result', 'phase'])
  assert.deepEqual(lines.map(l => l.phase), ['open', 'settled'])
  assert.ok(Object.values(APPROVAL_OUTCOME_VALUES).includes(lines[1].result))
  assert.equal(lines[0].actor, 'bot1')
  assert.equal(lines[1].fp, entry.fingerprint)
})

test('A-S2 reason, detail, tool args, path and token never reach the file', async (t) => {
  const h = host(t)
  await h.rt.load()
  await openAndAnswer(h, 'reject')
  const text = fs.readFileSync(h.auditPath, 'utf8')
  for (const value of [SECRET.reason, SECRET.detail, SECRET.path, SECRET.token, 'sk-live', 'rm -rf']) assert.equal(text.includes(value), false, value)
})

test('A-S3 the fingerprint is approvalFingerprint and the raw callId/tool name are absent', async (t) => {
  const h = host(t)
  await h.rt.load()
  const { entry } = await openAndAnswer(h)
  assert.equal(entry.fingerprint, approvalFingerprint('sess', SECRET.tool, SECRET.callId, entry.at))
  const text = fs.readFileSync(h.auditPath, 'utf8')
  assert.equal(text.includes(SECRET.callId), false)
  assert.equal(text.includes(SECRET.tool), false)
  assert.equal(text.includes(SECRET.detail), false)
  for (const line of text.split('\n').filter(Boolean)) assert.equal(JSON.parse(line).fp, entry.fingerprint)
})

test('A-S4 the audit directory is 0700 and the file 0600', async (t) => {
  const h = host(t)
  await h.rt.load()
  await openAndAnswer(h)
  assert.equal(fs.statSync(join(h.home, AUDIT_DIR)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(h.auditPath).mode & 0o777, 0o600)
})

test('A-S5 rotation keeps at most the configured generations within the size bound', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ds-bot-audit-rot-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const w = createAuditWriter({ dir, writable: () => true, maxBytes: 400, generations: 3 })
  for (let i = 0; i < 40; i += 1) assert.equal(await w.append({ ts: i, actor: 'bot1', entry: { sessionId: 's', fingerprint: 'f'.repeat(64) }, phase: 'open' }), 'recorded')
  const names = fs.readdirSync(dir).sort()
  assert.deepEqual(names, [AUDIT_FILE, `${AUDIT_FILE}.1`, `${AUDIT_FILE}.2`])
  let total = 0
  for (const n of names) { const s = fs.statSync(join(dir, n)).size; assert.ok(s <= 400, `${n} ${s}`); total += s }
  assert.ok(total <= 1200)
  const { records, skipped } = await readAudit(dir)
  assert.equal(skipped, 0)
  assert.equal(records.at(-1).ts, 39)
  assert.deepEqual(records.map(r => r.ts), [...records.map(r => r.ts)].sort((a, b) => a - b))
})

test('A-S6 a torn last line is skipped by the reader and the next append starts on a fresh line', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ds-bot-audit-tail-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, AUDIT_FILE)
  const good = `${JSON.stringify(auditRecord({ ts: 1, actor: 'a', entry: { sessionId: 's', fingerprint: 'x' }, phase: 'open' }))}\n`
  fs.writeFileSync(path, `${good}{"v":1,"ts":2,"act`, { mode: 0o600 })
  const before = fs.readFileSync(path)
  assert.deepEqual((await readAudit(dir)).skipped, 1)
  const w = createAuditWriter({ dir, writable: () => true })
  assert.equal(await w.append({ ts: 3, actor: 'a', entry: { sessionId: 's', fingerprint: 'x' }, result: 'rejected', phase: 'settled' }), 'recorded')
  const after = fs.readFileSync(path)
  assert.deepEqual(after.subarray(0, before.length), before)
  const { records, skipped } = await readAudit(dir)
  assert.equal(skipped, 1)
  assert.deepEqual(records.map(r => r.ts), [1, 3])
})

test('A-S7 a missing or empty file reads as zero records and the outcome does not depend on it', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ds-bot-audit-empty-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(await readAudit(dir), { records: [], skipped: 0 })
  fs.writeFileSync(join(dir, AUDIT_FILE), '')
  assert.deepEqual(await readAudit(dir), { records: [], skipped: 0 })
  const a = host(t)
  await a.rt.load()
  const first = await openAndAnswer(a)
  const b = host(t)
  await b.rt.load()
  fs.mkdirSync(join(b.home, AUDIT_DIR), { recursive: true })
  fs.writeFileSync(b.auditPath, 'garbage-not-json\n')
  const second = await openAndAnswer(b)
  assert.equal(first.outcome, second.outcome)
  // The decision code imports nothing that reads the audit.
  const source = fs.readFileSync(new URL('../src/host/approvals.js', import.meta.url), 'utf8')
  assert.equal(/readAudit/.test(source), false)
})

test('A-S8 an unwritable audit warns with a code only, and the outcome is the logic\'s', async (t) => {
  for (const choice of ['allow', 'reject']) {
    const h = host(t)
    await h.rt.load()
    fs.writeFileSync(join(h.home, AUDIT_DIR), 'a file where the directory should be')
    const { outcome } = await openAndAnswer(h, choice)
    assert.equal(outcome, choice === 'allow' ? 'allowed-once' : 'rejected')
    assert.equal(h.settled.at(-1).audit, 'unaudited')
    assert.equal(h.settled.at(-1).outcome, outcome)
    const audits = h.warnings.filter(a => /approval audit unavailable/.test(String(a[0])))
    assert.equal(audits.length, 1)
    assert.match(String(audits[0][1]), /^E[A-Z]+$/)
    assert.equal(JSON.stringify(audits).includes(h.home), false)
  }
})

test('U-A1 a read-only host still answers and writes nothing in the home', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-audit-ro-'))
  fs.writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, bots: {}, revision: 3 }))
  const h = host(t, { home, lockedBy: 'other-host' })
  await h.rt.load()
  assert.match(h.rt.readOnly(), /another dsh/)
  const before = listing(home)
  const outcome = h.ask()
  const [entry] = h.rt.approvalsView()
  h.rt.answerApproval(entry.id, 'allow', { sessionId: entry.sessionId, fingerprint: entry.fingerprint })
  assert.equal(await outcome, 'allowed-once')
  await h.rt.approvalAudit.idle()
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual(listing(home), before)
  assert.equal(fs.existsSync(join(home, AUDIT_DIR)), false)
  assert.equal(h.settled.at(-1).audit, 'unaudited')
})

test('U-A2 a writable host marks the settlement recorded', async (t) => {
  const h = host(t)
  await h.rt.load()
  await openAndAnswer(h)
  assert.equal(h.settled.at(-1).audit, 'recorded')
  assert.equal(h.settled.at(-1).outcome, 'allowed-once')
})

test('U-A3 settled outcomes stay within the existing vocabulary', async (t) => {
  const seen = new Set()
  for (const choice of ['allow', 'reject']) {
    const h = host(t)
    await h.rt.load()
    await openAndAnswer(h, choice)
    for (const s of h.settled) seen.add(s.outcome)
  }
  const h = host(t)
  await h.rt.load()
  void h.ask()
  h.rt.cancelApprovals('sess')
  for (const s of h.settled) seen.add(s.outcome)
  assert.deepEqual([...seen].sort(), ['allowed-once', 'cancelled', 'rejected'])
  for (const word of seen) assert.ok(!['unavailable', 'expired'].includes(word))
})

test('U-A4 the HTTP result stays ok(true) and API/protocol versions are unchanged', async () => {
  const channel = fs.readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  assert.match(channel, /case 'approval-answer':\n\s+await rt\.answerApproval\(body\.id, body\.choice, body\.binding \?\? undefined\)\n\s+return ok\(true\)/)
  const mobile = fs.readFileSync(new URL('../src/host/mobile.js', import.meta.url), 'utf8')
  assert.match(mobile, /API_VERSION = 1\b/)
  assert.match(mobile, /API_MIN = 1\b/)
})
