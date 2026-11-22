// How long a steer waits before the Bot reads it is measured, not guessed: each read steer is
// appended to logs/steer-latency.jsonl, one still unread past the slow mark is reported once, and
// rt.steerLatencyStats() summarizes the recent ones.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/steer-latency.js'

function world(t, { slowMs = 30 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-steer-latency-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const listeners = []
  const warns = []
  const rt = {
    home, warn: (...args) => warns.push(args), steerSlowMs: slowMs,
    chatOwners: new Map([['s1', 'bot-1']]),
    live: new Map([['s1', { calls: new Set(['c1']) }]]),
    steerPhaseOf: () => 'tools', runningJobs: () => [{}],
    ctx: { on: (name, fn) => { listeners.push({ name, fn }) } },
  }
  install(rt)
  const emit = (event) => { for (const item of listeners) if (item.name === 'session/event') item.fn({ id: 's1' }, event) }
  const steer = (id, time, kind = 'user') => emit({ type: 'agent/inbox/spliced', time, data: { target: 'next-step', inserted: [{ id, source: { kind } }] } })
  const read = (id, time) => emit({ type: 'user/message', time, data: { id, source: { kind: 'user' } } })
  const lines = () => readFileSync(join(home, 'logs/steer-latency.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { rt, warns, steer, read, lines }
}

test('a steer that is read is recorded with how long it waited and what the Bot was doing', (t) => {
  const w = world(t, { slowMs: 10_000 })
  w.steer('m1', 1000)
  w.read('m1', 2600)
  const [record] = w.lines()
  assert.deepEqual([record.waitMs, record.outcome, record.phase, record.calls, record.jobs, record.botId, record.slow], [1600, 'read', 'tools', 1, 1, 'bot-1', false])
  assert.deepEqual(w.rt.steerLatencyStats(), { count: 1, medianMs: 1600, p90Ms: 1600, maxMs: 1600, slow: 0, unread: 0 })
})

test('only a user steer into the next step counts; a Bot\'s message or a queued one is not measured', (t) => {
  const w = world(t)
  w.steer('b1', 1000, 'bot')
  w.read('b1', 2000)
  assert.equal(w.rt.steerLatencyStats().count, 0)
  assert.equal(w.rt.steerLatencyStats().unread, 0)
})

test('one still unread past the slow mark is reported once, then recorded as slow when it is read', async (t) => {
  const w = world(t)
  w.steer('m2', 5000)
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(w.warns.length, 1, 'reported once')
  assert.match(String(w.warns[0][0]), /waited .* unread/)
  assert.equal(w.rt.steerLatencyStats().unread, 1)
  w.read('m2', 5000 + 12_000)
  assert.equal(w.lines()[0].slow, true)
  assert.deepEqual([w.rt.steerLatencyStats().slow, w.rt.steerLatencyStats().maxMs], [1, 12_000])
  w.read('m2', 99_000)
  assert.equal(w.lines().length, 1, 'a message is recorded once')
})

test('median, p90 and max over several steers', (t) => {
  const w = world(t)
  const waits = [500, 900, 1200, 1500, 2000, 2500, 3000, 4000, 8000, 30_000]
  waits.forEach((ms, i) => { w.steer(`m${i}`, 1000 * (i + 1)); w.read(`m${i}`, 1000 * (i + 1) + ms) })
  const stats = w.rt.steerLatencyStats()
  assert.equal(stats.count, 10)
  assert.equal(stats.maxMs, 30_000)
  assert.equal(stats.medianMs, 2500)
  assert.equal(stats.p90Ms, 30_000)
})
