import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import { LocalAgentAdapter, eventProblem } from '../src/host/local-agents/adapter.js'
import { install as approvalsInstall, APPROVAL_OUTCOME_VALUES } from '../src/host/approvals.js'

const SENTINEL = 'SECRET-TOKEN-sk-123456'
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

const made = []
after(async () => { for (const adapter of made) for (const live of [...adapter.live.values()]) await adapter.closeLive(live, { idle: true }).catch(() => {}) })

// A stub engine: `prompt` feeds the scripted events to the session queue.
function makeAdapter({ script, preset = 'workspace-write', warns = [], now } = {}) {
  const queue = []
  const waiters = []
  const push = (event) => { const w = waiters.shift(); if (w) w(event); else queue.push(event) }
  const session = { next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise(r => waiters.push(r))), dead: false }
  const engine = {
    open: async () => session,
    prompt: async () => { for (const event of script()) push(event) },
    supportsImages: () => false,
  }
  const adapter = new LocalAgentAdapter({
    rt: { warn: (message) => warns.push(String(message)) },
    now,
    customAgents: () => [{ id: 'fake', name: 'Fake', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: () => engine,
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => preset,
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-te-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-te-')),
    toolsFor: () => [],
  })
  adapter._push = push
  made.push(adapter)
  return adapter
}
const options = (sessionId = 's1') => ({ provider: 'local-acp-fake', model: 'default', sessionId, messages: [user('m1', 'hello')], tools: [], signal: AbortSignal.timeout(20_000) })
async function collect(stream) {
  const out = { text: '', calls: [], finish: undefined, chunks: [] }
  for await (const chunk of stream) {
    out.chunks.push(chunk)
    if (chunk.type === 'text-delta') out.text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') out.calls.push(chunk.block)
    else if (chunk.type === 'finish') out.finish = chunk.reason
  }
  return out
}
const DONE = { type: 'done', reason: 'stop' }
const text = t => ({ type: 'text', text: t })

const BAD = [
  ['null', null], ['undefined', undefined], ['string', 'text'], ['number', 7], ['array', [1]],
  ['no type', { text: 'x' }], ['non-string type', { type: 5 }], ['unknown type', { type: 'bogus', text: SENTINEL }],
  ['text non-string', { type: 'text', text: 3 }], ['usage missing', { type: 'usage' }],
  ['error missing', { type: 'error' }], ['compaction unknown status', { type: 'compaction', status: 'weird' }],
]

test('eventProblem: discarded classes and known events', () => {
  for (const [name, event] of BAD) assert.notEqual(eventProblem(event), undefined, name)
  for (const event of [text('a'), { type: 'thought', text: 'a' }, { type: 'activity', text: 'a' }, { type: 'usage', usage: {} }, DONE,
    { type: 'error', error: new Error('x') }, { type: 'compaction', status: 'started' }, { type: 'context', used: 1 }, { type: 'effort', effort: 'low' },
    { type: 'quiet' }, { type: 'abort' }, { type: 'call', name: 'n', dshCallId: 'd' }, { type: 'permission', id: 'p', reply() {}, options: [] }]) {
    assert.equal(eventProblem(event), undefined, event.type)
  }
})

for (const [name, bad] of BAD) {
  test(`first loop discards ${name}: 1 warning, turn ends normally`, async () => {
    const warns = []
    const adapter = makeAdapter({ warns, script: () => [text('a'), bad, text('b'), DONE] })
    const out = await collect(adapter.stream(options()))
    assert.equal(out.text, 'ab')
    assert.deepEqual(out.finish, { kind: 'stop' })
    assert.equal(warns.length, 1)
    assert.equal(adapter.eventDiscards, 1)
    assert.ok(!warns[0].includes(SENTINEL))
  })
}

test('an unknown type is never mapped to done (stream keeps reading after it)', async () => {
  const adapter = makeAdapter({ script: () => [{ type: 'bogus' }, text('late'), DONE] })
  const out = await collect(adapter.stream(options()))
  assert.equal(out.text, 'late')
})

test('condense/drain loop discards bad events and ends normally', async () => {
  for (const [name, bad] of BAD) {
    const warns = []
    const adapter = makeAdapter({ warns, script: () => [bad, text('digest'), DONE] })
    const out = await collect(adapter.stream({ ...options(), purpose: 'compaction' }))
    assert.equal(warns.length <= 1, true, name)
    assert.ok(out.finish !== undefined || out.text !== undefined, name)
  }
})

test('known silent events: zero warnings, unchanged output', async () => {
  const warns = []
  const quiet = makeAdapter({ warns, script: () => [{ type: 'context', used: 5, size: 10 }, { type: 'compaction', status: 'started' }, { type: 'effort', effort: 'low' }, text('hi'), DONE] })
  quiet.deps.saveRecord = () => {}
  const out = await collect(quiet.stream(options()))
  assert.equal(out.text, 'hi')
  assert.equal(warns.length, 0)
})

test('rate limit: repeats are counted, warned once per window (injected clock)', async () => {
  const warns = []
  let t = 1_000
  const adapter = makeAdapter({ warns, now: () => t, script: () => [{ type: 'bogus' }, { type: 'bogus2' }, { type: 'bogus3' }, DONE] })
  await collect(adapter.stream(options()))
  assert.equal(adapter.eventDiscards, 3)
  assert.equal(warns.length, 1)
  t += 61_000
  adapter.screenEvent({}, { type: 'bogus4' })
  assert.equal(warns.length, 2)
  assert.equal(adapter.eventDiscards, 4)
})

test('warning carries the truncated type name only, never payload', async () => {
  const warns = []
  const longType = 'x'.repeat(200)
  const adapter = makeAdapter({ warns, script: () => [{ type: longType, text: SENTINEL, token: SENTINEL }, DONE] })
  await collect(adapter.stream(options()))
  assert.equal(warns.length, 1)
  assert.ok(!warns[0].includes(SENTINEL))
  assert.ok(!warns[0].includes('x'.repeat(33)))
})

const MALFORMED = [
  ['no id', replyFn => ({ type: 'permission', reply: replyFn, action: 'rm', options: [{ optionId: 'a', kind: 'allow_once' }] })],
  ['reply not a function', () => ({ type: 'permission', id: 'p1', reply: 'nope', action: 'rm', options: [{ optionId: 'a', kind: 'allow_once' }] })],
  ['options not an array', replyFn => ({ type: 'permission', id: 'p1', reply: replyFn, action: 'rm', options: 'allow' })],
]
for (const preset of ['danger-full-access', 'workspace-write', 'read-only']) {
  for (const [name, make] of MALFORMED) {
    test(`malformed permission (${name}) under ${preset}: no pending, no approval call, never allow`, async () => {
      const replies = []
      const adapter = makeAdapter({ preset, script: () => [make(value => replies.push(value)), text('after'), DONE] })
      const out = await collect(adapter.stream(options()))
      const live = adapter.live.get('s1')
      assert.equal(live.pending.size, 0)
      assert.equal(out.calls.length, 0)
      assert.equal(out.text, 'after')
      for (const value of replies) assert.equal(value, null)
      if (name !== 'reply not a function') assert.deepEqual(replies, [null])
    })
  }
}

test('outcome constant is frozen with exactly the three existing values', () => {
  assert.ok(Object.isFrozen(APPROVAL_OUTCOME_VALUES))
  assert.deepEqual(Object.values(APPROVAL_OUTCOME_VALUES).sort(), ['allowed-once', 'cancelled', 'rejected'])
  assert.ok(!Object.values(APPROVAL_OUTCOME_VALUES).some(v => v === 'unavailable' || v === 'expired'))
})
