// P3 集中唤醒路由（吸收书 1-D planWakes）。
//
// 把分散在 turns.js / goals.js / handoffs.js 里的"谁应该被叫醒"逻辑
// 集中到一处事件→唤醒计划表。
//
// 设计原则（来自吸收书 + issues #1682 / #1894）：
//   1. 终态任务（done/cancelled）静默——不再唤醒。
//   2. 路由变更（模型/配置）只叫有活跃任务的成员（防空转全员激活）。
//   3. 验收请求走 pairedReviewer 配对，不全体广播（#1894 群任务回传）。
//   4. 每次唤醒带 key，调用方可去重（防重复投递，#1682）。
//   5. 返回计划列表，不直接 deliver——让 install(rt) 的调用方决定何时执行。
//
// 事件类型（eventType 字符串）：
//   'task/opened'        Bot 开了一张任务
//   'task/updated'       Bot 更新任务进度/状态
//   'task/completed'     Bot 完成任务（带 result）
//   'task/cancelled'     Bot 取消任务
//   'task/note'          用户在面板追加备注
//   'round/end'          一轮群聊结束
//   'goal/idle'          目标空闲（无人在跑）
//   'config/changed'     模型/路由变更
//   'member/failed'      成员回合失败
//   'task/review-requested'  请求验收（返工循环）

const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled'])
const OPEN_TASK_STATUSES = new Set(['active', 'review', 'blocked'])

/**
 * 确定一个任务的 reviewer：
 *   - 如果任务有明确 reviewerId → 用它
 *   - 否则找第一个不是任务负责人的 Main Bot
 *   - 都没有 → undefined（不唤醒验收人）
 */
function pairedReviewer(room, task, rt) {
  if (typeof task.reviewerId === 'string' && task.reviewerId !== '') {
    return rt.botOf(task.reviewerId) ? task.reviewerId : undefined
  }
  // 找第一个不是任务负责人的 Main Bot
  const members = room.members ?? []
  for (const id of members) {
    if (id === task.botId) continue
    if (rt.isMain?.(id)) return id
  }
  return undefined
}

/**
 * 生成唤醒计划。
 *
 * @param {object} rt       ds-bot runtime（需要 rt.botOf, rt.isMain, rt.state）
 * @param {string} eventType 事件类型
 * @param {object} eventData 事件数据（room, task, member, etc.）
 * @returns {Array<{key:string, toId:string, text:string, role?:string}>}
 *   key 用于去重；toId 是目标 Bot 的 botId；text 是要发的提示消息。
 */
export function planWakes(rt, eventType, eventData = {}) {
  const plans = []
  const push = (key, toId, text, role = 'nudge') => {
    if (typeof toId !== 'string' || toId === '') return
    if (rt.botOf?.(toId) === undefined) return
    plans.push({ key, toId, text, role })
  }

  const { room, task, member, reason } = eventData

  switch (eventType) {
    case 'task/opened': {
      // 任务开了，通知群 admin（如果不是任务负责人自己）
      if (!room || !task) break
      const adminId = room.admin
      if (adminId && adminId !== task.botId) {
        push(`task-opened:${task.id}:admin`, adminId,
          `[Task opened by ${rt.botOf(task.botId)?.name ?? task.botId}] ${task.goal}`)
      }
      break
    }

    case 'task/completed': {
      // 完成后路由结果给 Main Bot（issue #1894 群任务结果回传）
      if (!room || !task) break
      // 通知 reviewer（如果有配对的）
      const reviewerId = pairedReviewer(room, task, rt)
      if (reviewerId) {
        push(`task-completed:${task.id}:review`, reviewerId,
          `[Task completed — please review] ${task.goal}\nResult: ${task.result ?? '(no result)'}`)
      }
      // 通知 admin（如果不是负责人也不是 reviewer）
      const adminId = room.admin
      if (adminId && adminId !== task.botId && adminId !== reviewerId) {
        push(`task-completed:${task.id}:admin`, adminId,
          `[Task completed by ${rt.botOf(task.botId)?.name ?? task.botId}] ${task.goal}\nResult: ${task.result ?? '(no result)'}`)
      }
      break
    }

    case 'task/review-requested': {
      // 返工循环：请求验收，配对 reviewer
      if (!room || !task) break
      const reviewerId = pairedReviewer(room, task, rt)
      if (reviewerId) {
        push(`task-review:${task.id}:${reviewerId}`, reviewerId,
          `[Review requested] ${task.goal}\nPlease check the work and accept or request changes.`)
      }
      break
    }

    case 'task/note': {
      // 用户在面板追加备注 → 通知任务负责人
      if (!room || !task) break
      if (TERMINAL_TASK_STATUSES.has(task.status)) break // 终态静默
      push(`task-note:${task.id}:${Date.now()}`, task.botId,
        `[Note on your task "${task.goal}"] ${eventData.noteText ?? '(see task board)'}`)
      break
    }

    case 'task/cancelled': {
      // 取消通知原负责人（如果是他人取消的）
      if (!room || !task) break
      if (eventData.cancelledBy && eventData.cancelledBy !== task.botId) {
        push(`task-cancelled:${task.id}`, task.botId,
          `[Your task was cancelled] ${task.goal}\nReason: ${task.reason ?? '(no reason given)'}`)
      }
      break
    }

    case 'goal/idle': {
      // 目标空闲：叫 admin，不叫全员
      if (!room) break
      const adminId = room.admin
      if (!adminId) break
      const goal = room.goal
      if (!goal || goal.status !== 'active' || goal.idle === true) break
      push(`goal-idle:${room.id}:${goal.revision ?? 0}`, adminId, '[Goal check] The group has been quiet. What is next?')
      break
    }

    case 'config/changed': {
      // 路由/模型变更：只叫有活跃任务的成员（防空转全员激活）
      if (!room) break
      const members = room.members ?? []
      const activeBotIds = new Set(
        Object.values(rt.state?.rooms?.[room.id] ? (rt.state.rooms[room.id].tasks ?? {}) : (room.tasks ?? {}))
          .filter(t => OPEN_TASK_STATUSES.has(t.status))
          .map(t => t.botId)
      )
      for (const botId of members) {
        if (!activeBotIds.has(botId)) continue
        push(`config-changed:${room.id}:${botId}`, botId,
          '[Configuration updated] The model or route has changed. Please continue your current task with the new settings.')
      }
      break
    }

    case 'member/failed': {
      // 成员失败：通知 admin
      if (!room || !member) break
      const adminId = room.admin
      if (adminId && adminId !== member.id) {
        push(`member-failed:${room.id}:${member.id}`, adminId,
          `[Member failed] ${member.name ?? member.id} could not complete their turn: ${reason ?? 'unknown error'}`)
      }
      break
    }

    case 'round/end': {
      // 轮次结束：只在 goal 活跃且无人在跑时 nudge admin（goalDrive 的集中版）
      if (!room) break
      const goal = room.goal
      if (!goal || goal.status !== 'active' || goal.idle === true) break
      const adminId = room.admin
      if (!adminId) break
      push(`round-end:${room.id}:${Date.now()}`, adminId, '[Goal check] The round has ended. Please check and continue.')
      break
    }

    default:
      break
  }

  return plans
}

/**
 * 把唤醒计划执行出去（通过 rt.deliver）。
 * 调用方传入 plans（来自 planWakes），此函数负责去重 + 发送。
 *
 * @param {object} rt
 * @param {Array} plans  planWakes 的返回值
 * @param {Set} [delivered]  已发出的 key 集合（调用方维护，跨轮去重）
 */
export async function executePlanWakes(rt, plans, delivered = new Set()) {
  for (const plan of plans) {
    if (delivered.has(plan.key)) continue
    delivered.add(plan.key)
    try {
      await rt.deliver({
        toId: plan.toId,
        text: plan.text,
        role: plan.role ?? 'nudge',
        exchangeId: `wk_${plan.key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}_${Date.now()}`,
      })
    } catch (err) {
      rt.warn?.('ds-bot: waker deliver failed for %s: %s', plan.key, err)
    }
  }
}

export function install(rt) {
  Object.assign(rt, {
    planWakes: (eventType, eventData) => planWakes(rt, eventType, eventData),
    executePlanWakes: (plans, delivered) => executePlanWakes(rt, plans, delivered),
  })
}
