// Approval audit: an append-only, local JSON-lines record of approvals opening and
// settling. It is a record only. No code reads it to allow, deny, resume or settle an
// approval; a missing, empty, torn or unwritable file changes no outcome.
//
// One record per line, built field by field (never a copy of the entry):
//   {v, ts, actor, session, fp, result?, phase}
// The command text, reason, detail, tool name and arguments, paths and errors are never
// written. `fp` is the approval fingerprint (approvals.js), a digest of identifiers and
// the open time.
//
// Only the host that may write the team (state.lock holder) appends; a read-only host
// writes nothing here. Appends and rotation run one at a time on a promise chain, and
// files are created 0700 (directory) / 0600 (file). Durability is the same as the rest of
// DS Bot: no fsync, so a process crash leaves complete lines plus at most one torn last
// line, which the reader skips and the writer starts after on a fresh line.
import fsp from 'node:fs/promises'
import { join } from 'node:path'

export const AUDIT_VERSION = 1
export const AUDIT_FILE = 'approval-audit.log'
export const AUDIT_DIR = 'audit'
// Size cap of the live file and how many files are kept in all (live + .1 + .2).
export const AUDIT_MAX_BYTES = 1024 * 1024
export const AUDIT_GENERATIONS = 3
const RESULTS = new Set(['allowed-once', 'rejected', 'cancelled'])
const PHASES = new Set(['open', 'settled'])

// The allowlisted projection of an approval entry (approvals.js). Only the Session id and
// the fingerprint are taken from the entry; anything not named here does not reach the file.
export function auditRecord({ ts, actor, entry, result, phase }) {
  if (!PHASES.has(phase)) throw new TypeError('audit phase must be open or settled')
  const record = {
    v: AUDIT_VERSION,
    ts: Number(ts),
    actor: typeof actor === 'string' && actor !== '' ? actor : 'unknown',
    session: String(entry?.sessionId ?? ''),
    fp: String(entry?.fingerprint ?? ''),
  }
  if (phase === 'settled') {
    if (!RESULTS.has(result)) throw new TypeError('audit result outside the outcome vocabulary')
    record.result = result
  }
  record.phase = phase
  return record
}

// Reads every kept generation, oldest first. A line that is not complete JSON (a torn
// tail after a crash) is skipped and counted, never repaired.
export async function readAudit(dir, { file = AUDIT_FILE, generations = AUDIT_GENERATIONS } = {}) {
  const records = []
  let skipped = 0
  for (let n = generations - 1; n >= 0; n -= 1) {
    let text
    try {
      text = await fsp.readFile(join(dir, n === 0 ? file : `${file}.${n}`), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const lines = text.split('\n')
    const last = lines.pop()
    if (last !== '') skipped += 1
    for (const line of lines) {
      if (line === '') continue
      try { records.push(JSON.parse(line)) } catch { skipped += 1 }
    }
  }
  return { records, skipped }
}

/**
 * @param {{dir:string, writable:()=>boolean, warn?:(...args:any[])=>void, maxBytes?:number, generations?:number, file?:string}} options
 */
export function createAuditWriter({ dir, writable, warn = () => {}, maxBytes = AUDIT_MAX_BYTES, generations = AUDIT_GENERATIONS, file = AUDIT_FILE }) {
  const path = join(dir, file)
  let writing = Promise.resolve()
  let checkedTail = false
  let warned = false
  const enabled = () => {
    try { return typeof dir === 'string' && dir !== '' && writable() === true } catch { return false }
  }
  const rotate = async () => {
    for (let n = generations - 1; n >= 1; n -= 1) {
      const from = n === 1 ? path : `${path}.${n - 1}`
      const to = `${path}.${n}`
      if (n === generations - 1) await fsp.rm(to, { force: true })
      try {
        await fsp.rename(from, to)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    if (generations <= 1) await fsp.rm(path, { force: true })
  }
  const appendLine = async (line) => {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    let size = 0
    let lastByte
    try {
      const stat = await fsp.stat(path)
      size = stat.size
      if (!checkedTail && size > 0) {
        const handle = await fsp.open(path, 'r')
        try {
          const { bytesRead, buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1)
          if (bytesRead === 1) lastByte = buffer[0]
        } finally {
          await handle.close()
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    let text = line
    if (!checkedTail && lastByte !== undefined && lastByte !== 0x0a) text = `\n${text}`
    checkedTail = true
    if (size > 0 && size + Buffer.byteLength(text) > maxBytes) {
      await rotate()
      text = line
    }
    const handle = await fsp.open(path, 'a', 0o600)
    try {
      await handle.write(text)
    } finally {
      await handle.close()
    }
  }
  // Resolves 'recorded' or 'unaudited'; never rejects.
  const append = (fields) => {
    if (!enabled()) return Promise.resolve('unaudited')
    let line
    try {
      line = `${JSON.stringify(auditRecord(fields))}\n`
    } catch (error) {
      warn('ds-bot: approval audit unavailable (%s)', 'EINVAL')
      return Promise.resolve('unaudited')
    }
    const run = writing.then(() => appendLine(line)).then(
      () => 'recorded',
      (error) => {
        if (!warned) {
          warned = true
          warn('ds-bot: approval audit unavailable (%s)', typeof error?.code === 'string' ? error.code : 'EIO')
        }
        return 'unaudited'
      },
    )
    writing = run
    return run
  }
  return { append, enabled, path, idle: () => writing }
}
