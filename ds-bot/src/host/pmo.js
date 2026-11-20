// P3 PMO 四件（吸收书 1-G planDispatch / planTaskNudges / planIdleRetry / planIdleStaffing）。
//
// 设计：
//   planDispatch       — 检查活跃任务的责任人是否在回合里，不在则补派（TTL + 次数限制）。
//   planTaskNudges     — 对单张活跃卡给出应发的提醒（heartbeat/escalate/stall）。
//   planIdleRetry      — 看板空时指数退避续开（防止空转暴力重试）。
//   planIdleStaffing   — 看板有活但空闲成员非空时，把待办一人一张发出去。
//
// 所有函数都是纯决策函数：接受当前状态 + 时钟，返回"应做什么"的计划列表。
// 不直接 deliver，让调用方（goals.js / install）决定何时执行。
//
// 时间常量（与吸收书对齐）：
const PMO_DISPATCH_INTERVAL_MS = 60_000       // 两次补派之间最短间隔
const PMO_DISPATCH_LIMIT = 3                   // 同一张卡最多补派 3 次
const PMO_HEARTBEAT_MS = 5 * 60_000           // 5 分钟无进展 → heartbeat
const PMO_ESCALATE_MS = 15 * 60_000           // 15 分钟无进展 → escalate
const PMO_STALL_MS = 30 * 60_000              // 30 分钟无状态变化 → stall
const PMO_IDLE_RETRY_BASE_MS = 10 * 60_000    // 指数退避基数 10 分钟
const PMO_IDLE_RETRY_MAX_MS = 8 * 60 * 60_000 // 最大 8 小时
const PMO_STAFFING_SIGN_TTL_MS = 2 * 60 * 60_000 // 派活签名 TTL 2 小时

const OPEN_STATUSES = new Set(['active', 'review', 'blocked'])

function tasksOf(room) {
  return Object.values(room?.tasks ?? {})
}

function openTasksOf(room) {
  return tasksOf(room).filter(t => OPEN_STATUSES.has(t.status))
}

/**
 * planDispatch：检查活跃卡的责任人是否正在回合里；不在则安排补派。
 *
 * 判定"在回合里"：传入 isInTurn(botId) 函数（由调用方提供，查 live Map）。
 *
 * @param {object} room
 * @param {object} opts
 * @param {function} opts.isInTurn       (botId) => boolean
 * @param {function} [opts.now]          () => number，默认 Date.now
 * @returns {Array<{kind:'dispatch', taskId, botId, reason}>}
 */
export function planDispatch(room, { isInTurn, now = Date.now } = {}) {
  const plans = []
  const t = now()
  for (const task of openTasksOf(room)) {
    if (isInTurn?.(task.botId)) continue
    const dispatches = task._dispatches ?? 0
    const lastDispatch = task._lastDispatchAt ?? 0
    if (dispatches >= PMO_DISPATCH_LIMIT) continue
    if (t - lastDispatch < PMO_DISPATCH_INTERVAL_MS) continue
    plans.push({ kind: 'dispatch', taskId: task.id, botId: task.botId, reason: `dispatch attempt ${dispatches + 1}/${PMO_DISPATCH_LIMIT}` })
  }
  return plans
}

/**
 * 把补派计划应用到 task 对象上（更新 _dispatches / _lastDispatchAt）。
 * 调用方在 deliver 成功后调用。
 */
export function applyDispatch(task, now = Date.now()) {
  task._dispatches = (task._dispatches ?? 0) + 1
  task._lastDispatchAt = now
}

/**
 * planTaskNudges：对单张活跃卡给出应发的提醒级别。
 *
 * 双时钟设计（防止成员刷回帖绕过失速检测）：
 *   threadIdle = 自上次 Thread 更新以来的毫秒数
 *   stateIdle  = 自上次任务状态/进度变化以来的毫秒数
 *
 * @param {object} task
 * @param {object} opts
 * @param {number} opts.threadIdleMs   自上次 Thread 更新以来的毫秒数
 * @param {number} opts.stateIdleMs    自上次状态变化以来的毫秒数
 * @returns {'heartbeat'|'escalate'|'stall'|null}
 */
export function planTaskNudges(task, { threadIdleMs, stateIdleMs } = {}) {
  if (!task || !OPEN_STATUSES.has(task.status)) return null
  const threadIdle = Number(threadIdleMs) || 0
  const stateIdle = Number(stateIdleMs) || 0
  // stall 优先（双时钟都看 stateIdle，单 Thread 刷新不算有效进展）
  if (stateIdle >= PMO_STALL_MS) return 'stall'
  if (stateIdle >= PMO_ESCALATE_MS || threadIdle >= PMO_ESCALATE_MS) return 'escalate'
  if (threadIdle >= PMO_HEARTBEAT_MS) return 'heartbeat'
  return null
}

/**
 * planIdleRetry：看板空、PMO 检查过局面（pmoChecked=true）但仍无人在回合时，
 * 计算下一次重试的等待时间（指数退避）。
 *
 * @param {object} room
 * @param {object} opts
 * @param {boolean} opts.pmoChecked    PMO 是否看过这个空板
 * @param {number}  [opts.retryCount]  已重试次数（0 = 首次）
 * @param {function} [opts.now]
 * @returns {{ shouldRetry: boolean, delayMs: number, retryCount: number }}
 */
export function planIdleRetry(room, { pmoChecked = false, retryCount = 0, now = Date.now } = {}) {
  const hasOpenTasks = openTasksOf(room).length > 0
  if (hasOpenTasks) return { shouldRetry: false, delayMs: 0, retryCount }
  if (!pmoChecked) return { shouldRetry: true, delayMs: 0, retryCount: 0 }
  // 指数退避：10min × 2^(n-1)，封顶 8 小时
  const delay = retryCount === 0 ? 0 : Math.min(PMO_IDLE_RETRY_BASE_MS * Math.pow(2, retryCount - 1), PMO_IDLE_RETRY_MAX_MS)
  return { shouldRetry: true, delayMs: delay, retryCount: retryCount + 1 }
}

/**
 * planIdleStaffing：看板有活但有空闲成员时，把可认领的待办发给空闲成员。
 *
 * 签名机制（防同一局面重复叫 PMO）：
 *   sign = hash(成员快照 + 任务快照)
 *   如果 sign 和上次一样且未超 TTL，跳过。
 *
 * @param {object} room
 * @param {object} opts
 * @param {function} opts.isInTurn      (botId) => boolean，当前有活儿的成员
 * @param {string}  [opts.lastSign]     上次签名
 * @param {number}  [opts.lastSignAt]   上次签名时间
 * @param {function} [opts.now]
 * @returns {{ plans: Array<{kind:'assign', taskId, botId}>, sign: string } | { skip: true }}
 */
export function planIdleStaffing(room, { isInTurn, lastSign = '', lastSignAt = 0, now = Date.now } = {}) {
  const t = now()
  const open = openTasksOf(room)
  if (open.length === 0) return { plans: [], sign: '' }

  const members = room.members ?? []
  const idle = members.filter(id => !isInTurn?.(id))
  if (idle.length === 0) return { plans: [], sign: '' }

  // 有没有任务没有活跃负责人（即负责人空闲）
  const unattended = open.filter(task => !isInTurn?.(task.botId))
  if (unattended.length === 0) return { plans: [], sign: '' }

  // 签名：idle 成员 + unattended 任务 id
  const sign = [...idle].sort().join(',') + '|' + unattended.map(t => t.id).sort().join(',')
  if (sign === lastSign && t - lastSignAt < PMO_STAFFING_SIGN_TTL_MS) return { skip: true }

  // 一人一张：每个空闲成员领一张
  const plans = []
  for (let i = 0; i < Math.min(idle.length, unattended.length); i++) {
    plans.push({ kind: 'assign', taskId: unattended[i].id, botId: idle[i] })
  }
  return { plans, sign }
}

export function install(rt) {
  Object.assign(rt, { planDispatch: (room, opts) => planDispatch(room, opts), planTaskNudges, planIdleRetry: (room, opts) => planIdleRetry(room, opts), planIdleStaffing: (room, opts) => planIdleStaffing(room, opts), applyDispatch })
}
