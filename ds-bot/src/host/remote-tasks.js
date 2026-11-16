export const REMOTE_TASK_STATUS = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
}

const oneLine = text => text.replace(/\s+/g, ' ').trim().slice(0, 120)
const summaryText = summary => typeof summary === 'string' ? summary : typeof summary?.text === 'string' ? summary.text : ''
const statusOf = status => {
  const value = typeof status === 'string' ? status.toLowerCase() : ''
  if (Object.hasOwn(REMOTE_TASK_STATUS, value)) return value
  if (['aborted', 'interrupted', 'rejected'].includes(value)) return 'failed'
  return undefined
}

export function recordRemoteTask(rt, { taskId, exchangeId, nodeId, fromId, toId, prompt, startedAt = Date.now() }) {
  const task = { taskId, exchangeId, nodeId, fromId, toId, goal: oneLine(prompt), startedAt, status: 'running', summary: '' }
  ;(rt.remoteTasks ??= new Map()).set(taskId, task)
  const settled = [...rt.remoteTasks.values()].filter(row => row.status === 'completed' || row.status === 'failed')
  for (const oldest of settled.slice(0, -200)) rt.remoteTasks.delete(oldest.taskId)
  return task
}

export function settleRemoteTask(rt, taskId, { status, summary }) {
  const task = rt.remoteTasks?.get(taskId)
  if (!task) return undefined
  let settledStatus
  switch (typeof status === 'string' ? status.toLowerCase() : '') {
    case 'completed':
      settledStatus = 'completed'
      break
    case 'failed':
    case 'aborted':
    case 'interrupted':
    case 'rejected':
    case 'timeout':
      settledStatus = 'failed'
      break
    default:
      // An unsettled status must never be rendered as success.
      settledStatus = 'failed'
  }
  Object.assign(task, {
    status: settledStatus,
    summary: summaryText(summary),
    endedAt: Date.now(),
  })
  return task
}

export function mergeRemoteTasks(localTasks, hubTasks) {
  const tasks = new Map(localTasks.map(task => [task.taskId, { ...task }]))
  for (const row of Array.isArray(hubTasks) ? hubTasks : []) {
    if (!row || typeof row.taskId !== 'string' || !row.taskId || typeof row.nodeId !== 'string' || !row.nodeId) continue
    const status = statusOf(row.status)
    if (!status) continue
    const local = tasks.get(row.taskId)
    const task = {
      taskId: row.taskId,
      nodeId: row.nodeId,
      goal: typeof row.goal === 'string' ? oneLine(row.goal) : '',
      startedAt: Number.isFinite(row.startedAt) && row.startedAt > 0 ? row.startedAt : Number.isFinite(row.createdAt) ? row.createdAt : 0,
      ...local,
      status,
      summary: summaryText(row.summary ?? row.summaryText),
    }
    if (typeof row.nodeOnline === 'boolean') task.nodeOnline = row.nodeOnline
    if (Number.isFinite(row.endedAt) && row.endedAt > 0) task.endedAt = row.endedAt
    tasks.set(task.taskId, task)
  }
  return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
}

export async function listRemoteTasks(rt) {
  let hubTasks
  try {
    const service = rt.ctx.get?.('remote-agent:tasks')
    const rows = await service?.listTasks?.()
    if (Array.isArray(rows)) {
      hubTasks = []
      for (const row of rows) {
        try {
          hubTasks.push(typeof row?.status !== 'string' && typeof service.taskView === 'function' ? await service.taskView(row) : row)
        } catch { /* A bad projection must not hide the other tasks. */ }
      }
    }
  } catch { /* Workers and hubs without the projection use the local ledger. */ }
  return mergeRemoteTasks([...(rt.remoteTasks?.values() ?? [])], hubTasks)
}

export function pickRemoteTasks(rows, botId, limit) {
  if (!Array.isArray(rows)) return []
  const count = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20
  const tasks = typeof botId === 'string' && botId !== ''
    ? rows.filter(row => row?.fromId === botId || row?.toId === botId)
    : rows
  return tasks.slice(0, count)
}

export function humanizeElapsed(elapsedMs) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
}

export function formatRemoteTask(task, now = Date.now()) {
  const end = task.status === 'completed' || task.status === 'failed' ? task.endedAt ?? now : now
  const parts = [task.nodeId, task.goal, `已跑 ${humanizeElapsed(end - task.startedAt)}`, `状态: ${REMOTE_TASK_STATUS[task.status] ?? task.status}`]
  const summary = summaryText(task.summary).trim()
  if (summary) parts.push(`结果: ${summary.split(/\r\n|\r|\n/).length} 行`)
  if (task.nodeOnline === false) parts.push('节点离线')
  return parts.join(' · ')
}

export function install(rt) {
  rt.remoteTasks = new Map()
  rt.listRemoteTasks = () => listRemoteTasks(rt)
}
