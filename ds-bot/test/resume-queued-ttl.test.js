import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import './harness-resolve.mjs'
import { fakeContext } from './fake-ctx.js'

const { install, QUEUED_TTL_MS, RESUME_DELAY_MS } = await import('../src/host/resume.js')

const NOW = Date.UTC(2026, 10, 17)
const minute = 60 * 1000
const old = NOW - 2 * 24 * 60 * minute
const recent = NOW - 10 * minute
const warning = 'ds-bot: dropped %d stale queued notes older than 30 minutes'
const note = (exchangeId, at, args = {}) => ({ at, args: { toId: 'a', exchangeId, role: 'request', text: exchangeId, ...args } })

function fixture(t, queued, turns = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-resume-ttl-'))
  const file = join(home, 'inflight.json')
  writeFileSync(file, JSON.stringify({ turns, queued }))
  const hosts = []
  t.after(async () => {
    await Promise.all(hosts.map(ctx => ctx.dispose()))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const read = () => JSON.parse(readFileSync(file, 'utf8'))
  const start = () => {
    const ctx = fakeContext()
    hosts.push(ctx)
    const finished = Promise.withResolvers()
    const delivered = []
    const warnings = []
    const late = []
    const inbox = { nextStep: [], nextTurn: [] }
    const rt = {
      ctx, home,
      load: async () => {},
      readOnly: () => undefined,
      botOf: id => (id === 'a' ? { id: 'a' } : undefined),
      chatOf: id => (id === 'a' ? 'chat-a' : undefined),
      isBotSession: id => id === 'chat-a',
      selfOf: id => (id === 'chat-a' ? 'a' : undefined),
      resolveAgent: async () => ({ inbox }),
      deliver: async args => { delivered.push(args) },
      lateWork: id => { late.push(id) },
      warn: (...args) => { warnings.push(args) },
      settleRoomBatches: () => { finished.resolve() },
    }
    install(rt)
    return {
      rt, delivered, warnings, late, inbox,
      async recover() {
        t.mock.timers.tick(RESUME_DELAY_MS)
        await finished.promise
        // Disposal waits for resume's background writes before the file is read.
        await ctx.dispose()
      },
    }
  }
  return { start, read }
}

test('resume drops three stale notes and resends two recent notes in order', async t => {
  const fresh = [note('new-1', recent), note('new-2', recent)]
  const f = fixture(t, { 'chat-a': [note('old-1', old), fresh[0], note('old-2', old), fresh[1], note('old-3', old)] })
  const host = f.start()
  await host.recover()
  assert.deepEqual(host.delivered, fresh.map(item => ({ ...item.args, sessionId: 'chat-a', steer: false, resent: true })))
  assert.deepEqual(host.late, ['new-1', 'new-2'])
  assert.deepEqual(host.warnings, [[warning, 3]])
  assert.deepEqual(host.rt.unreadOf('chat-a'), fresh.map(item => item.args))
  assert.deepEqual(f.read(), { turns: {}, queued: { 'chat-a': fresh } })

  const restarted = f.start()
  await restarted.recover()
  assert.deepEqual(restarted.delivered, host.delivered)
  assert.deepEqual(restarted.warnings, [])
  assert.deepEqual(f.read().queued, { 'chat-a': fresh })
})

test('resume retains missing and nonnumeric timestamps without coercing them', async t => {
  const list = [undefined, '0', 'yesterday', null, false, {}, []].map((at, i) => note(`legacy-${i}`, at))
  const f = fixture(t, { 'chat-a': list })
  const host = f.start()
  await host.recover()
  assert.deepEqual(host.delivered.map(args => args.exchangeId), list.map(item => item.args.exchangeId))
  assert.deepEqual(f.read().queued, { 'chat-a': JSON.parse(JSON.stringify(list)) })
  assert.deepEqual(host.warnings, [])
})

test('resume keeps recent notes and does not warn when none are stale', async t => {
  const list = [note('new-1', recent), note('new-2', recent)]
  const f = fixture(t, { 'chat-a': list })
  const host = f.start()
  await host.recover()
  assert.deepEqual(host.delivered.map(args => args.exchangeId), ['new-1', 'new-2'])
  assert.deepEqual(f.read().queued, { 'chat-a': list })
  assert.deepEqual(host.warnings, [])
})

test('resume drops every stale note across sessions, warns once, and persists an empty queue', async t => {
  const f = fixture(t, { 'chat-a': [note('old-1', old)], 'previous-chat': [note('old-2', old), note('old-3', old)] })
  const host = f.start()
  await host.recover()
  assert.deepEqual(host.delivered, [])
  assert.deepEqual(host.warnings, [[warning, 3]])
  assert.deepEqual(f.read(), { turns: {}, queued: {} })
  const restarted = f.start()
  await restarted.recover()
  assert.deepEqual(restarted.delivered, [])
  assert.deepEqual(restarted.warnings, [])
})

test('resume expires only finite timestamps strictly older than the TTL', async t => {
  assert.equal(QUEUED_TTL_MS, 30 * minute)
  const boundary = NOW + RESUME_DELAY_MS - QUEUED_TTL_MS
  const kept = [note('boundary', boundary), note('inside', boundary + 1), note('future', NOW + 60 * minute)]
  const f = fixture(t, { 'chat-a': [note('expired', boundary - 1), ...kept] })
  const host = f.start()
  await host.recover()
  assert.deepEqual(host.delivered.map(args => args.exchangeId), kept.map(item => item.args.exchangeId))
  assert.deepEqual(f.read().queued, { 'chat-a': kept })
  assert.deepEqual(host.warnings, [[warning, 1]])
})

test('recent notes keep the existing inbox deduplication and session migration behavior', async t => {
  const list = [note('waiting', recent), note('resend', recent)]
  const f = fixture(t, { 'previous-chat': list })
  const host = f.start()
  host.inbox.nextTurn.push({ source: { exchangeId: 'waiting' } })
  await host.recover()
  assert.deepEqual(host.delivered.map(args => [args.exchangeId, args.sessionId]), [['resend', 'chat-a']])
  assert.deepEqual(f.read().queued, { 'chat-a': list })
  assert.deepEqual(host.warnings, [])
})

test('queued TTL does not expire interrupted turns or resend deliveries made during startup', async t => {
  const f = fixture(t, { 'chat-a': [note('expired', old)] }, { 'chat-a': { botId: 'a', since: old } })
  const host = f.start()
  await host.rt.deliver(note('startup', NOW).args)
  await host.recover()
  assert.deepEqual(host.delivered.map(args => args.role), ['request', 'resume'])
  assert.equal(host.delivered[0].exchangeId, 'startup')
  assert.equal(host.delivered[1].resumed, true)
  assert.deepEqual(f.read().queued['chat-a'].map(item => item.args.role), ['request', 'resume'])
  assert.deepEqual(host.warnings, [[warning, 1]])
})
