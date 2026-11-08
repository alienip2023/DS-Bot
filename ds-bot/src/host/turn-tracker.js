// turn-tracker.js — in-memory turn lifecycle tracker.
// No UI writes, no events. Pure state machine for turn status.

/**
 * @typedef {{
 *   turnId: string,
 *   botId: string,
 *   status: 'pending' | 'done' | 'failed' | 'timeout',
 *   error?: string,
 *   startedAt: number,
 *   finishedAt?: number,
 * }} TurnEntry
 */

export function createTurnTracker() {
  /** @type {Map<string, TurnEntry>} */
  const turns = new Map()

  function start(turnId, botId) {
    turns.set(turnId, {
      turnId,
      botId,
      status: 'pending',
      startedAt: Date.now(),
    })
  }

  function finish(turnId, { status, error } = {}) {
    const entry = turns.get(turnId)
    if (!entry) return false
    entry.status = status ?? 'done'
    if (error) entry.error = error
    entry.finishedAt = Date.now()
    return true
  }

  function get(turnId) {
    return turns.get(turnId)
  }

  /**
   * Sweep timed-out turns. Returns array of timed-out turnIds.
   * @param {number} now - current timestamp (ms)
   * @param {number} timeoutMs - timeout threshold
   */
  function sweep(now = Date.now(), timeoutMs = 120_000) {
    const timedOut = []
    for (const [turnId, entry] of turns) {
      if (entry.status === 'pending' && (now - entry.startedAt) >= timeoutMs) {
        entry.status = 'timeout'
        entry.error = 'E_TIMEOUT'
        entry.finishedAt = now
        timedOut.push(turnId)
      }
    }
    return timedOut
  }

  function clear(turnId) {
    return turns.delete(turnId)
  }

  function size() {
    return turns.size
  }

  return { start, finish, get, sweep, clear, size }
}
