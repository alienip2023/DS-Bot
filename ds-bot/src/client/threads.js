// threads.js — the sidebar's Thread cache, one slot per Bot.
//
// The Thread list is read from the host (`threads {botId}`) the first time a Bot is
// expanded; creating a Thread goes through the same store so the row appears without a
// second round trip. Loading keeps the previous list on failure, so a transient error
// does not blank the sidebar.
import { call } from './api.js'

const IDLE = Object.freeze({ status: 'idle', threads: [], error: undefined, loadedAt: 0 })

/** A store with its own request function, for tests; the app uses the shared one below. */
export function createThreadsStore({ request = call } = {}) {
  const byBot = new Map()
  const inflight = new Map()
  const listeners = new Set()
  let version = 0

  const slotOf = (botId) => {
    let slot = byBot.get(botId)
    if (slot === undefined) {
      slot = { ...IDLE }
      byBot.set(botId, slot)
    }
    return slot
  }

  const publish = (botId, next) => {
    byBot.set(botId, next)
    version += 1
    for (const fn of listeners) fn()
  }

  const subscribe = (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  // The snapshot a row subscribes to is its Bot's slot object; a publish replaces it.
  const slot = (botId) => slotOf(botId)
  const getSnapshot = () => version

  const load = (botId, { force = false } = {}) => {
    const current = slotOf(botId)
    if (force !== true && (current.status === 'ready' || current.status === 'loading')) return Promise.resolve(current)
    const pending = inflight.get(botId)
    if (pending !== undefined) return pending
    publish(botId, { ...current, status: 'loading', error: undefined })
    const loading = (async () => {
      try {
        const result = await request('threads', { botId })
        const threads = Array.isArray(result?.threads) ? result.threads : []
        const next = { status: 'ready', threads, error: undefined, loadedAt: Date.now() }
        publish(botId, next)
        return next
      } catch (error) {
        const next = { ...slotOf(botId), status: 'error', error }
        publish(botId, next)
        return next
      } finally {
        inflight.delete(botId)
      }
    })()
    inflight.set(botId, loading)
    return loading
  }

  const create = async (botId) => {
    const result = await request('thread-create', { botId })
    const thread = result?.thread
    if (thread !== undefined && thread !== null) {
      const current = slotOf(botId)
      const threads = current.threads.some(row => row?.id === thread.id) ? current.threads : [...current.threads, thread]
      publish(botId, { ...current, status: current.status === 'idle' ? 'ready' : current.status, threads })
    }
    return result
  }

  const get = (threadId) => {
    for (const slot of byBot.values()) {
      const thread = slot.threads.find(row => row?.id === threadId)
      if (thread !== undefined) return thread
    }
    return undefined
  }

  const reset = () => {
    byBot.clear()
    inflight.clear()
    version += 1
    for (const fn of listeners) fn()
  }

  return { subscribe, getSnapshot, slot, load, create, get, reset }
}

export const threadsStore = createThreadsStore()
