// DSH's job list restarts a session's row stream on every render (see src/client/jobs-rows-guard.js). Here DSH's own
// client jobs service is reproduced as it ships (ref-counted acquire, a stream whose first frame replaces the rows,
// `changed()` after each replace) on a real cordis Service, with the list's effect: stop and start again on every
// render, `watchRows` being a new function each time.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { guardJobRows } from '../src/client/jobs-rows-guard.js'

class Jobs extends Service {
  opens = 0
  closes = 0
  rows = new Map()
  listeners = new Set()
  entries = new Map()
  constructor(ctx) { super(ctx, 'jobs') }
  changed() { for (const listener of this.listeners) listener() }
  watchRows(sessionId) {
    const key = String(sessionId)
    const existing = this.entries.get(key)
    if (existing !== undefined && !existing.stopped) { existing.refs += 1; return this.releaser(key, existing) }
    const entry = { refs: 1, stopped: false }
    this.opens += 1
    // The stream's first frame arrives a tick later and replaces the rows: a new array each time.
    queueMicrotask(() => { if (!entry.stopped) { this.rows.set(key, [{ id: 'bash-1', status: 'completed' }]); this.changed() } })
    this.entries.set(key, entry)
    return this.releaser(key, entry)
  }
  releaser(key, entry) {
    let released = false
    return () => {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs > 0) return
      if (this.entries.get(key) === entry) this.entries.delete(key)
      entry.stopped = true
      this.closes += 1
      queueMicrotask(() => { if (!this.entries.has(key)) { this.rows.delete(key); this.changed() } })
    }
  }
}

// The list: renders on every change; each render's effect stops the previous stream and starts one.
function mountList(jobs, sessionId, { rounds = 300 } = {}) {
  let renders = 0
  let stop = () => {}
  const render = () => {
    if (renders >= rounds) return
    renders += 1
    const watchRows = id => jobs.watchRows(id)   // a new function every render, as DSH's inject() returns
    void watchRows
    stop()
    stop = watchRows(sessionId)
  }
  jobs.listeners.add(render)
  render()
  return { renders: () => renders, unmount: () => { jobs.listeners.delete(render); stop() } }
}

const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise(resolve => setImmediate(resolve)) }
const boot = () => {
  const root = new Context()
  root.plugin(Jobs)
  return root
}

test('without the guard, a session with one job row restarts its row stream on every render, without end (DSH as shipped)', async () => {
  const root = boot()
  await settle()
  const jobs = root.get('jobs')
  const list = mountList(jobs, 'session-1')
  await settle()
  assert.ok(jobs.opens > 100, `the loop runs: ${jobs.opens} streams opened`)
  list.unmount()
})

test('with the guard, the stream opens once and the list renders only for the real change', async () => {
  const root = boot()
  await settle()
  const jobs = root.get('jobs')
  const restore = guardJobRows(jobs)
  const list = mountList(jobs, 'session-1')
  await settle()
  assert.equal(jobs.opens, 1, 'one stream')
  assert.equal(jobs.closes, 0)
  assert.ok(list.renders() <= 3, `renders ${list.renders()}`)
  assert.deepEqual(jobs.rows.get('session-1'), [{ id: 'bash-1', status: 'completed' }], 'the rows arrived')
  list.unmount()
  restore()
})

test('a real unmount stops the stream after the hold, a re-mount inside the hold keeps it, and restore puts DSH\'s function back', async () => {
  const root = boot()
  await settle()
  const jobs = root.get('jobs')
  const timers = []
  const fake = { setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer }, clearTimeout: timer => { if (timer) timer.cleared = true } }
  const restore = guardJobRows(jobs, { holdMs: 2_000, timers: fake })
  const first = jobs.watchRows('s')
  const second = jobs.watchRows('s')
  assert.equal(jobs.opens, 1, 'two users of one session share the stream')
  first()
  second()
  assert.equal(jobs.closes, 0, 'nothing stops at the last release: it is held')
  assert.equal(timers.at(-1).ms, 2_000)
  const again = jobs.watchRows('s')                       // the next render, inside the hold
  assert.equal(timers.at(-1).cleared, true, 'the hold is cancelled')
  assert.equal(jobs.opens, 1, 'no new stream')
  again()
  const pending = timers.at(-1)
  pending.fn()                                            // the hold runs out
  assert.equal(jobs.closes, 1, 'then the stream stops')
  const later = jobs.watchRows('s')
  assert.equal(jobs.opens, 2, 'and a later mount opens a new one')
  later()
  restore()
  assert.equal(jobs.closes, 2, 'restore stops what is still held')
  const open = jobs.opens
  jobs.watchRows('t')()
  assert.equal(jobs.opens, open + 1, 'DSH\'s own function answers again')
  assert.equal(jobs.closes, 3, 'and it releases at once, without a hold')
})

test('release twice is one release, and a service without watchRows is left alone', () => {
  const jobs = new Jobs(new Context())
  const restore = guardJobRows(jobs)
  const stop = jobs.watchRows('s')
  const other = jobs.watchRows('s')
  stop(); stop()
  assert.equal(jobs.closes, 0)
  other()
  restore()
  assert.equal(jobs.closes, 1)
  const bare = {}
  assert.equal(typeof guardJobRows(bare), 'function')
  assert.equal(bare.watchRows, undefined)
})

// fork.134 called the original on whatever `this` the wrapper met. Other plugins call `watchRows` on their own scope's
// proxy of the service (cordis's traceable proxy swaps `this` only for the proxy the method came from), so the host's
// method got a receiver it refuses ("Illegal invocation" on Windows) and the sidebar and the session header went with it.
// fork.134 called the original on the receiver of the wrapper's own call. Other plugins (better-sidebar, the session header)
// call `watchRows` through their own scope's proxy of the service, and a method taken from cordis's traceable proxy swaps
// `this` only for the proxy it was taken from; the original was then run on a receiver it did not expect and threw
// "Illegal invocation" on Windows, taking those plugins' views down with it. The original is called on `jobs`, always.
test('the original is called on the service the guard was given, whatever receiver the wrapper is called on', () => {
  const receivers = []
  const jobs = { watchRows() { receivers.push(this); return () => {} } }
  const restore = guardJobRows(jobs)
  const foreign = { watchRows: jobs.watchRows }
  foreign.watchRows('a')()                             // another plugin's proxy of the service as the receiver
  jobs.watchRows.call(undefined, 'b')()                // the method taken off the service and called bare
  jobs.watchRows.call({}, 'c')()
  assert.equal(receivers.length, 3)
  assert.ok(receivers.every(receiver => receiver === jobs), 'every call of the original was on the service the guard holds')
  restore()
})

// The defaults must call the browser's own timer functions bare: in a browser `window.setTimeout` refuses any other `this`
// ("Illegal invocation"), in Node it does not, so only a test that makes Node's globals as strict can see the difference.
// fork.134 and fork.135 kept `{ setTimeout, clearTimeout }` in an object and called `timers.clearTimeout(...)`.
test('the default timers call the global setTimeout and clearTimeout bare, as a browser requires', async () => {
  const strict = (name, real) => function (...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError(`Illegal invocation: ${name}`)
    return real.apply(globalThis, args)
  }
  const { setTimeout: realSet, clearTimeout: realClear } = globalThis
  globalThis.setTimeout = strict('setTimeout', realSet)
  globalThis.clearTimeout = strict('clearTimeout', realClear)
  try {
    const root = boot()
    await settle()
    const jobs = root.get('jobs')
    const restore = guardJobRows(jobs, { holdMs: 5 })        // the default timers
    const first = jobs.watchRows('s')                          // clearTimeout
    first()                                                    // setTimeout
    jobs.watchRows('s')()                                      // the next render
    await new Promise(resolve => realSet(resolve, 30))         // the hold runs out: the stream stops
    assert.equal(jobs.opens, 1)
    assert.equal(jobs.closes, 1)
    restore()
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
})
