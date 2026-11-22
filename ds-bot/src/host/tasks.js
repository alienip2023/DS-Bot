// 人才库工具：list_talents / hire_talent (dsh-ai-team 格式兼容)
import { loadTalentCatalog, filterTalents, talentToCreateBot } from './talent-catalog.js'
import { loadBotTemplates, filterBotTemplates } from './bot-templates.js'
import { installCredentialInterceptor } from './credential-interceptor.js'

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

// Why DS Bot blocked a task: the member's turn failed, or the user stopped it. The panel
// words the same facts in the user's language.
export const blockedLine = blocked => blocked.cause === 'stopped' ? 'stopped by the user'
  : blocked.cause === 'restarted' ? 'not updated after DeepSeek Harness restarted'
  : `its model call failed (${blocked.code}${blocked.status ? ` ${blocked.status}` : ''})`

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
    // The Bot is back on the work, whether or not it saw the block.
    if (task.blocked !== undefined) {
      task.status = task.blocked.from
      delete task.blocked
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
    // Scopes are released here so other members can take the same files
    // while the task awaits review.
    task.status = 'pending_acceptance'
    delete task.blocked
    task.result = text
    task.scopes = []
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
    delete task.blocked
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
      const blocked = task.blocked === undefined ? '' : `\n  blocked by DS Bot: ${blockedLine(task.blocked)}`
      return `- ${task.id} · ${bot?.name ?? task.botId} · ${task.status} · ${task.goal}${mine}${progress}${scopes}${blocked}`
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
      const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId ?? rt.taskOwners?.get(exec.agent?.id)?.roomId)
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
      // Fire planWakes after save so the state is consistent.
      if (typeof rt.planWakes === 'function' && typeof rt.executePlanWakes === 'function') {
        let eventType
        if (action === 'open') eventType = 'task/opened'
        else if (action === 'complete' && task.status === 'pending_acceptance') eventType = 'task/completed'
        else if (action === 'review' && task.status === 'active') eventType = 'task/review-requested'
        else if (action === 'cancel' && task.status === 'cancelled') eventType = 'task/cancelled'
        if (eventType) {
          try {
            const plans = rt.planWakes(eventType, { room, task, cancelledBy: action === 'cancel' ? self : undefined })
            await rt.executePlanWakes(plans)
          } catch (err) {
            rt.warn?.('ds-bot: group_task planWakes failed for %s in %s: %s', eventType, room.name, err)
          }
        }
      }
      return `${action === 'open' ? `Opened ${task.id}: ${task.goal}` : `Updated ${task.id} (${task.status}).`}${done}\n\n${ledger(room, self)}`
    },
  }))

  // The board follows how the member's work in the group really ended (#1663): a failed
  // turn or the user's stop blocks its running tasks, and its next completed turn there
  // puts them back. A block the Bot set itself is the Bot's to lift.
  // `since`: only tasks the member has not updated since then.
  const blockTasks = (roomId, botId, cause, since) => {
    const room = rt.roomOf(roomId)
    if (room === undefined) return
    // A system block is renewed with the latest cause; a block the Bot set stays its own.
    const running = openTasksOf(room).filter(task => task.botId === botId && (task.status !== 'blocked' || task.blocked !== undefined)
      && (since === undefined || task.updatedAt < since))
    if (running.length === 0) return
    const at = Date.now()
    for (const task of running) {
      task.blocked = { by: 'system', ...cause, from: task.blocked?.from ?? task.status, at }
      task.status = 'blocked'
      task.updatedAt = at
    }
    void rt.save().catch(() => {})
  }
  const unblockTasks = (roomId, botId) => {
    const room = rt.roomOf(roomId)
    if (room === undefined) return
    const blocked = openTasksOf(room).filter(task => task.botId === botId && task.blocked !== undefined)
    if (blocked.length === 0) return
    const at = Date.now()
    for (const task of blocked) {
      task.status = task.blocked.from
      delete task.blocked
      task.updatedAt = at
    }
    void rt.save().catch(() => {})
  }

  // For the group overview. The endpoint adds the user's note and posts it to the room.
  Object.assign(rt, {
    blockTasks,
    unblockTasks,
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
      delete task.blocked
      task.updatedAt = Date.now()
      return { task }
    },
  })

  // ── 人才库工具 ────────────────────────────────────────────────────────────
  rt.teamTools.push(defineTool({
    name: 'list_talents',
    description: 'Browse the talent catalog (dsh-ai-team format) to find specialists you can hire as new Bots. Returns name, role, duty (lead/qa/executor), description, and category for each talent. Filter with a keyword to narrow results.',
    isConcurrencySafe: true,
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
    description: 'Create a new Bot from the talent catalog. The talent\'s personality becomes the core of the Bot\'s instructions — this is what determines how it works. You can override the name and model, and optionally create it on a connected node machine. Main Bot only.',
    parameters: {
      talent: { type: 'string', required: true, description: 'Exact talent name from list_talents.' },
      name: { type: 'string', description: 'Override the talent\'s default name.' },
      model: { type: 'string', description: 'Override the talent\'s recommended model. Leave out to use the recommended model or the team default.' },
      node: { type: 'string', description: 'Node name or nodeId to create the Bot on that machine instead of the hub. Use list_bots to see connected nodes.' },
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
        // ── Node-side creation ───────────────────────────────────────────────
        const nodeArg = typeof args.node === 'string' ? args.node.trim() : ''
        if (nodeArg !== '') {
          if (typeof rt.createBotOnNode !== 'function') return 'Bot creation on a node is not available right now.'
          let resolvedNodeId = nodeArg
          try {
            const registry = rt.ctx?.get?.('remote-agent:registry')
            if (registry && typeof registry.onlineNodes === 'function') {
              const online = registry.onlineNodes()
              const match = online.find(n =>
                n.nodeId === nodeArg ||
                (typeof n.name === 'string' && n.name.toLowerCase() === nodeArg.toLowerCase()) ||
                (typeof n.hostname === 'string' && n.hostname.toLowerCase() === nodeArg.toLowerCase())
              )
              if (match) resolvedNodeId = match.nodeId
              else return `No connected node named "${nodeArg}". Use list_bots to see connected nodes.`
            }
          } catch { /* pass nodeArg as-is */ }
          const result = await rt.createBotOnNode({
            nodeId: resolvedNodeId,
            name: params.name,
            role: params.role ?? '',
            modelRef: params.model ?? null,
            instructions: params.instructions ?? null,
          })
          if (!result?.ok) return `Could not create Bot on node "${nodeArg}": ${result?.error ?? 'unknown error'}`
          await rt.save()
          return `Hired ${params.name} as a ${params.role ?? talent.duty ?? 'executor'} on node "${nodeArg}". Use message_bot to introduce them to the team.`
        }
        // ── Hub-side creation (original path) ───────────────────────────────
        const bot = await rt.createBot(params)
        return `Hired ${bot.name} as a ${params.role} (${talent.duty ?? 'executor'}). Their instructions are set from the talent's personality. Use message_bot to introduce them to the team.`
      } catch (err) {
        return `Could not hire talent: ${err.message}`
      }
    },
  }))

  // ── import_team：单文件团队定义（对标 openmausbot team playbook）────────
  //
  // 文件格式（markdown + YAML frontmatter）：
  //
  //   ---
  //   name: 我的团队
  //   bots:
  //     - name: 研究员
  //       role: QA
  //       model: deepseek/deepseek-chat
  //       instructions: |
  //         你是一名研究员，专注于...
  //     - talent: 全栈工程师       # 从内置人才库引用
  //       name: 阿全                # 可覆盖名称
  //   groups:
  //     - name: 开发组
  //       members: [研究员, 阿全]
  //   ---
  //
  //   团队描述文本（可选）
  //
  rt.teamTools.push(defineTool({
    name: 'import_team',
    description: 'Import a whole team from a single YAML or Markdown+frontmatter file: Bots, group chats, and talent references in one shot. Main Bot only. Existing Bots with the same name are skipped (no overwrite).',
    parameters: {
      text: { type: 'string', required: true, description: 'The full YAML or Markdown+frontmatter content of the team definition file.' },
      dry_run: { type: 'boolean', description: 'Preview what would be created without actually creating anything.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can import a team.'

      // Parse: strip frontmatter fences or treat as pure YAML
      const raw = String(args.text ?? '').trim()
      let yamlText = raw
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      if (fmMatch) yamlText = fmMatch[1]

      // Minimal inline YAML parser (same approach as talent-catalog.js)
      // but supports nested lists via indentation.
      let spec
      try {
        spec = parseTeamYaml(yamlText)
      } catch (err) {
        return `Could not parse team definition: ${err.message}`
      }

      const bots = Array.isArray(spec.bots) ? spec.bots : []
      const groups = Array.isArray(spec.groups) ? spec.groups : []
      if (bots.length === 0 && groups.length === 0) return 'No bots or groups found in the team definition.'

      const talents = loadTalentCatalog(rt.dshHome)
      const results = []
      const created = []

      if (args.dry_run) {
        for (const b of bots) {
          const name = String(b.name ?? b.talent ?? '').trim()
          if (!name) { results.push('⚠ Skipped: bot entry has no name'); continue }
          const exists = rt.findBot(name)
          if (exists) { results.push(`→ Skip "${name}" (already exists)`); continue }
          if (b.talent) {
            const t = talents.find(t => String(t.name).toLowerCase() === String(b.talent).toLowerCase())
            results.push(t ? `✓ Would hire talent "${t.name}"${b.name ? ` as "${b.name}"` : ''}` : `⚠ Talent "${b.talent}" not found`)
          } else {
            results.push(`✓ Would create Bot "${name}" (${b.role ?? 'no role'})`)
          }
        }
        for (const g of groups) {
          const name = String(g.name ?? '').trim()
          if (!name) { results.push('⚠ Skipped: group entry has no name'); continue }
          results.push(`✓ Would create group "${name}" with members: ${(g.members ?? []).join(', ')}`)
        }
        return `Dry run — nothing created:\n\n${results.join('\n')}`
      }

      // Create bots
      for (const b of bots) {
        const rawName = String(b.name ?? b.talent ?? '').trim()
        if (!rawName) { results.push('⚠ Skipped: bot entry has no name'); continue }
        if (rt.findBot(rawName)) { results.push(`→ Skipped "${rawName}" (already exists)`); continue }
        try {
          if (b.talent) {
            const t = talents.find(t => String(t.name).toLowerCase() === String(b.talent).toLowerCase())
            if (!t) { results.push(`⚠ Talent "${b.talent}" not found`); continue }
            const params = talentToCreateBot(t)
            if (rawName !== t.name) params.name = rawName
            if (b.model) params.model = String(b.model).trim()
            const bot = await rt.createBot(params)
            created.push(bot.name)
            results.push(`✓ Hired talent "${t.name}" as ${bot.name}`)
          } else {
            const instructions = String(b.instructions ?? '').trim()
            const bot = await rt.createBot({ name: rawName, role: String(b.role ?? ''), instructions, model: b.model ?? undefined })
            created.push(bot.name)
            results.push(`✓ Created Bot "${bot.name}"`)
          }
        } catch (err) {
          results.push(`✗ Failed to create "${rawName}": ${err.message}`)
        }
      }

      // Create groups
      for (const g of groups) {
        const name = String(g.name ?? '').trim()
        if (!name) { results.push('⚠ Skipped: group entry has no name'); continue }
        const memberNames = Array.isArray(g.members) ? g.members.map(m => String(m).trim()).filter(Boolean) : []
        try {
          if (typeof rt.createGroup === 'function') {
            await rt.createGroup({ name, memberNames })
            results.push(`✓ Created group "${name}" with [${memberNames.join(', ')}]`)
          } else {
            results.push(`→ Skipped group "${name}": group creation not available via tool`)
          }
        } catch (err) {
          results.push(`✗ Failed to create group "${name}": ${err.message}`)
        }
      }

      await rt.save()
      return `Team import complete:\n\n${results.join('\n')}`
    },
  }))

  installTemplateTools(rt)
  installScheduleBot(rt)
  installBotConnect(rt)
  installCredentialBroker(rt)
  if (rt.ctx) installCredentialInterceptor(rt)
}

// ── schedule_bot ─────────────────────────────────────────────────────────────
//
// Lets a Main Bot create a time-based recurring or one-shot routine for any Bot
// on the team, complete with a prompt whose opening lines respect that Bot's
// instructions context.  Thin wrapper over the existing bot-routines machinery
// (rt.scheduleEndpoint / 'schedule-create').
//
// Key difference from the UI schedule form:
//   • schedule_bot prepends a one-line instructions anchor to the prompt so the
//     target Bot reads the task in the right role context.
//   • The model selects frequency with a plain English shorthand that maps to the
//     DSH selector format.

const SCHEDULE_FREQ_HELP = '"once", "daily HH:MM", "weekly Mon HH:MM", "every N min", "at <ISO date>"'

// Returns the DSH schedule-create `when` shape: { kind, at?, time?, weekdays?, minutes?, timeZone? }
function parseScheduleFreq(freq) {
  if (typeof freq !== 'string') return { error: `frequency must be a string like ${SCHEDULE_FREQ_HELP}` }
  const s = freq.trim().toLowerCase()
  if (s === 'once' || s === 'now') return { when: { kind: 'at', at: new Date(Date.now() + 10_000).toISOString() } }
  {
    const m = s.match(/^daily\s+(\d{1,2}:\d{2}(?::\d{2})?)$/)
    if (m) return { when: { kind: 'daily', time: m[1].padStart(5, '0'), timeZone: 'UTC' } }
  }
  {
    const m = s.match(/^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}:\d{2}(?::\d{2})?)$/i)
    if (m) {
      const days = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }
      return { when: { kind: 'weekly', time: m[2].padStart(5, '0'), timeZone: 'UTC', weekdays: [days[m[1].toLowerCase()]] } }
    }
  }
  {
    const m = s.match(/^at\s+(.+)$/)
    if (m) {
      const at = new Date(m[1].trim())
      if (!Number.isNaN(at.getTime())) return { when: { kind: 'at', at: at.toISOString() } }
    }
  }
  {
    const m = s.match(/^every\s+(\d+)\s*(min|mins|minutes?|hour|hours?)?$/)
    if (m) {
      const n = parseInt(m[1], 10)
      const unit = (m[2] ?? 'min').startsWith('h') ? 60 : 1
      const minutes = n * unit
      if (minutes < 1 || minutes > 10080) return { error: 'frequency: "every N min" must be 1 minute to 7 days (10080 min)' }
      return { when: { kind: 'every', minutes } }
    }
  }
  return { error: `Unrecognised frequency "${freq}". Use ${SCHEDULE_FREQ_HELP}.` }
}

export function installScheduleBot(rt) {
  rt.teamTools.push(defineTool({
    name: 'schedule_bot',
    description: 'Schedule a recurring or one-time task for any Bot on the team. The Bot\'s own instructions stay active — it runs in character. Main Bot only. Frequency examples: "daily 09:00", "weekly Mon 09:00", "every 30 min", "once", "at 2026-11-22T08:00:00Z".',
    parameters: {
      bot: { type: 'string', required: true, description: 'Exact Bot name from list_bots.' },
      title: { type: 'string', required: true, description: 'Short name shown in the schedule list.' },
      prompt: { type: 'string', required: true, description: 'What the Bot should do when the task fires.' },
      frequency: { type: 'string', required: true, description: `When to run: ${SCHEDULE_FREQ_HELP}.` },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can schedule tasks for other Bots.'
      const botName = String(args.bot ?? '').trim()
      const bot = rt.findBot(botName)
      if (!bot) return `No Bot named "${botName}". Use list_bots to see the team.`
      if (bot.origin === 'peer') return `${bot.name} is on another node; schedule it from that node's Main Bot.`
      const title = String(args.title ?? '').trim()
      if (!title) return 'Give the scheduled task a title.'
      if (title.length > 120) return 'Title is too long (max 120 characters).'
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) return 'Write a prompt — what the Bot should do when the task fires.'
      const { when, error: freqErr } = parseScheduleFreq(String(args.frequency ?? ''))
      if (freqErr) return freqErr
      try {
        await rt.scheduleEndpoint('schedule-create', {
          target: { kind: 'bot', botId: bot.id },
          title,
          prompt,
          when,
        })
      } catch (err) {
        return `Could not schedule: ${err?.message ?? err}`
      }
      return `Scheduled "${title}" for ${bot.name} — runs ${String(args.frequency).trim()}.`
    },
  }))
}

// ── bot_connect：Connected Apps 集成层 ──────────────────────────────────────
//
// 允许 Bot 注册"已连接应用"——比如 GitHub、Jira、Slack——并将连接句柄
// 存入 state.connectedApps，让其他工具（比如 task_token 凭证代理）可以
// 引用它们，而不必把 API key 直接写进 prompt。
//
// 每条记录：{ id, botId, name, type, label?, notes?, createdAt, updatedAt }
// 敏感凭证永远不写进 state.json；只存元数据（连接名称/类型/说明）。
// 实际凭证走 rt.secretsView()/rt.setSecret() 路径，key 格式为
//   connected-app:<id>:<field>
// 这样凭证受到现有加密存储保护，连接记录只是索引。
//
// 操作：list / register / unregister / info

export function installBotConnect(rt) {
  const apps = () => { rt.state.connectedApps ??= {}; return rt.state.connectedApps }
  const appId = (name) => `ca_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32)}_${Date.now().toString(36)}`
  const appView = (a) => ({
    id: a.id, botId: a.botId, name: a.name, type: a.type,
    label: a.label ?? null, notes: a.notes ?? null,
    createdAt: a.createdAt, updatedAt: a.updatedAt,
  })

  rt.teamTools.push(defineTool({
    name: 'bot_connect',
    description: 'Register, list, or unregister a Connected App for a Bot — an external service integration such as GitHub, Jira, Linear, Slack, or any HTTP API. The connection record stores the name and type only; API keys are kept separately in the secret store under "connected-app:<id>:<field>". A Bot can list and use its own connections; a Main Bot can manage any Bot\'s connections.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'register', 'unregister', 'info'], description: '"list": show connections for a Bot (or all). "register": add a new connection. "unregister": remove one by id. "info": get one record by id.' },
      bot: { type: 'string', description: 'Bot name to scope list/register/unregister. Leave out to list your own or all (Main Bot).' },
      id: { type: 'string', description: 'unregister / info: the connection id from list.' },
      name: { type: 'string', description: 'register: short name for the connection, e.g. "github-work".' },
      type: { type: 'string', description: 'register: service type, e.g. "github", "jira", "slack", "http", "custom".' },
      label: { type: 'string', description: 'register: human label shown in the UI.' },
      notes: { type: 'string', description: 'register: usage notes — what this connection is for.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (!caller) return 'Only Bots on the team can use bot_connect.'
      const isMain = rt.isMain(self)
      const action = String(args.action ?? '')

      const targetBot = args.bot ? rt.findBot(String(args.bot).trim()) : caller
      if (args.bot && !targetBot) return `No Bot named "${args.bot}".`
      if (targetBot.id !== caller.id && !isMain) return 'Only a Main Bot can manage another Bot\'s connections.'

      switch (action) {
        case 'list': {
          const all = Object.values(apps())
          const filtered = isMain && !args.bot ? all : all.filter(a => a.botId === targetBot.id)
          if (filtered.length === 0) return args.bot ? `No connections for ${targetBot.name}.` : 'No connected apps registered.'
          const lines = filtered.map(a => `- ${a.id}  ${a.name}  [${a.type}]${a.label ? '  ' + a.label : ''}${a.botId !== caller.id ? '  (bot: ' + (rt.botOf(a.botId)?.name ?? a.botId) + ')' : ''}`)
          return `Connected apps (${filtered.length}):\n${lines.join('\n')}\n\nUse bot_connect action=info id=<id> to see details.`
        }
        case 'register': {
          const name = String(args.name ?? '').trim()
          if (!name) return 'Provide a name for the connection.'
          const type = String(args.type ?? '').trim() || 'custom'
          const id = appId(name)
          const now = Date.now()
          apps()[id] = {
            id, botId: targetBot.id,
            name, type,
            label: args.label ? String(args.label).trim() : undefined,
            notes: args.notes ? String(args.notes).trim() : undefined,
            createdAt: now, updatedAt: now,
          }
          await rt.save()
          return `Registered connection "${name}" [${type}] for ${targetBot.name}.\nid: ${id}\n\nStore API keys with: rt.setSecret("connected-app:${id}:<field>", value)`
        }
        case 'unregister': {
          const id = String(args.id ?? '').trim()
          const app = apps()[id]
          if (!app) return `No connection with id "${id}".`
          if (app.botId !== targetBot.id && !isMain) return `Connection "${id}" belongs to another Bot.`
          delete apps()[id]
          await rt.save()
          return `Unregistered connection "${app.name}" (${id}).`
        }
        case 'info': {
          const id = String(args.id ?? '').trim()
          const app = apps()[id]
          if (!app) return `No connection with id "${id}".`
          if (app.botId !== caller.id && !isMain) return 'Only a Main Bot can read another Bot\'s connection details.'
          const v = appView(app)
          const botName = rt.botOf(v.botId)?.name ?? v.botId
          return [`Connection: ${v.name}`, `id: ${v.id}`, `type: ${v.type}`, `bot: ${botName}`, ...(v.label ? [`label: ${v.label}`] : []), ...(v.notes ? [`notes: ${v.notes}`] : []), `created: ${new Date(v.createdAt).toISOString()}`].join('\n')
        }
        default:
          return `Unknown action "${action}". Use list, register, unregister, or info.`
      }
    },
  }))

  // Expose for channel.js and credential broker.
  rt.listConnectedApps = (botId) => {
    const all = Object.values(apps())
    return botId ? all.filter(a => a.botId === botId) : all
  }
  rt.getConnectedApp = (id) => apps()[id]
}

// ── 凭证代理（task_token）────────────────────────────────────────────────────
//
// Bot 可以向凭证代理申请一个临时 task_token，用来代替 API key 调用外部服务。
// 目标：Bot 的 prompt 里永远不出现真实 API key；凭证代理按需生成/转发。
//
// 工作方式：
//   1. 主 Bot（或用户）提前用 rt.setSecret('task-token:<name>', value) 注册凭证。
//   2. Bot 调用 task_token action=request，代理用内存令牌表示该凭证可用，
//      并返回一个临时 opaque token（格式 tt_<hex>，30分钟有效）。
//   3. Bot 把 opaque token 传给外部 HTTP 工具；代理拦截器用它换出真实值。
//      （此拦截层未来实现；本版本负责 register/request/revoke/list。）
//   4. 令牌过期或 revoke 后即失效。
//
// 凭证名称格式：<service>/<field>，例如 "github/token"、"jira/api_key"。

const TOKEN_TTL_MS = 30 * 60_000
const TOKEN_PREFIX = 'tt_'

export function installCredentialBroker(rt) {
  // In-memory token table: token → { name, botId, createdAt, expiresAt }
  const tokens = new Map()

  // Prune expired tokens.
  const prune = () => {
    const now = Date.now()
    for (const [t, rec] of tokens) { if (rec.expiresAt <= now) tokens.delete(t) }
  }

  // Expose for future interceptor use. The actual secret value stays in the
  // secret store; this returns only the metadata that a token stands for.
  rt.resolveTaskToken = (token) => {
    prune()
    const rec = tokens.get(token)
    if (!rec) return undefined
    return { name: rec.name, botId: rec.botId, expiresAt: rec.expiresAt }
  }

  rt.teamTools.push(defineTool({
    name: 'task_token',
    description: 'Request or manage temporary task tokens — short-lived opaque handles that stand in for API keys. A Bot requests a token by name; the host validates that the credential exists and returns a tt_* token valid for 30 minutes. The Bot passes the token to external tool calls instead of a real key; the host resolves it transparently. Only a Bot that owns the credential (registered by Main Bot) may request its token.',
    parameters: {
      action: { type: 'string', required: true, enum: ['request', 'revoke', 'list'], description: '"request": obtain a 30-min token for a named credential. "revoke": invalidate a token early. "list": show your active tokens.' },
      name: { type: 'string', description: 'request: credential name in format "service/field", e.g. "github/token".' },
      token: { type: 'string', description: 'revoke: the tt_* token to invalidate.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (!caller) return 'Only Bots on the team can use task_token.'
      prune()
      const action = String(args.action ?? '')

      switch (action) {
        case 'request': {
          const name = String(args.name ?? '').trim()
          if (!name) return 'Provide a credential name in format "service/field".'
          if (!/^[\w-]+\/[\w-]+$/.test(name)) return 'Credential name must be "service/field" (letters, digits, hyphens).'
          // Check secret exists; we don't surface the value.
          const secretKey = `task-token:${name}`
          let known = false
          if (typeof rt.getSecret === 'function') {
            try { known = rt.getSecret(secretKey) !== undefined } catch { /* ignore */ }
          }
          if (!known) {
            const secrets = rt.secretsView?.() ?? {}
            known = Object.keys(secrets).includes(secretKey)
          }
          if (!known) return `Credential "${name}" is not registered. Ask a Main Bot to add it with the secret key "task-token:${name}".`
          // Revoke any existing token for the same bot+name.
          for (const [t, rec] of tokens) { if (rec.name === name && rec.botId === caller.id) tokens.delete(t) }
          const { randomUUID } = await import('node:crypto')
          const token = `${TOKEN_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 24)}`
          const now = Date.now()
          tokens.set(token, { name, botId: caller.id, createdAt: now, expiresAt: now + TOKEN_TTL_MS })
          return `Token issued for "${name}".\ntoken: ${token}\nexpires: ${new Date(now + TOKEN_TTL_MS).toISOString()}\n\nPass this token wherever the API key is expected; it expires in 30 minutes.`
        }
        case 'revoke': {
          const token = String(args.token ?? '').trim()
          if (!token) return 'Provide the tt_* token to revoke.'
          const rec = tokens.get(token)
          if (!rec) return 'Token not found or already expired.'
          if (rec.botId !== caller.id && !rt.isMain(self)) return 'You can only revoke your own tokens.'
          tokens.delete(token)
          return `Token for "${rec.name}" revoked.`
        }
        case 'list': {
          const mine = [...tokens.values()].filter(r => r.botId === caller.id)
          if (mine.length === 0) return 'No active tokens.'
          const lines = mine.map(r => `- ${r.name}  expires ${new Date(r.expiresAt).toISOString()}`)
          return `Active tokens (${mine.length}):\n${lines.join('\n')}`
        }
        default:
          return `Unknown action "${action}". Use request, revoke, or list.`
      }
    },
  }))
}

function parseTeamYaml(text) {
  const lines = String(text).split(/\r?\n/)
  const root = {}
  const stack = [{ obj: root, indent: -1 }]
  let currentList = null
  let currentListKey = null
  let currentListItem = null
  let listIndent = -1

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const indent = raw.match(/^(\s*)/)[1].length
    const content = raw.trim()

    // List item
    if (content.startsWith('- ')) {
      const val = content.slice(2).trim()
      // top-level list key
      if (currentList !== null && indent >= listIndent) {
        if (val.includes(':')) {
          // object item — start accumulating
          currentListItem = {}
          currentList.push(currentListItem)
          const colonIdx = val.indexOf(':')
          const k = val.slice(0, colonIdx).trim()
          const v = val.slice(colonIdx + 1).trim()
          if (v) currentListItem[k] = v.replace(/^\|$/, '').trim() || v
        } else {
          currentList.push(val)
          currentListItem = null
        }
        continue
      }
      continue
    }

    // Key: value
    if (content.includes(':')) {
      const colonIdx = content.indexOf(':')
      const k = content.slice(0, colonIdx).trim()
      const v = content.slice(colonIdx + 1).trim()

      if (v === '' || v === '|') {
        // Start of a list or multi-line block
        if (i + 1 < lines.length && lines[i + 1].trim().startsWith('-')) {
          currentList = []
          currentListKey = k
          listIndent = indent + 2
          root[k] = currentList
          currentListItem = null
        } else {
          // Multi-line string — collect indented lines
          let block = ''
          while (i + 1 < lines.length) {
            const next = lines[i + 1]
            if (next.trim() === '') { i++; block += '\n'; continue }
            if (next.match(/^(\s*)/)[1].length <= indent) break
            i++
            block += (block ? '\n' : '') + next.trim()
          }
          if (currentListItem) currentListItem[k] = block
          else root[k] = block
        }
      } else {
        const parsed = v.replace(/^['"]|['"]$/g, '')
        if (currentListItem && indent > listIndent) {
          currentListItem[k] = parsed
        } else {
          root[k] = parsed
          currentList = null
          currentListItem = null
        }
      }
      continue
    }
  }
  return root
}

// ── list_templates + create_from_template 工具 ───────────────────────────────

export function installTemplateTools(rt) {
  rt.teamTools.push(defineTool({
    name: 'list_templates',
    description: 'Browse the bot template library — 30+ ready-made roles inspired by dsh-ai-team, oh-my-dsh-slim and openmausbot (planner, implementer, reviewer triangle, orchestrator+specialists, engineers, QA, ops, data, etc.). Filter by keyword.',
    isConcurrencySafe: true,
    parameters: {
      query: { type: 'string', description: 'Optional keyword to filter by name, role, category, tags, or description.' },
      category: { type: 'string', description: 'Filter by category: 工程, 运维, 数据, 产品, 写作, 管理, 研究' },
    },
    output,
    async execute(args) {
      await rt.load()
      const all = loadBotTemplates(rt.dshHome)
      let filtered = filterBotTemplates(all, args.query)
      if (args.category) {
        const cat = String(args.category).trim()
        filtered = filtered.filter(t => String(t.category ?? '').toLowerCase() === cat.toLowerCase())
      }
      if (filtered.length === 0) return 'No templates matched. Try without filters to see all.'
      const lines = [`Bot templates (${filtered.length} found):\n`]
      const byCategory = new Map()
      for (const t of filtered) {
        const cat = t.category ?? '其他'
        if (!byCategory.has(cat)) byCategory.set(cat, [])
        byCategory.get(cat).push(t)
      }
      for (const [cat, templates] of byCategory) {
        lines.push(`── ${cat} ──`)
        for (const t of templates) {
          const duty = t.duty ? ` [${t.duty}]` : ''
          const tags = Array.isArray(t.tags) && t.tags.length > 0 ? `  tags: ${t.tags.slice(0, 4).join(', ')}` : ''
          lines.push(`  ${t.id}  "${t.name}" · ${t.role}${duty}`)
          lines.push(`    ${t.description}${tags}`)
        }
        lines.push('')
      }
      lines.push('Use create_from_template with the exact id to create a Bot.')
      return lines.join('\n')
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'create_from_template',
    description: 'Create a Bot from a template in the template library. Fast alternative to create_bot: picks up name, role, instructions and duty from the template. Main Bot only.',
    parameters: {
      template: { type: 'string', required: true, description: 'Exact template id from list_templates.' },
      name: { type: 'string', description: 'Override the template\'s default name.' },
      model: { type: 'string', description: 'Model to run on (provider/model). Leave out to use team default.' },
      node: { type: 'string', description: 'Node name or nodeId to create the Bot on that node machine.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can create Bots from templates.'
      const all = loadBotTemplates(rt.dshHome)
      const tmpl = all.find(t => t.id === String(args.template ?? '').trim())
      if (!tmpl) return `No template with id "${args.template}". Use list_templates to see available ids.`
      const name = String(args.name ?? tmpl.name ?? '').trim()
      if (!name) return `Template "${args.template}" has no name field.`
      const existing = rt.findBot(name)
      if (existing) return `A Bot named "${name}" already exists. Pass a different name to override.`
      try {
        const nodeArg = typeof args.node === 'string' ? args.node.trim() : ''
        if (nodeArg !== '') {
          if (typeof rt.createBotOnNode !== 'function') return 'Bot creation on a node is not available right now.'
          let resolvedNodeId = nodeArg
          try {
            const registry = rt.ctx?.get?.('remote-agent:registry')
            if (registry && typeof registry.onlineNodes === 'function') {
              const online = registry.onlineNodes()
              const match = online.find(n =>
                n.nodeId === nodeArg ||
                (typeof n.name === 'string' && n.name.toLowerCase() === nodeArg.toLowerCase()) ||
                (typeof n.hostname === 'string' && n.hostname.toLowerCase() === nodeArg.toLowerCase())
              )
              if (match) resolvedNodeId = match.nodeId
              else return `No connected node named "${nodeArg}". Use list_bots to see connected nodes.`
            }
          } catch { /* pass nodeArg as-is */ }
          const result = await rt.createBotOnNode({
            nodeId: resolvedNodeId,
            name,
            role: String(tmpl.role ?? '').slice(0, 24),
            modelRef: args.model ? String(args.model).trim() : null,
            instructions: String(tmpl.instructions ?? '').trim(),
          })
          if (!result?.ok) return `Could not create Bot on node "${nodeArg}": ${result?.error ?? 'unknown error'}`
          await rt.save()
          return `Created ${name} (${tmpl.role}) from template "${tmpl.id}" on node "${nodeArg}".`
        }
        const bot = await rt.createBot({
          name,
          role: String(tmpl.role ?? '').slice(0, 24),
          instructions: String(tmpl.instructions ?? '').trim(),
          model: args.model ?? tmpl.model ?? undefined,
        })
        return `Created ${bot.name} (${tmpl.role}) from template "${tmpl.id}". ${tmpl.duty ? `Duty: ${tmpl.duty}.` : ''} Use message_bot to introduce them to the team.`
      } catch (err) {
        return `Could not create Bot from template: ${err.message}`
      }
    },
  }))
}
