// 人才库工具：list_talents / hire_talent (dsh-ai-team 格式兼容)
import { loadTalentCatalog, filterTalents, talentToCreateBot } from './talent-catalog.js'

// The group task board: what each member is working on in a group, one line apiece.
// A Bot registers a task when it takes the work and updates it as the work moves; the
// board is read from the group's own overview and never guessed from the chat. Tasks
// live on the room beside its goal, memory and folder, so they go when the group goes.
import { randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

export const TASK_STATUSES = ['active', 'review', 'blocked', 'pending_acceptance', 'done', 'cancelled']
const OPEN_STATUSES = ['active', 'review', 'blocked', 'pending_acceptance']
const GOAL_MAX = 200
const PROGRESS_MAX = 300
const RESULT_MAX = 2000
const NOTE_MAX = 500
const REASON_MAX = 500
const SCOPES_MAX = 8

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const tasksOf = room => (room.tasks ??= {})
const listOf = room => Object.values(tasksOf(room)).sort((a, b) => a.startedAt - b.startedAt)
export const openTasksOf = room => listOf(room).filter(task => OPEN_STATUSES.includes(task.status))
export const pastTasksOf = room => listOf(room).filter(task => !OPEN_STATUSES.includes(task.status))
const newId = () => `t_${randomBytes(4).toString('hex')}`

export function normalizeScopes(scopes = [], existing = []) {
  if (!Array.isArray(scopes)) return { error: 'Task scopes must be an array of paths.' }
  const paths = new Set(existing)
  for (const scope of scopes) {
    if (typeof scope !== 'string') return { error: 'Each task scope must be a string.' }
    const text = scope.trim().replace(/\\/g, '/')
    if (text === '') continue
    if (/[*?[\]{}]/.test(text)) return { error: 'Task scopes cannot contain glob characters.' }
    if (!text.startsWith('/')) return { error: 'Each task scope must be an absolute path starting with /.' }
    const path = text.replace(/\/+$/, '')
    if (path === '') return { error: 'The root path / cannot be a task scope.' }
    paths.add(path)
  }
  if (paths.size > SCOPES_MAX) return { error: `A task can declare at most ${SCOPES_MAX} scopes.` }
  return { scopes: [...paths] }
}

export function scopesOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

// The task an update names: its id, or the caller's own newest open task when no id is
// given (the common case: one Bot working on one thing).
function pickTask(room, id, botId) {
  if (id !== undefined && String(id).trim() !== '') return tasksOf(room)[String(id).trim()]
  return openTasksOf(room).filter(task => task.botId === botId).at(-1)
}

export function install(rt) {
  const owner = task => rt.botOf(task.botId)
  const checkScopes = (room, botId, scopes, existing) => {
    const normalized = normalizeScopes(scopes, existing)
    if (normalized.error !== undefined || normalized.scopes.length === 0) return normalized
    const conflict = []
    for (const task of openTasksOf(room)) {
      if (task.botId === botId) continue
      for (const held of task.scopes ?? []) {
        if (normalized.scopes.some(path => scopesOverlap(path, held))) {
          conflict.push(`- ${task.id} (${owner(task)?.name ?? task.botId}) holds ${JSON.stringify(held)}`)
        }
      }
    }
    if (conflict.length > 0) return { error: `Task scopes conflict with another member's work:\n${conflict.join('\n')}` }
    return normalized
  }
  const open = (room, botId, goal, scopes) => {
    const declared = checkScopes(room, botId, scopes)
    if (declared.error !== undefined) return declared
    const text = oneLine(goal, GOAL_MAX)
    if (text === '') return { error: 'A task needs a one-line goal.' }
    const at = Date.now()
    const task = { id: newId(), botId, goal: text, status: 'active', startedAt: at, updatedAt: at, progress: '' }
    if (declared.scopes.length > 0) task.scopes = declared.scopes
    tasksOf(room)[task.id] = task
    return { task }
  }
  const update = (room, botId, id, { status, progress, scopes } = {}) => {
    const task = pickTask(room, id, botId)
    if (task === undefined) return { error: 'No open task of yours in this group. Name one with its id, or open a task first.' }
    if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
    if (task.botId !== botId) return { error: `Task ${task.id} belongs to another member.` }
    // pending_acceptance is immutable: the owner must wait for a reviewer.
    if (task.status === 'pending_acceptance') return { error: 'That task is already finished.' }
    if (status !== undefined && !['active', 'review', 'blocked'].includes(status)) {
      return { error: `A running task\'s status is ${OPEN_STATUSES.join(', ')}; finish it with complete or cancel.` }
    }
    if (scopes !== undefined) {
      const declared = checkScopes(room, botId, scopes, task.scopes)
      if (declared.error !== undefined) return declared
      if (declared.scopes.length > 0) task.scopes = declared.scopes
    }
    if (status !== undefined) task.status = status
    if (progress !== undefined) task.progress = oneLine(progress, PROGRESS_MAX)
    task.updatedAt = Date.now()
    return { task }
  }
  const complete = (room, botId, id, result) => {
    const task = pickTask(room, id, botId)
    if (task === undefined) return { error: 'No open task of yours in this group.' }
    if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
    if (task.status === 'pending_acceptance') return { error: 'That task is already finished.' }
    if (task.botId !== botId) return { error: `Task ${task.id} belongs to another member.` }
    const text = oneLine(result, RESULT_MAX)
    if (text === '') return { error: 'A finished task needs a result summary.' }
    // Maker-can't-verify gate: completing a task moves it to pending_acceptance,
    // not done. A different member (QA / reviewer) must accept it.
    task.status = 'pending_acceptance'
    task.result = text
    task.updatedAt = Date.now()
    return { task }
  }
  // Review: a member other than the task's owner accepts or requests changes.
  // This is the maker-can't-verify hard gate from dsh-ai-team.
  const review = (room, reviewerId, id, { verdict, reason } = {}) => {
    const task = tasksOf(room)[String(id ?? '')]
    if (task === undefined) return { error: 'No such task.' }
    if (task.status !== 'pending_acceptance') return { error: `Task ${task.id} is not pending acceptance (current: ${task.status}).` }
    if (task.botId === reviewerId) return { error: 'You cannot accept your own work. Another member reviews it.' }
    if (verdict === 'accept') {
      task.status = 'done'
      task.reviewedBy = reviewerId
      task.updatedAt = Date.now()
      return { task }
    }
    if (verdict === 'request_changes') {
      // Rework: push back to in_progress (active) with the reason
      task.status = 'active'
      task.reviewedBy = reviewerId
      const why = oneLine(reason, REASON_MAX)
      if (why !== '') task.reviewReason = why
      task.updatedAt = Date.now()
      return { task }
    }
    return { error: 'Verdict must be accept or request_changes.' }
  }
  const cancel = (room, botId, id, reason, isAdmin) => {
    const task = pickTask(room, id, botId)
    if (task === undefined) return { error: 'No open task to cancel.' }
    if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
    if (task.status === 'pending_acceptance') return { error: 'That task is already finished.' }
    if (task.botId !== botId && !isAdmin) return { error: `Task ${task.id} belongs to another member; only its owner, the admin or a Main Bot cancels it.` }
    task.status = 'cancelled'
    const why = oneLine(reason, REASON_MAX)
    if (why !== '') task.reason = why
    task.updatedAt = Date.now()
    return { task }
  }
  const note = (room, id, text, by) => {
    const task = tasksOf(room)[String(id ?? '')]
    if (task === undefined) return undefined
    const line = oneLine(text, NOTE_MAX)
    if (line === '') return undefined
    ;(task.notes ??= []).push({ at: Date.now(), by, text: line })
    task.updatedAt = Date.now()
    return task
  }

  // What the tool answers with: the current board, not only the task it touched.
  const ledger = (room, self) => {
    const room_ = room
    const open = openTasksOf(room_).map(task => {
      const bot = owner(task)
      const mine = task.botId === self ? ' (yours)' : ''
      const progress = task.progress === '' ? '' : `\n  progress: ${task.progress}`
      const scopes = task.scopes?.length ? `\n  scopes: ${task.scopes.join(', ')}` : ''
      return `- ${task.id} · ${bot?.name ?? task.botId} · ${task.status} · ${task.goal}${mine}${progress}${scopes}`
    })
    const past = pastTasksOf(room_)
    const lines = [`Tasks in "${room_.name}"${open.length === 0 ? ': none open.' : ':'}`, ...open]
    if (past.length > 0) lines.push(`${past.length} finished or cancelled in the history; the group shows them under Tasks.`)
    return lines.join('\n')
  }

  rt.teamTools.push(defineTool({
    name: 'group_task',
    description: 'Register and move a group chat task: the work one member is doing in the group, so the user can see who is on what without reading the chat. Only a group member registers work, and every change is explicit: open when you take the work, update while it runs, complete with a one-line result, cancel when it stops. The group overview shows the board to the user; the history keeps finished and cancelled tasks. Called outside a group it refuses; inside a group the group is implied. Declaring scopes keeps two members off the same files; a scope another member already holds is refused with their task id.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'update', 'complete', 'review', 'cancel', 'show'], description: 'What to do. complete moves a task to pending_acceptance; a different member must review it to mark it done (maker-can\'t-verify rule).' },
      goal: { type: 'string', description: 'open: the task in one line, as the user would say the goal' },
      id: { type: 'string', description: 'update, complete, review, cancel: the task id; the caller\'s newest open task when left out' },
      status: { type: 'string', enum: ['active', 'review', 'blocked'], description: 'update: active while working, review when the result waits for the user, blocked when something stops you' },
      progress: { type: 'string', description: 'update: the latest one-line progress' },
      scopes: { type: 'array', items: { type: 'string' }, description: 'open, update: absolute paths this work will write, so two members do not take the same files; directory scopes cover everything under them' },
      result: { type: 'string', description: 'complete: the result summary the board keeps' },
      verdict: { type: 'string', enum: ['accept', 'request_changes'], description: 'review: accept marks the task done; request_changes pushes it back to active with your reason' },
      reason: { type: 'string', description: 'cancel or review request_changes: why the task stops or needs rework' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const member = rt.botOf(self)
      if (member === undefined) return 'Only Bots on the team can use group_task.'
      const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      if (room === undefined) return 'group_task works inside a group chat, where the work belongs to the group. Call it from your group session.'
      const isAdmin = rt.isMain(self) || rt.isAdminOf(room, self)
      const action = String(args.action ?? '')
      let result
      switch (action) {
        case 'open': result = open(room, self, args.goal, args.scopes); break
        case 'update': result = update(room, self, args.id, { status: args.status, progress: args.progress, scopes: args.scopes }); break
        case 'complete': result = complete(room, self, args.id, args.result); break
        case 'review': result = review(room, self, args.id, { verdict: args.verdict, reason: args.reason }); break
        case 'cancel': result = cancel(room, self, args.id, args.reason, isAdmin); break
        case 'show': return ledger(room, self)
        default: return `Unknown action ${action}.`
      }
      if (result.error !== undefined) return result.error
      const task = result.task
      const done = task.status === 'done' ? ` Finished: "${task.result}"` : task.status === 'cancelled' ? ' Cancelled.' : ''
      await rt.save()
      return `${action === 'open' ? `Opened ${task.id}: ${task.goal}` : `Updated ${task.id} (${task.status}).`}${done}\n\n${ledger(room, self)}`
    },
  }))

  // For the group overview. The endpoint adds the user's note and posts it to the room.
  Object.assign(rt, {
    taskNote: (roomId, id, text) => {
      const room = rt.roomOf(roomId)
      if (room === undefined) return { error: 'No such group.' }
      const task = tasksOf(room)[String(id ?? '')]
      if (task === undefined) return { error: 'No such task.' }
      if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
      const noted = note(room, id, text, 'user')
      return noted === undefined ? { error: 'Write a note first.' } : { task: noted }
    },
    taskCancel: (roomId, id) => {
      const room = rt.roomOf(roomId)
      if (room === undefined) return { error: 'No such group.' }
      const task = tasksOf(room)[String(id ?? '')]
      if (task === undefined) return { error: 'No such task.' }
      if (!OPEN_STATUSES.includes(task.status)) return { error: 'That task is already finished.' }
      task.status = 'cancelled'
      task.updatedAt = Date.now()
      return { task }
    },
  })

  // ── 人才库工具 ────────────────────────────────────────────────────────────
  rt.teamTools.push(defineTool({
    name: 'list_talents',
    description: 'Browse the talent catalog (dsh-ai-team format) to find specialists you can hire as new Bots. Returns name, role, duty (lead/qa/executor), description, and category for each talent. Filter with a keyword to narrow results.',
    parameters: {
      query: { type: 'string', description: 'Optional keyword to filter by name, role, category, or tags. Leave out to list all.' },
    },
    output,
    async execute(args) {
      const talents = loadTalentCatalog(rt.dshHome)
      const filtered = filterTalents(talents, args.query)
      if (filtered.length === 0) return args.query ? `No talents match "${args.query}".` : 'The talent catalog is empty. Add talents to ~/.dsh/ai-team/catalog/user/talents/<name>/talent.yml.'
      const lines = filtered.map(t =>
        `- **${t.name}** (${t.role ?? t.duty ?? '—'}) · ${t.duty ?? ''} · ${t.description ?? ''} ${Array.isArray(t.tags) ? '[' + t.tags.join(', ') + ']' : ''}`.trimEnd()
      )
      return `Talent catalog (${filtered.length} found):\n${lines.join('\n')}\n\nUse hire_talent with the exact name to add one to the team.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'hire_talent',
    description: 'Create a new Bot from the talent catalog. The talent\'s personality becomes the core of the Bot\'s instructions — this is what determines how it works. You can override the name and model. Main Bot only.',
    parameters: {
      talent: { type: 'string', required: true, description: 'Exact talent name from list_talents.' },
      name: { type: 'string', description: 'Override the talent\'s default name.' },
      model: { type: 'string', description: 'Override the talent\'s recommended model. Leave out to use the recommended model or the team default.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can hire new team members.'
      const talents = loadTalentCatalog(rt.dshHome)
      const talent = talents.find(t => String(t.name).toLowerCase() === String(args.talent ?? '').trim().toLowerCase())
      if (talent === undefined) return `No talent named "${args.talent}". Use list_talents to see available talents.`
      const params = talentToCreateBot(talent)
      if (args.name && String(args.name).trim() !== '') params.name = String(args.name).trim()
      if (args.model && String(args.model).trim() !== '') params.model = String(args.model).trim()
      if (!params.name) return `Talent "${args.talent}" has no name field. Check the talent.yml file.`
      try {
        const bot = await rt.createBot(params)
        return `Hired ${bot.name} as a ${params.role} (${talent.duty ?? 'executor'}). Their instructions are set from the talent's personality. Use message_bot to introduce them to the team.`
      } catch (err) {
        return `Could not hire talent: ${err.message}`
      }
    },
  }))
}
