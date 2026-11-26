// DSH's job list (dsh-client-ui-jobs 0.2.2-rc.5) keeps a session's job rows current with
//   useEffect(() => watchRows(sessionId), [sessionId, watchRows])
// where `watchRows` is a fresh arrow function on every render. So every render stops the row stream and opens a new
// one; the new stream's first frame replaces the rows, which renders again. While a session has even one job row
// (a finished `bash` job is enough) this runs without end: seen on the host at 2,270 `job/list` streams a second for
// one Bot's open session, 45-60 % of a core in the host and a busy renderer, so everything else, a history page above
// all, waits in line and times out ("历史加载失败").
//
// The stream is ref-counted by DSH's client service, so we keep the one we have for a moment after its last
// release. The stop/start pair of a re-render then finds the stream still open, nothing is replaced, nothing renders
// again, and the cycle has nothing to feed on. A real unmount still stops the stream, `holdMs` later.
//
// Two rules (fork.134 and fork.135 broke the sidebar and the session header's job button with "TypeError: Illegal
// invocation" in the renderer while every test passed):
//  - The browser's setTimeout/clearTimeout must be called with `window` (or nothing) as `this`. Kept in a plain object and
//    called as `timers.clearTimeout(...)` they throw in a browser and work in Node, which is where the tests run. The
//    defaults are arrow functions that call the globals bare, and a test makes the globals refuse any other `this`.
//  - The original is called on the `jobs` we were given, not on the receiver of the wrapper's own call.
export const ROWS_HOLD_MS = 2_000

// The globals called bare, as a browser requires; looked up when a timer is set, not when the module loads.
const browserTimers = () => ({
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle),
})

/**
 * Wrap `jobs.watchRows` (DSH's client jobs service). Returns the function that puts the original back and stops every
 * stream still held.
 */
export function guardJobRows(jobs, { holdMs = ROWS_HOLD_MS, timers = browserTimers() } = {}) {
  if (typeof jobs?.watchRows !== 'function') return () => {}
  const original = jobs.watchRows
  const hadOwn = Object.prototype.hasOwnProperty.call(jobs, 'watchRows')
  const held = new Map()
  const stop = (key, entry) => {
    if (held.get(key) === entry) held.delete(key)
    entry.timer = undefined
    entry.release()
  }
  jobs.watchRows = function watchRows(sessionId) {
    const key = String(sessionId)
    let entry = held.get(key)
    if (entry === undefined) {
      entry = { refs: 0, timer: undefined, release: original.call(jobs, sessionId) }
      held.set(key, entry)
    }
    timers.clearTimeout(entry.timer)
    entry.timer = undefined
    entry.refs += 1
    const mine = entry
    let released = false
    return () => {
      if (released) return
      released = true
      mine.refs -= 1
      if (mine.refs > 0 || held.get(key) !== mine) return
      mine.timer = timers.setTimeout(() => { if (mine.refs === 0) stop(key, mine) }, holdMs)
      mine.timer?.unref?.()
    }
  }
  return () => {
    if (hadOwn) jobs.watchRows = original
    else delete jobs.watchRows
    for (const [key, entry] of held) { timers.clearTimeout(entry.timer); stop(key, entry) }
  }
}
