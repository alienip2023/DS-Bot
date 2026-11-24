// work-ledger.js — 主控工作账本（Phase 3）。
//
// 把跨机器的一切"要有结果的事"记为 assignment：
//   Bot 间交接、远端回合、后台任务、routine 运行、审批请求。
//
// 存储：主控 append-only <home>/work-ledger.jsonl + 定期快照。
// 单写者；不再只在内存（修复现状 hub 任务只在内存、靠节点重建）。
//
// assignment 状态机：
//   queued → running → (waiting | away) → done | failed | cancelled
//
// away：目标机器离线时进入，不计任何超时（OpenMausBot bot-link 做法）。
//   机器回来自动续发。
//
// 崩溃重跑规则（§9.2）：
//   - 回合未产生对外动作 → 原地重跑一次
//   - 已产生对外动作 → 不重跑，标 failed(interrupted)
//   - 已派出子任务 → 转 waiting

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const ASSIGNMENT_KIND = Object.freeze({
  HANDOFF: 'handoff',      // Bot 间交接
  REMOTE_TURN: 'remote-turn', // 远端回合
  BACKGROUND: 'background',   // 后台任务
  ROUTINE: 'routine',      // routine 运行
  APPROVAL: 'approval',    // 审批请求
})

export const ASSIGNMENT_STATE = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING: 'waiting',
  AWAY: 'away',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

const TERMINAL_STATES = new Set([ASSIGNMENT_STATE.DONE, ASSIGNMENT_STATE.FAILED, ASSIGNMENT_STATE.CANCELLED])

/** Is this assignment in a terminal state? */
export const isTerminal = a => TERMINAL_STATES.has(a?.state)

/**
 * Create a new work ledger.
 * @param {object} opts
 * @param {string} opts.home  DS Bot home directory (ledger stored here)
 * @param {function} [opts.now]  clock, defaults to Date.now
 */
export function createWorkLedger({ home, now = Date.now }) {
  const dir = home
  const ledgerFile = join(dir, 'work-ledger.jsonl')
  const snapshotFile = join(dir, 'work-ledger.snapshot.json')

  /** @type {Map<string, object>} in-memory assignment map */
  const assignments = new Map()
  let seq = 0

  // ── Persistence ────────────────────────────────────────────────────────────

  function appendRecord(record) {
    try {
      appendFileSync(ledgerFile, JSON.stringify(record) + '\n', 'utf8')
    } catch (err) {
      // Non-fatal: in-memory state is authoritative; log loss means replay gap only.
      // A future hardening pass adds write retries and torn-tail recovery.
    }
  }

  function writeSnapshotNow() {
    try {
      writeFileSync(snapshotFile, JSON.stringify({ seq, assignments: [...assignments.values()] }, null, 0), 'utf8')
    } catch { /* non-fatal */ }
  }

  /** Load from snapshot + replay ledger tail. */
  function load() {
    let startSeq = 0
    if (existsSync(snapshotFile)) {
      try {
        const snap = JSON.parse(readFileSync(snapshotFile, 'utf8'))
        startSeq = snap.seq ?? 0
        seq = startSeq
        for (const a of Array.isArray(snap.assignments) ? snap.assignments : []) {
          if (a?.id) assignments.set(a.id, a)
        }
      } catch { /* corrupt snapshot — replay from scratch */ }
    }
    if (!existsSync(ledgerFile)) return
    try {
      const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const rec = JSON.parse(line)
          if (typeof rec.seq !== 'number' || rec.seq <= startSeq) continue
          applyRecord(rec)
          if (rec.seq > seq) seq = rec.seq
        } catch { /* torn line */ }
      }
    } catch { /* file missing or unreadable */ }
  }

  function applyRecord(rec) {
    if (rec.type === 'upsert' && rec.assignment) {
      assignments.set(rec.assignment.id, rec.assignment)
    } else if (rec.type === 'delete' && rec.id) {
      assignments.delete(rec.id)
    }
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  /**
   * Create a new assignment.
   * @param {object} o
   * @param {string} o.kind    One of ASSIGNMENT_KIND
   * @param {string} o.from    Sender identityId or botId
   * @param {string} o.to      Recipient identityId
   * @param {object} o.payload Arbitrary payload
   * @param {number} [o.epoch] Execution epoch from lease
   */
  function create({ kind, from, to, payload = {}, epoch = 1 }) {
    const id = randomUUID()
    const at = now()
    const assignment = {
      id, kind, from, to, payload,
      state: ASSIGNMENT_STATE.QUEUED,
      epoch,
      attempts: 0,
      effects: [],
      createdAt: at,
      updatedAt: at,
    }
    assignments.set(id, assignment)
    seq += 1
    appendRecord({ seq, type: 'upsert', assignment, at })
    return assignment
  }

  /**
   * Transition an assignment to a new state.
   * @param {string} id
   * @param {string} newState  One of ASSIGNMENT_STATE
   * @param {object} [update]  Additional fields to merge
   */
  function transition(id, newState, update = {}) {
    const a = assignments.get(id)
    if (!a) return undefined
    if (isTerminal(a)) return a  // terminal states are immutable
    const updated = { ...a, ...update, state: newState, updatedAt: now() }
    if (newState === ASSIGNMENT_STATE.RUNNING) updated.attempts = (a.attempts ?? 0) + 1
    assignments.set(id, updated)
    seq += 1
    appendRecord({ seq, type: 'upsert', assignment: updated, at: updated.updatedAt })
    return updated
  }

  /** Record that an external effect was produced (prevents automatic re-run on crash). */
  function recordEffect(id, effect) {
    const a = assignments.get(id)
    if (!a) return undefined
    const effects = [...(a.effects ?? []), { effect, at: now() }]
    const updated = { ...a, effects, updatedAt: now() }
    assignments.set(id, updated)
    seq += 1
    appendRecord({ seq, type: 'upsert', assignment: updated, at: updated.updatedAt })
    return updated
  }

  /** Mark assignment as away (target machine offline). Does not start timeout. */
  function markAway(id) { return transition(id, ASSIGNMENT_STATE.AWAY) }

  /** Resume from away when machine comes back. */
  function resume(id) {
    const a = assignments.get(id)
    if (!a || a.state !== ASSIGNMENT_STATE.AWAY) return undefined
    return transition(id, ASSIGNMENT_STATE.QUEUED)
  }

  /** Apply crash-restart rules: re-queue if no external effects, else fail. */
  function applyRestartRules(id) {
    const a = assignments.get(id)
    if (!a || a.state !== ASSIGNMENT_STATE.RUNNING) return undefined
    if (a.effects && a.effects.length > 0) {
      return transition(id, ASSIGNMENT_STATE.FAILED, { reason: 'interrupted-with-effects' })
    }
    // First run (attempts=1) crashes → re-queue. Second run (attempts=2) crashes → fail.
    if ((a.attempts ?? 0) >= 2) {
      return transition(id, ASSIGNMENT_STATE.FAILED, { reason: 'interrupted-no-retry' })
    }
    return transition(id, ASSIGNMENT_STATE.QUEUED)
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  const all = () => [...assignments.values()]
  const byId = id => assignments.get(id)
  const pending = () => all().filter(a => !isTerminal(a))
  const awayFor = toId => all().filter(a => a.to === toId && a.state === ASSIGNMENT_STATE.AWAY)

  // ── Maintenance ────────────────────────────────────────────────────────────

  /** Delete terminal assignments older than maxAgeMs. Called periodically. */
  function prune(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = now() - maxAgeMs
    let pruned = 0
    for (const [id, a] of assignments) {
      if (isTerminal(a) && a.updatedAt < cutoff) {
        assignments.delete(id)
        seq += 1
        appendRecord({ seq, type: 'delete', id, at: now() })
        pruned += 1
      }
    }
    if (pruned > 0) writeSnapshotNow()
    return pruned
  }

  // Load on creation.
  load()

  return {
    create, transition, recordEffect, markAway, resume, applyRestartRules,
    all, byId, pending, awayFor, prune, snapshot: writeSnapshotNow,
    QUEUED: ASSIGNMENT_STATE.QUEUED, RUNNING: ASSIGNMENT_STATE.RUNNING,
    WAITING: ASSIGNMENT_STATE.WAITING, AWAY: ASSIGNMENT_STATE.AWAY,
    DONE: ASSIGNMENT_STATE.DONE, FAILED: ASSIGNMENT_STATE.FAILED, CANCELLED: ASSIGNMENT_STATE.CANCELLED,
  }
}
