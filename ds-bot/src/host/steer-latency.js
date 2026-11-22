// steer-latency.js — how long a steer waits before the Bot reads it.
//
// A steer joins the turn that is running and is read at that turn's next step boundary (or at once, when
// it cuts a model call). How long that takes depends on what the Bot is doing when it arrives: a short
// step is read in about a second, a long tool call holds it until the call ends. Nothing here changes
// that; it measures it, so the real distribution is known instead of guessed:
//   · every steer that was read is appended to logs/steer-latency.jsonl (time, wait, what the Bot was doing)
//   · one that is still unread after SLOW_MS is reported once in the diagnostics log, with what holds it
//   · rt.steerLatencyStats() gives the recent numbers (count, median, p90, max, slow, unread)
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const SLOW_MS = 10_000
const GIVE_UP_MS = 600_000
const KEEP = 200
const FILE_MAX_BYTES = 1_048_576

export function install(rt) {
  const { ctx } = rt
  if (typeof ctx?.on !== 'function') return
  /** message id → what the Bot was doing when the steer arrived */
  const pending = new Map()
  const recent = []
  const file = rt.home === undefined ? undefined : join(rt.home, 'logs', 'steer-latency.jsonl')
  const slowMs = () => (Number.isFinite(rt.steerSlowMs) ? rt.steerSlowMs : SLOW_MS)

  const append = (record) => {
    if (file === undefined) return
    try {
      mkdirSync(join(rt.home, 'logs'), { recursive: true })
      try { if (statSync(file).size > FILE_MAX_BYTES) renameSync(file, `${file}.1`) } catch { /* no file yet */ }
      appendFileSync(file, `${JSON.stringify(record)}\n`)
    } catch { /* measuring must never get in the way */ }
  }
  const hold = (sessionId) => {
    const entry = rt.live?.get?.(sessionId)
    const calls = entry?.calls?.size ?? 0
    return { phase: rt.steerPhaseOf?.(sessionId) ?? 'unknown', calls, jobs: rt.runningJobs?.(sessionId)?.length ?? 0 }
  }
  const finish = (id, outcome, at) => {
    const item = pending.get(id)
    if (item === undefined) return
    pending.delete(id)
    clearTimeout(item.slowTimer)
    clearTimeout(item.giveUp)
    const waitMs = Math.max(0, at - item.at)
    const record = { time: item.at, sessionId: item.sessionId, botId: item.botId, waitMs, outcome, ...item.hold, slow: item.slow === true || waitMs >= slowMs() }
    recent.push(record)
    if (recent.length > KEEP) recent.shift()
    append(record)
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (sessionId === undefined) return
    if (event.type === 'agent/inbox/spliced' && event.data?.target === 'next-step') {
      for (const message of event.data.inserted ?? []) {
        if (message?.source?.kind !== 'user' || typeof message.id !== 'string' || pending.has(message.id)) continue
        const item = { sessionId, botId: rt.chatOwners?.get?.(sessionId), at: event.time ?? Date.now(), hold: hold(sessionId) }
        item.slowTimer = setTimeout(() => {
          if (!pending.has(message.id)) return
          item.slow = true
          const now = hold(sessionId)
          rt.warn?.('ds-bot: a steer into %s has waited %ds unread (the Bot is in %s with %d tool call(s) and %d job(s) running)', sessionId, Math.round(slowMs() / 1000), now.phase, now.calls, now.jobs)
        }, slowMs())
        item.giveUp = setTimeout(() => finish(message.id, 'unread', Date.now()), GIVE_UP_MS)
        item.slowTimer.unref?.()
        item.giveUp.unref?.()
        pending.set(message.id, item)
        if (pending.size > KEEP) finish(pending.keys().next().value, 'evicted', Date.now())
      }
    } else if (event.type === 'user/message' && pending.has(event.data?.id)) {
      finish(event.data.id, 'read', event.time ?? Date.now())
    }
  })

  rt.steerLatencyStats = () => {
    const waits = recent.filter(record => record.outcome === 'read').map(record => record.waitMs).sort((a, b) => a - b)
    const at = p => (waits.length === 0 ? null : waits[Math.min(waits.length - 1, Math.floor(p * waits.length))])
    return { count: waits.length, medianMs: at(0.5), p90Ms: at(0.9), maxMs: waits.at(-1) ?? null, slow: recent.filter(record => record.slow).length, unread: pending.size }
  }
}
