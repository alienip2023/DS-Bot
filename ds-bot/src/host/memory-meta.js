import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FLUSH_MS = 60_000
const INBOX_MAX = 1_000
const INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sequence = value => Number.isInteger(value) && value >= 0 ? value : 0

export function createMemoryMeta({ home, warn = () => {} }) {
  const dir = join(home, 'memory', '_meta')
  const federationPath = join(dir, 'federation.json')
  const inboxPath = join(dir, 'inbox.jsonl')
  const data = { seq: 0, nodes: {}, inbox: {} }
  let loaded = false
  let dirty = false
  let timer
  let inboxLines = 0
  let oldest = Infinity

  function read(path) {
    try { return readFileSync(path, 'utf8') } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return ''
    }
  }

  function atomic(path, body) {
    mkdirSync(dir, { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(temp, body, 'utf8')
      renameSync(temp, path)
    } finally {
      rmSync(temp, { force: true })
    }
  }

  function cancelTimer() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function flush({ immediate = false } = {}) {
    if (immediate) {
      cancelTimer()
      if (!dirty) return
      atomic(federationPath, JSON.stringify({ schemaVersion: 2, seq: data.seq, nodes: data.nodes }) + '\n')
      dirty = false
    } else if (dirty && timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined
        try { flush({ immediate: true }) } catch (error) { warn('memory metadata flush failed: %s', error?.message ?? error) }
      }, FLUSH_MS)
      timer.unref?.()
    }
  }

  function changed() {
    dirty = true
    flush({ immediate: false })
  }

  const row = ([key, entry]) => ({ key, at: entry.at, result: entry.frame })
  const survivors = inbox => Object.entries(inbox)
    .filter(([, entry]) => object(entry) && Number.isFinite(entry.at) && entry.at >= Date.now() - INBOX_TTL_MS && object(entry.frame))
    .sort((a, b) => a[1].at - b[1].at)
    .slice(-INBOX_MAX)
    .reverse()

  function rewriteInbox(entries) {
    atomic(inboxPath, entries.map(entry => JSON.stringify(row(entry)) + '\n').join(''))
    inboxLines = entries.length
    oldest = entries.at(-1)?.[1].at ?? Infinity
  }

  function cleanInbox() {
    const cutoff = Date.now() - INBOX_TTL_MS
    const entries = survivors(data.inbox)
    const removed = Object.keys(data.inbox).length - entries.length
    const keep = new Set(entries.map(([key]) => key))
    for (const key of Object.keys(data.inbox)) if (!keep.has(key)) delete data.inbox[key]
    if (removed > 0 || inboxLines > INBOX_MAX || oldest < cutoff) {
      rewriteInbox(entries)
    }
    return removed
  }

  function load() {
    if (loaded) return data
    const text = read(federationPath)
    if (text !== '') {
      try {
        const stored = JSON.parse(text)
        data.seq = sequence(stored.seq)
        if (object(stored.nodes)) data.nodes = stored.nodes
      } catch (error) { warn('memory metadata could not be read: %s', error?.message ?? error) }
    }
    for (const line of read(inboxPath).split('\n').filter(Boolean)) {
      inboxLines += 1
      try {
        const entry = JSON.parse(line)
        if (typeof entry.key !== 'string' || !Number.isFinite(entry.at) || !object(entry.result)) continue
        Object.defineProperty(data.inbox, entry.key, { value: { at: entry.at, frame: entry.result }, enumerable: true, configurable: true, writable: true })
        oldest = Math.min(oldest, entry.at)
      } catch (error) { warn('memory inbox line could not be read: %s', error?.message ?? error) }
    }
    cleanInbox()
    loaded = true
    return data
  }

  function nodeRecord(nodeId) {
    if (!Object.hasOwn(data.nodes, nodeId) || !object(data.nodes[nodeId])) {
      Object.defineProperty(data.nodes, nodeId, { value: {}, enumerable: true, configurable: true, writable: true })
    }
    const record = data.nodes[nodeId]
    record.lastSeq = sequence(record.lastSeq)
    record.sentSeq = sequence(record.sentSeq)
    changed()
    return record
  }

  function remember(key, entry) {
    mkdirSync(dir, { recursive: true })
    appendFileSync(inboxPath, JSON.stringify(row([key, entry])) + '\n', 'utf8')
    Object.defineProperty(data.inbox, key, { value: entry, enumerable: true, configurable: true, writable: true })
    inboxLines += 1
    oldest = Math.min(oldest, entry.at)
    cleanInbox()
  }

  // A crash between the sidecar write and clearing state may repeat this import.
  // Prefer the sidecar on ties, and only persist values that actually changed.
  function importLegacy(legacy) {
    const before = JSON.stringify({ seq: data.seq, nodes: data.nodes })
    data.seq = Math.max(data.seq, sequence(legacy.seq))
    for (const [id, old] of Object.entries(object(legacy.nodes) ? legacy.nodes : {})) {
      if (!object(old)) continue
      const current = Object.hasOwn(data.nodes, id) ? { ...data.nodes[id] } : undefined
      const record = nodeRecord(id)
      Object.assign(record, old, current)
      record.lastSeq = Math.max(sequence(old.lastSeq), sequence(current?.lastSeq))
      record.sentSeq = Math.max(sequence(old.sentSeq), sequence(current?.sentSeq))
    }
    const oldInbox = object(legacy.inbox) ? legacy.inbox : {}
    const combined = { ...oldInbox, ...data.inbox }
    for (const [key, entry] of Object.entries(oldInbox)) {
      if (!object(entry)) continue
      const current = Object.hasOwn(data.inbox, key) ? data.inbox[key] : undefined
      if (current === undefined || current.at < entry.at) Object.defineProperty(combined, key, { value: entry, enumerable: true, configurable: true, writable: true })
    }
    const entries = survivors(combined)
    if (entries.length !== Object.keys(data.inbox).length || entries.some(([key, entry]) => JSON.stringify(data.inbox[key]) !== JSON.stringify(entry))) {
      rewriteInbox(entries)
      data.inbox = Object.fromEntries([...entries].reverse())
    }
    dirty = before !== JSON.stringify({ seq: data.seq, nodes: data.nodes }) || read(federationPath) === ''
    flush({ immediate: true })
  }

  return {
    load,
    view: () => data,
    seq: () => data.seq,
    bumpSeq: () => { data.seq += 1; changed() },
    nodeRecord,
    remember,
    lookup: key => {
      const entry = Object.hasOwn(data.inbox, key) ? data.inbox[key] : undefined
      return object(entry) && Number.isFinite(entry.at) && entry.at >= Date.now() - INBOX_TTL_MS ? entry : undefined
    },
    cleanInbox,
    importLegacy,
    noteChanged: () => { dirty = true; flush({ immediate: true }) },
    flush,
    appendJournal: line => {
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify(line) + '\n', 'utf8')
    },
    close: cancelTimer,
  }
}
