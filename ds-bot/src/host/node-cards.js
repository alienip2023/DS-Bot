// node-cards.js — what a node Bot is waiting on someone to answer, and what the hub may do about it.
//
// A node has no screen, so the cards its Bots raise (a tool approval, an ask_user question, a
// learned-skill or project-rule proposal) would sit there unseen. The node reports them, small and
// plain, in its roster report (`cards`, see AC lib/roster-report.js); the hub shows them in the same
// places a local Bot's cards appear and sends the user's answer back as a bot/action frame, which this
// module's executor applies on the node. Nothing is decided here: an unanswered card stays open until
// someone answers it, and a card is never answered on its own.
//
// Card ids carry their kind: `approval:<id>`, `question:<id>`, `learning:<id>`.
import { randomUUID } from 'node:crypto'
import { clampNodeTime, joinedShadow } from './roster-join.js'
import { nodeCan, refusalFor } from './node-compat.js'
import { markHubAsked } from './joined-turn.js'
import { viewCardText } from './parts.js'
import { writeNodeReport } from './executor.js'
import { ensureMirrorSession, mirrorStateOf } from './mirror.js'
import { validateViewAnswer } from 'deep-view/core'

const BODY_MAX = 1900
const DATA_MAX = 6000
const clip = (text, max) => String(text ?? '').slice(0, max)

const APPROVAL = { allow: '允许', reject: '拒绝' }

/** The cards one local Bot is waiting on, as the roster report carries them. */
export function nodeCardsOf(rt, bot) {
  if (!bot || bot.origin === 'joined' || bot.type === 'remote-worker') return []
  const cards = []
  for (const approval of rt.approvalsView?.() ?? []) {
    if (approval.botId !== bot.id || approval.answerable !== true) continue
    const detail = [approval.reason, approval.detail?.text, approval.detail?.code].filter(Boolean).join('\n\n')
    cards.push({
      id: `approval:${approval.id}`, kind: 'approval',
      title: `${approval.tool ?? 'tool'}${approval.taskTitle ? ` · ${approval.taskTitle}` : ''}`,
      body: clip(detail, BODY_MAX),
      options: Object.entries(APPROVAL).map(([id, label]) => ({ id, label })), input: false,
      at: approval.at ?? 0,
    })
  }
  const question = rt.state?.questions?.[rt.chatOf?.(bot.id)]
  if (question !== undefined) {
    const lines = (question.options ?? []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    cards.push({
      id: `question:${question.id}`, kind: 'question', title: clip(question.question, 120),
      body: clip([question.detail, ...lines].filter(Boolean).join('\n'), BODY_MAX),
      options: (question.options ?? []).slice(0, 8).map((option, index) => ({ id: String(index), label: clip(option.label, 60) })),
      input: question.allowCustom === true, at: question.askedAt ?? 0,
    })
  }
  // A form the Bot put on screen and waits on (show_view). The hub needs its definition to draw and
  // answer it, so the view travels whole as `data` (when it is too big for the report the card stays
  // readable but cannot be answered from the hub).
  const view = rt.state?.views?.[rt.chatOf?.(bot.id)]
  if (view !== undefined && view.id) {
    const data = JSON.stringify({ title: view.title, view: view.view })
    cards.push({
      id: `view:${view.id}`, kind: 'view', title: clip(view.title ?? '', 120),
      body: clip(viewCardText({ title: view.title, view: view.view }) ?? '', BODY_MAX),
      options: [], input: false, at: view.askedAt ?? 0,
      ...(data.length <= DATA_MAX ? { data } : {}),
    })
  }
  // A request for a secret is answered where secrets live (the node's own store); the hub tells the
  // user it is waiting, it never carries the value.
  for (const request of rt.state?.secretRequests?.[bot.id] ?? []) {
    if (request?.status !== 'pending') continue
    cards.push({
      id: `secret:${request.id}`, kind: 'secret',
      title: clip(`${request.kind === 'fill' ? '需要密钥的值' : '请求使用密钥'}：${request.name ?? ''}`, 120),
      body: clip(`${request.purpose ?? ''}\n\n请在这台节点的 ds-bot 里处理这个请求（密钥不会经过主控）。`.trim(), BODY_MAX),
      options: [], input: false, at: request.askedAt ?? 0,
    })
  }
  for (const proposal of rt.learningView?.()?.[bot.id] ?? []) {
    const isRule = proposal.kind === 'agents'
    const options = isRule
      ? [{ id: 'approve', label: '采纳' }, { id: 'decline', label: '不采纳' }]
      : [{ id: 'approve', label: '采纳' }, { id: 'approve-team', label: '采纳并共享给团队' }, { id: 'decline', label: '不采纳' }]
    const body = isRule
      ? `项目规则（${proposal.folder ?? ''}）\n${(proposal.edits ?? []).map(edit => `${edit.op ?? 'edit'}: ${edit.text ?? ''}`).join('\n')}`
      : `${proposal.action === 'update' ? '更新技能' : '新技能'}：${proposal.name ?? ''}\n${proposal.description ?? ''}\n\n${proposal.content ?? ''}`
    cards.push({
      id: `learning:${proposal.id}`, kind: isRule ? 'rule' : 'skill',
      title: isRule ? '要不要记住这条项目规则？' : `要不要保留这个技能：${proposal.name ?? ''}`,
      body: clip(body, BODY_MAX), options, input: false, at: proposal.at ?? 0,
    })
  }
  return cards
}

const refuse = (error) => ({ ok: false, error })

/**
 * The node's bot/action receiver: { remoteBotId, action, params } → { ok, error?, detail? }.
 * A card id or a task id that no longer exists is a refusal the hub tells the user about, not a crash.
 */
export function createBotActionReceiver(rt) {
  const localBot = (id) => {
    const bot = rt.botOf?.(id) ?? rt.state?.bots?.[id]
    return bot !== undefined && !joinedShadow(bot) && bot.type !== 'remote-worker' ? bot : undefined
  }

  async function answerCard(bot, params) {
    const cardId = String(params.cardId ?? '')
    const split = cardId.indexOf(':')
    const kind = cardId.slice(0, split)
    const id = cardId.slice(split + 1)
    if (split < 1 || id === '') return refuse('card-id-invalid')

    if (kind === 'approval') {
      const entry = (rt.approvalsView?.() ?? []).find(item => item.id === id && item.botId === bot.id)
      if (entry === undefined) return refuse('card-stale')
      if (params.choice !== 'allow' && params.choice !== 'reject') return refuse('choice-invalid')
      await rt.answerApproval(id, params.choice, { sessionId: entry.sessionId, fingerprint: entry.fingerprint })
      return { ok: true }
    }

    if (kind === 'question') {
      const sessionId = rt.chatOf?.(bot.id)
      const question = rt.state?.questions?.[sessionId]
      if (question === undefined || question.id !== id) return refuse('card-stale')
      const picked = params.choice === undefined ? undefined : question.options?.[Number(params.choice)]
      if (params.choice !== undefined && picked === undefined) return refuse('choice-invalid')
      await rt.answerQuestion(sessionId, id, { selected: picked === undefined ? [] : [picked.label], ...(params.text ? { custom: params.text } : {}) })
      return { ok: true }
    }

    if (kind === 'view') {
      const sessionId = rt.chatOf?.(bot.id)
      const pending = rt.state?.views?.[sessionId]
      if (pending === undefined || pending.id !== id) return refuse('card-stale')
      let answer
      try { answer = JSON.parse(String(params.text ?? '')) } catch { return refuse('view-answer-invalid') }
      if (typeof answer?.action !== 'string' || answer.action === '') return refuse('view-answer-invalid')
      await rt.answerView(sessionId, id, answer.action, answer.values ?? {})
      return { ok: true }
    }

    if (kind === 'learning') {
      const open = (rt.learningView?.()?.[bot.id] ?? []).some(item => item.id === id)
      if (!open) return refuse('card-stale')
      const choice = params.choice
      if (!['approve', 'approve-team', 'decline'].includes(choice)) return refuse('choice-invalid')
      const result = await rt.learningEndpoint('learning-answer', { id, approve: choice !== 'decline', teamReusable: choice === 'approve-team' })
      return { ok: true, detail: result?.applied === true ? 'applied' : 'declined' }
    }
    return refuse('card-kind-unknown')
  }

  async function taskOf(bot, taskId) {
    const task = (bot.tasks ?? []).find(item => item?.id === taskId)
    return task
  }

  return async function botAction({ remoteBotId, action, params = {} } = {}) {
    const bot = localBot(String(remoteBotId ?? ''))
    if (bot === undefined) return refuse('bot-not-on-roster')
    try {
      if (action === 'card-answer') return await answerCard(bot, params)
      if (action === 'task-stop') {
        if (await taskOf(bot, params.taskId) === undefined) return refuse('task-unknown')
        const stopped = await rt.stopTask(bot.id, params.taskId, '由主控停止')
        return { ok: true, detail: stopped ? 'stopped' : 'already-ended' }
      }
      if (action === 'task-start') {
        // A new task on this Bot, started for the user from the hub (the "ask me" choice).
        const text = String(params.text ?? '').trim()
        if (text === '') return refuse('text-missing')
        // The hub asked this Bot to work: what the task reports later is owed to that hub.
        markHubAsked(rt, bot)
        const task = await rt.startTask(rt.chatOf(bot.id), { title: text.replace(/\s+/g, ' ').slice(0, 60) || 'Task', brief: text, relation: params.relation === 'independent' ? 'independent' : 'related' })
        return { ok: true, detail: task?.id }
      }
      if (action === 'task-send') {
        if (await taskOf(bot, params.taskId) === undefined) return refuse('task-unknown')
        markHubAsked(rt, bot)
        await rt.deliverToTask(params.taskId, { text: String(params.text ?? '') })
        return { ok: true }
      }
      return refuse('action-unknown')
    } catch (error) {
      // bot/stale and friends carry a code: the hub shows it as the reason.
      return refuse(String(error?.code ?? error?.message ?? 'action-failed').slice(0, 200))
    }
  }
}

// ── The hub: show a node Bot's cards where a local Bot's appear, send the answer back ────────────

const ACTION_TIMEOUT_MS = 15_000
const REASONS = {
  'bot-action-no-receiver': '节点上的 ds-bot 版本太旧，不支持从主控操作',
  'card-stale': '这张卡已经不在节点上了',
  'task-unknown': '节点上没有这个任务',
  'bot-not-on-roster': '节点上没有这个 Bot',
  'bot-action-timeout': '节点没有及时回应',
}

/** The node Bots (joined shadows that are up) with what they are waiting on. */
function remoteBots(rt) {
  return Object.values(rt.state?.bots ?? {}).filter(bot => joinedShadow(bot) && bot.worker?.online !== false)
}
// A card's age is read against the hub's clock: a node timestamp in the hub's future or a month old
// shows as the time the report that carried it arrived (applyRosterReport already stored it so).
const seenAt = (bot, card) => (Number.isFinite(bot.worker?.lastSeen) ? clampNodeTime(card.at, bot.worker.lastSeen) : card.at)
const mirrorSessionOf = (rt, bot) => rt.chatOf?.(bot.id) ?? bot.sessionId
function remoteCard(rt, cardId) {
  for (const bot of remoteBots(rt)) {
    const card = (bot.nodeCards ?? []).find(item => item.id === cardId)
    if (card !== undefined) return { bot, card }
  }
  return undefined
}
function remoteTask(rt, taskId) {
  for (const bot of remoteBots(rt)) {
    const task = (bot.nodeTasks ?? []).find(item => item.id === taskId)
    if (task !== undefined) return { bot, task }
  }
  return undefined
}

/** One bot/action to the node, answered by its bot/action-result (or refused, or timed out). */
export async function sendBotAction(rt, bot, action, params, { timeoutMs = ACTION_TIMEOUT_MS } = {}) {
  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  const nodeId = bot.worker?.nodeId
  const remoteBotId = bot.worker?.remoteBotId
  if (typeof registry?.send !== 'function' || !nodeId || !remoteBotId) {
    throw Object.assign(new Error('节点不在线，无法操作'), { code: 'bot/refused' })
  }
  if (!nodeCan(rt, bot, 'actions')) throw Object.assign(new Error(refusalFor('actions')), { code: 'bot/refused' })
  const requestId = randomUUID()
  const result = await new Promise((resolve, reject) => {
    let timer
    const onResult = (payload) => {
      if (payload?.requestId !== requestId || (payload.nodeId && payload.nodeId !== nodeId)) return
      clearTimeout(timer)
      registry.off?.('botActionResult', onResult)
      resolve(payload)
    }
    timer = setTimeout(() => {
      registry.off?.('botActionResult', onResult)
      reject(Object.assign(new Error(REASONS['bot-action-timeout']), { code: 'bot/refused' }))
    }, timeoutMs)
    timer.unref?.()
    registry.on?.('botActionResult', onResult)
    let sent = false
    try { sent = registry.send(nodeId, 'bot/action', { nodeId, remoteBotId, requestId, action, params }) === true } catch { sent = false }
    if (!sent) {
      clearTimeout(timer)
      registry.off?.('botActionResult', onResult)
      reject(Object.assign(new Error('节点不在线，无法操作'), { code: 'bot/refused' }))
    }
  })
  if (result.ok !== true) {
    const reason = String(result.error ?? 'action-failed')
    throw Object.assign(new Error(REASONS[reason] ?? reason), { code: reason === 'card-stale' ? 'bot/stale' : 'bot/refused' })
  }
  return result
}

// A card the user just answered is gone from the page at once, not at the node's next report.
async function dropCard(rt, bot, cardId) {
  if (!Array.isArray(bot.nodeCards)) return
  bot.nodeCards = bot.nodeCards.filter(card => card.id !== cardId)
  await rt.save?.().catch(() => {})
}

export function installHub(rt) {
  // What the node Bots wait on, in the shapes the page already draws for a local Bot.
  rt.nodeQuestionsView = () => Object.fromEntries(remoteBots(rt).flatMap((bot) => {
    const card = (bot.nodeCards ?? []).find(item => item.kind === 'question')
    const sessionId = mirrorSessionOf(rt, bot)
    if (card === undefined || !sessionId) return []
    return [[sessionId, {
      id: card.id, question: card.title, options: card.options.map(option => ({ label: option.label })),
      multiSelect: false, ...(card.input ? { allowCustom: true } : {}), askedAt: seenAt(bot, card), remote: true,
    }]]
  }))

  const approvalsView = rt.approvalsView
  if (typeof approvalsView === 'function') {
    rt.approvalsView = () => [...approvalsView(), ...remoteBots(rt).flatMap(bot => (bot.nodeCards ?? []).filter(card => card.kind === 'approval').map(card => ({
      id: card.id, botId: bot.id, sessionId: mirrorSessionOf(rt, bot), tool: card.title, reason: '', detail: { text: card.body },
      fingerprint: card.id, at: seenAt(bot, card), answerable: true, remote: true,
    })))]
  }
  const learningView = rt.learningView
  if (typeof learningView === 'function') {
    rt.learningView = () => {
      const byBot = { ...learningView() }
      for (const bot of remoteBots(rt)) {
        const proposals = (bot.nodeCards ?? []).filter(card => card.kind === 'skill' || card.kind === 'rule').map(card => ({
          id: card.id, kind: 'skill', action: 'create', botId: bot.id, name: card.title, description: '', content: card.body, at: seenAt(bot, card), remote: true,
        }))
        if (proposals.length > 0) byBot[bot.id] = [...(byBot[bot.id] ?? []), ...proposals]
      }
      return byBot
    }
  }
  // The forms node Bots wait on, in the shape the page draws for a local Bot's show_view.
  rt.nodeViewsView = () => Object.fromEntries(remoteBots(rt).flatMap((bot) => {
    const card = (bot.nodeCards ?? []).find(item => item.kind === 'view' && typeof item.data === 'string')
    const sessionId = mirrorSessionOf(rt, bot)
    if (card === undefined || !sessionId) return []
    let parsed
    try { parsed = JSON.parse(card.data) } catch { return [] }
    if (parsed?.view === undefined) return []
    return [[sessionId, { id: card.id.slice('view:'.length), title: parsed.title ?? card.title, view: parsed.view, askedAt: seenAt(bot, card), remote: true }]]
  }))
  const answerView = rt.answerView
  if (typeof answerView === 'function') {
    rt.answerView = async function (sessionRef, viewId, action, values, ...rest) {
      const found = remoteCard(rt, `view:${String(viewId ?? '')}`)
      if (found === undefined) return answerView.call(this, sessionRef, viewId, action, values, ...rest)
      let parsed
      try { parsed = JSON.parse(found.card.data ?? '') } catch { parsed = undefined }
      if (parsed?.view === undefined) throw Object.assign(new Error('这张表单太大，请在节点上回答'), { code: 'bot/invalid' })
      const checked = validateViewAnswer(parsed.view, action, values)
      if (checked.error !== undefined) throw Object.assign(new Error(checked.error), { code: 'bot/invalid' })
      const text = JSON.stringify({ action, values: values ?? {} })
      if (text.length > 4000) throw Object.assign(new Error('答案太长，无法发送到节点'), { code: 'bot/invalid' })
      await sendBotAction(rt, found.bot, 'card-answer', { cardId: found.card.id, text })
      await dropCard(rt, found.bot, found.card.id)
      return true
    }
  }
  rt.nodeTaskOf = (bot, taskId) => (joinedShadow(bot) ? (bot.nodeTasks ?? []).find(task => task.id === taskId) : undefined)

  const answerApproval = rt.answerApproval
  if (typeof answerApproval === 'function') {
    rt.answerApproval = function (id, choice, ...rest) {
      const found = remoteCard(rt, String(id ?? ''))
      if (found === undefined) return answerApproval.call(this, id, choice, ...rest)
      const mapped = choice === 'allow' ? 'allow' : 'reject'
      return sendBotAction(rt, found.bot, 'card-answer', { cardId: found.card.id, choice: mapped }).then(() => dropCard(rt, found.bot, found.card.id))
    }
  }
  const answerQuestion = rt.answerQuestion
  if (typeof answerQuestion === 'function') {
    rt.answerQuestion = async function (sessionRef, questionId, answer, ...rest) {
      const found = remoteCard(rt, String(questionId ?? ''))
      if (found === undefined) return answerQuestion.call(this, sessionRef, questionId, answer, ...rest)
      const label = Array.isArray(answer?.selected) ? answer.selected[0] : undefined
      const option = found.card.options.find(item => item.label === label)
      const text = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
      if (option === undefined && text === '') throw Object.assign(new Error('Nothing to send'), { code: 'bot/invalid' })
      await sendBotAction(rt, found.bot, 'card-answer', { cardId: found.card.id, ...(option ? { choice: option.id } : {}), ...(text ? { text } : {}) })
      await dropCard(rt, found.bot, found.card.id)
      return true
    }
  }
  const learningEndpoint = rt.learningEndpoint
  if (typeof learningEndpoint === 'function') {
    rt.learningEndpoint = async function (endpoint, body, ...rest) {
      const found = endpoint === 'learning-answer' ? remoteCard(rt, String(body?.id ?? '')) : undefined
      if (found === undefined) return learningEndpoint.call(this, endpoint, body, ...rest)
      const choice = body.approve === true ? (body.teamReusable === true ? 'approve-team' : 'approve') : 'decline'
      await sendBotAction(rt, found.bot, 'card-answer', { cardId: found.card.id, choice })
      await dropCard(rt, found.bot, found.card.id)
      return { applied: body.approve === true }
    }
  }
  const stopTask = rt.stopTask
  if (typeof stopTask === 'function') {
    rt.stopTask = async function (botId, taskId, ...rest) {
      const bot = rt.botOf?.(botId)
      if (!joinedShadow(bot) || rt.nodeTaskOf(bot, taskId) === undefined) return stopTask.call(this, botId, taskId, ...rest)
      const result = await sendBotAction(rt, bot, 'task-stop', { taskId })
      return result.detail === 'stopped'
    }
  }
  const deliverToTask = rt.deliverToTask
  if (typeof deliverToTask === 'function') {
    rt.deliverToTask = async function (taskId, options = {}, ...rest) {
      const found = remoteTask(rt, String(taskId ?? ''))
      if (found === undefined) return deliverToTask.call(this, taskId, options, ...rest)
      await sendBotAction(rt, found.bot, 'task-send', { taskId, text: String(options?.text ?? '') })
      return true
    }
  }
}

export function install(rt) {
  rt.nodeCardsOf = bot => nodeCardsOf(rt, bot)
  const receiver = createBotActionReceiver(rt)
  rt.botAction = receiver
  // AC's node plugin finds the receiver under this name (an older AC never asks).
  try { rt.ctx?.provide?.('remote-agent:bot-action', receiver) } catch { /* registry plugin may be absent */ }
  installHub(rt)
  rt.noticeNodeCards = nodeId => noticeUnanswerableCards(rt, nodeId)
}

// ── Cards the hub cannot answer: say so on the page, once each ───────────────────────────────────

const NOTICE_MARK = '⚠ 节点在等你'
const NOTICE_KEPT = 40
const answerableHere = card => card.kind === 'approval' || card.kind === 'question' || card.kind === 'skill' || card.kind === 'rule'
  || (card.kind === 'view' && typeof card.data === 'string')

/**
 * A card that cannot be answered from here (a secret request, a form too large to ship, a kind this
 * hub does not know) would sit on the node unseen. It is written once into the Bot's conversation, so
 * the user learns the node is waiting; the ids already told are kept on the Bot's row so a restart
 * does not tell them again.
 */
export async function noticeUnanswerableCards(rt, nodeId) {
  for (const bot of remoteBots(rt)) {
    if (bot.worker?.nodeId !== nodeId) continue
    const told = new Set(bot.noticedCardIds ?? [])
    const fresh = (bot.nodeCards ?? []).filter(card => !answerableHere(card) && !told.has(card.id))
    if (fresh.length === 0) continue
    bot.noticedCardIds = [...told, ...fresh.map(card => card.id)].slice(-NOTICE_KEPT)
    try {
      const session = await ensureMirrorSession(rt, bot)
      for (const card of fresh) {
        const where = card.kind === 'secret' ? '' : '\n（这张卡太大或类型不支持，主控没法回答，请在节点上处理。）'
        writeNodeReport({
          rt, bot, session, state: mirrorStateOf(rt, bot.id, session), mark: NOTICE_MARK,
          text: `${card.title}${card.body ? `\n${card.body}` : ''}${where}`,
        })
      }
      await rt.save?.()
    } catch (error) {
      rt.warn?.('ds-bot: a node card notice was not written: %s', error?.message ?? error)
    }
  }
}
