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
// Two rules from fork.134, which broke every other plugin's use of `jobs` on Windows ("Illegal invocation"):
//  - The method we wrap came out of cordis's traceable proxy of `jobs`, which swaps a method's `this` for its own shadow
//    only when it is called on that same proxy. Other plugins call `watchRows` on their own scope's proxy, so the
//    receiver of OUR wrapper is not the one the original wants: the original is always called on the `jobs` we were given.
//  - Whatever the original does that we did not expect, the guard stands down: it puts DSH's function back and the call
//    that met the surprise is answered by DSH's own, so a plugin's job list is never worse off for our being there.
export const ROWS_HOLD_MS = 2_000

/**
 * Wrap `jobs.watchRows` (DSH's client jobs service). Returns the function that puts the original back and stops every
 * stream still held.
 */
export function guardJobRows(jobs, { holdMs = ROWS_HOLD_MS, timers = { setTimeout, clearTimeout } } = {}) {
  if (typeof jobs?.watchRows !== 'function') return () => {}
  const original = jobs.watchRows
  const hadOwn = Object.prototype.hasOwnProperty.call(jobs, 'watchRows')
  const held = new Map()
  let standingDown = false
  const stop = (key, entry) => {
    if (held.get(key) === entry) held.delete(key)
    entry.timer = undefined
    try { entry.release() } catch { /* the stream is gone already */ }
  }
  const restore = () => {
    try {
      if (hadOwn) jobs.watchRows = original
      else delete jobs.watchRows
    } catch { /* the service is gone */ }
    for (const [key, entry] of held) { timers.clearTimeout(entry.timer); stop(key, entry) }
  }
  jobs.watchRows = function watchRows(sessionId) {
    if (standingDown) return original.call(jobs, sessionId)
    const key = String(sessionId)
    let entry = held.get(key)
    if (entry === undefined) {
      let release
      try {
        release = original.call(jobs, sessionId)
      } catch {
        // Not what we expected of the original: DSH's own answers this call (and throws what it throws), and from here on
        // every call is DSH's own.
        standingDown = true
        restore()
        return jobs.watchRows(sessionId)
      }
      entry = { refs: 0, timer: undefined, release }
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
  return restore
}
