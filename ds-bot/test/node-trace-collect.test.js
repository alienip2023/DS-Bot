// The node side of bot/trace: what a node Bot's own Session says about a turn, kept as the compact step list
// that goes to the hub. (test/node-trace-e2e.test.js runs it through AC's real functions to a hub's page.)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipArgs, createNodeTracer, createTraceFeed, TRACE_LIMITS } from '../src/host/node-trace.js'

const { createAssistantMessage, createToolResultMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')
const { Session } = await import('@deepseek-ai/dsh-session')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const model = { provider: 'node-model', model: 'm' }

// A real Session, and the events a real turn writes into it, each handed to `listen` as the host would.
function nodeSession(listen) {
  const session = new Session('node-chat')
  const put = (type, data, options) => { const event = session.append(type, data, options); listen(event); return event }
  return {
    session,
    start: (rpcId, text = 'hi') => { put('turn/start', { turn: 1 }); put('step/start', { turn: 1, step: 1 }); put('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId } }), { surfaceOp: 'append' }) },
    assistant: (content, step = 1) => put('assistant/message', { turn: 1, step, message: createAssistantMessage({ content, source: model }), stream: [] }, { surfaceOp: 'append' }),
    call: (id, name, args, step = 1) => put('tool/call', { turn: 1, step, callId: id, name, arguments: args }),
    result: (id, content, isError = false, step = 1) => put('tool/result', { turn: 1, step, message: createToolResultMessage({ callId: id, content, isError }) }, { surfaceOp: 'append' }),
  }
}
const control = (log, { ok = true } = {}) => ({ enabled: true, trace: (payload) => { log.push(structuredClone(payload)); return typeof ok === 'function' ? ok() : ok } })

test('thinking and tool steps of the exchange become steps; what came before the exchange\'s own message is not its', () => {
  const tracer = createNodeTracer({ exchangeId: 'ex-1', control: control([]), flushMs: 1000 })
  const s = nodeSession(event => tracer.onEvent(event))
  // an earlier turn of the same Session
  s.assistant([{ type: 'reasoning', text: 'old thought' }, { type: 'tool-call', id: 'old', name: 'bash', arguments: '{}' }])
  s.result('old', [{ type: 'text', text: 'old out' }])
  s.start('ex-1')
  s.assistant([{ type: 'reasoning', text: 'plan' }, { type: 'text', text: 'let me look' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }])
  s.call('c1', 'bash', '{"command":"ls"}')
  s.result('c1', [{ type: 'text', text: 'a.txt' }, { type: 'image', attachment: {} }])
  s.result('stranger', [{ type: 'text', text: 'not ours' }])
  s.assistant([{ type: 'reasoning', text: '<signature>abc</signature>\nanswer it' }, { type: 'text', text: 'the answer' }])
  s.assistant([{ type: 'text', text: 'no thinking, no tool: nothing to show' }])
  const { items, omitted } = tracer.finish()
  assert.equal(omitted, 0)
  assert.deepEqual(items, [
    { i: 1, t: 'a', think: 'plan', calls: [{ id: 'c1', name: 'bash', args: '{"command":"ls"}' }] },
    { i: 2, t: 'r', id: 'c1', ok: true, out: 'a.txt\n[图片]' },
    { i: 3, t: 'a', think: 'answer it', end: true },
  ], 'the visible text of a step is not carried: the turn result already holds every text of the turn')
})

test('a failed tool is a failed step; an exchange whose own message never appeared has no steps', () => {
  const tracer = createNodeTracer({ exchangeId: 'ex-1', control: control([]), flushMs: 1000 })
  const s = nodeSession(event => tracer.onEvent(event))
  s.start('ex-1')
  s.assistant([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }])
  s.result('c1', [{ type: 'text', text: 'boom' }], true)
  assert.deepEqual(tracer.finish().items.map(item => [item.t, item.ok]), [['a', undefined], ['r', false]])
  const other = createNodeTracer({ exchangeId: 'ex-9', control: control([]), flushMs: 1000 })
  const t = nodeSession(event => other.onEvent(event))
  t.start('ex-1')
  t.assistant([{ type: 'reasoning', text: 'x' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }])
  assert.deepEqual(other.finish(), { items: [], omitted: 0 })
})

test('secrets the user keeps are removed from thinking, arguments and output before anything leaves the node', () => {
  const redact = text => text.replaceAll('sk-live-123', '[secret:API_KEY]')
  const tracer = createNodeTracer({ exchangeId: 'ex-1', control: control([]), redact, flushMs: 1000 })
  const s = nodeSession(event => tracer.onEvent(event))
  s.start('ex-1')
  s.assistant([{ type: 'reasoning', text: 'use sk-live-123' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"curl -H sk-live-123"}' }])
  s.result('c1', [{ type: 'text', text: 'token sk-live-123 accepted' }])
  const json = JSON.stringify(tracer.finish())
  assert.equal(json.includes('sk-live-123'), false)
  assert.equal(json.split('[secret:API_KEY]').length - 1, 3)
})

test('long text is cut with a marker, long arguments stay valid JSON with the short fields readable, and the list has a cap that is counted', () => {
  const tracer = createNodeTracer({ exchangeId: 'ex-1', control: control([]), flushMs: 1000 })
  const s = nodeSession(event => tracer.onEvent(event))
  s.start('ex-1')
  const big = JSON.stringify({ file_path: '/work/a.txt', content: 'x'.repeat(40_000) })
  s.assistant([{ type: 'reasoning', text: 'T'.repeat(TRACE_LIMITS.think + 10) }, { type: 'tool-call', id: 'c1', name: 'write', arguments: big }, { type: 'tool-call', id: 'c2', name: 'x', arguments: 'not json '.repeat(400) }])
  s.result('c1', [{ type: 'text', text: 'O'.repeat(TRACE_LIMITS.out + 5) }])
  const [a, r] = tracer.finish().items
  assert.equal(a.think, `${'T'.repeat(TRACE_LIMITS.think)}…[已截断 10 字]`)
  const args = JSON.parse(a.calls[0].args)
  assert.equal(args.file_path, '/work/a.txt')
  assert.match(args.content, /…\[已截断 \d+ 字\]$/)
  assert.ok(a.calls[0].args.length <= TRACE_LIMITS.args)
  assert.match(JSON.parse(a.calls[1].args)._truncated, /…\[已截断 \d+ 字\]$/)
  assert.equal(r.out, `${'O'.repeat(TRACE_LIMITS.out)}…[已截断 5 字]`)
  assert.equal(clipArgs('{"a":1}'), '{"a":1}', 'short arguments are untouched')

  const full = createNodeTracer({ exchangeId: 'ex-2', control: control([]), flushMs: 1000 })
  const t = nodeSession(event => full.onEvent(event))
  t.start('ex-2')
  for (let n = 0; n < TRACE_LIMITS.maxItems + 30; n += 1) t.assistant([{ type: 'reasoning', text: `step ${n}` }, { type: 'tool-call', id: `c${n}`, name: 'bash', arguments: '{}' }])
  const done = full.finish()
  assert.equal(done.items.length, TRACE_LIMITS.maxItems)
  assert.equal(done.omitted, 30)
  assert.deepEqual(done.items.map(item => item.i), Array.from({ length: TRACE_LIMITS.maxItems }, (_, n) => n + 1), 'the kept steps have no gap')
})

test('steps go out live in throttled batches of at most maxBatchItems, the first at once; a batch that could not be sent is sent again, not lost', async () => {
  const log = []
  let up = false
  const tracer = createNodeTracer({ exchangeId: 'ex-1', control: control(log, { ok: () => up }), flushMs: 30 })
  const s = nodeSession(event => tracer.onEvent(event))
  s.start('ex-1')
  s.assistant([{ type: 'reasoning', text: 'one' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }])
  await wait(10)
  assert.equal(log.length, 1, 'the first step goes out at once')
  assert.deepEqual(log[0].items.map(item => item.i), [1])
  s.result('c1', [{ type: 'text', text: 'out' }])
  await wait(100)
  assert.equal(log.length, 1, 'the link is down: the failed batch is retried later, not in a tight loop')
  up = true
  await wait(2200)
  assert.deepEqual(log.at(-1).items.map(item => item.i), [1, 2], 'when the link is back, what was not sent goes out, in one batch')
  const before = log.length
  for (let n = 0; n < 150; n += 1) s.assistant([{ type: 'reasoning', text: `t${n}` }, { type: 'tool-call', id: `x${n}`, name: 'bash', arguments: '{}' }])
  await wait(80)
  const batches = log.slice(before)
  assert.ok(batches.length >= 3 && batches.every(batch => batch.items.length <= TRACE_LIMITS.maxBatchItems))
  assert.deepEqual(batches.flatMap(batch => batch.items.map(item => item.i)), Array.from({ length: 150 }, (_, n) => n + 3), 'in order, each step once')
  const final = tracer.finish()
  assert.equal(final.items.length, 152, 'the final list is the whole list')
  const stopped = log.length
  await wait(80)
  assert.equal(log.length, stopped, 'nothing is sent after finish')
})

test('the feed gives a tracer only when AC enabled tracing, routes events by Session, and forgets a finished exchange', () => {
  const listeners = []
  const rt = { ctx: { on: (name, fn) => { if (name === 'session/event') listeners.push(fn) } } }
  const feed = createTraceFeed(rt)
  assert.equal(feed.start({ sessionId: 'node-chat', exchangeId: 'ex-1', control: { enabled: false, trace: () => true } }), undefined, 'a hub that cannot take traces: nothing is collected')
  assert.equal(feed.start({ sessionId: 'node-chat', exchangeId: 'ex-1', control: undefined }), undefined, 'an older AC passes no control')
  assert.equal(feed.start({ sessionId: undefined, exchangeId: 'ex-1', control: control([]) }), undefined)
  assert.equal(createTraceFeed({}).start({ sessionId: 'node-chat', exchangeId: 'ex-1', control: control([]) }), undefined, 'no event source')
  const tracer = feed.start({ sessionId: 'node-chat', exchangeId: 'ex-1', control: control([]) })
  assert.equal(listeners.length, 1)
  const s = nodeSession(event => { for (const fn of listeners) fn({ id: 'node-chat' }, event) })
  const other = nodeSession(event => { for (const fn of listeners) fn({ id: 'other-chat' }, event) })
  other.start('ex-1')
  other.assistant([{ type: 'reasoning', text: 'not ours' }, { type: 'tool-call', id: 'o', name: 'bash', arguments: '{}' }])
  s.start('ex-1')
  s.assistant([{ type: 'reasoning', text: 'ours' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }])
  const { items } = tracer.finish()
  assert.deepEqual(items.map(item => item.think), ['ours'])
  s.assistant([{ type: 'reasoning', text: 'after' }, { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }])
  assert.equal(tracer.snapshot().items.length, 1, 'a finished exchange collects nothing more')
})

test('a listener that throws does not take the Session event down', () => {
  const rt = { ctx: { on: (name, fn) => { rt.fn = fn } }, warn: () => { rt.warned = true } }
  const feed = createTraceFeed(rt)
  const tracer = feed.start({ sessionId: 'node-chat', exchangeId: 'ex-1', control: control([]) })
  tracer.onEvent = () => { throw new Error('boom') }
  assert.doesNotThrow(() => rt.fn({ id: 'node-chat' }, { type: 'user/message' }))
  assert.equal(rt.warned, true)
})
