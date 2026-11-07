// Step 2: a sidebar or bot-to-bot message to a joined shadow runs in that
// remote Bot's existing session. It does not pick a node, does not start an
// agent task, and does not run a model on this Mac.
import { randomUUID } from 'node:crypto'
import { joinedShadow, shadowId } from './roster-join.js'

export const BRIDGE_DOWN_TEXT = '副机仍在执行，桥已断'
export const JOINED_TURN_TIMEOUT_MS = 60 * 60 * 1000
const SKIP_ROLES = new Set(['reply', 'report', 'kickoff', 'continue', 'update'])

export function joinedDispatchRole(role) {
  return !SKIP_ROLES.has(role)
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function listenBotTurnResult(registry, exchangeId, nodeId, timeoutMs) {
  let settled = false
  let resolve
  const pending = new Promise((res) => { resolve = res })
  const finish = (value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    registry.off?.('botTurnResult', onResult)
    registry.off?.('nodeOffline', onOffline)
    resolve(value)
  }
  const onResult = (payload) => {
    if (payload?.exchangeId !== exchangeId) return
    finish(payload)
  }
  const onOffline = (payload) => {
    if (payload?.nodeId && payload.nodeId !== nodeId) return
    finish({ ok: false, error: 'bridge-down', exchangeId })
  }
  const timer = setTimeout(() => finish(undefined), timeoutMs)
  timer.unref?.()
  registry.on?.('botTurnResult', onResult)
  registry.on?.('nodeOffline', onOffline)
  return { pending, cancel: () => finish({ ok: false, error: 'bridge-down', exchangeId }) }
}

async function replyToSender(rt, { fromId, toId, exchangeId, work, text }) {
  const shadow = rt.botOf?.(toId)
  if (shadow?.worker) shadow.worker.lastReply = { exchangeId, text, at: Date.now() }
  if (rt.state && Array.isArray(rt.state.exchanges)) {
    rt.state.exchanges.push({
      id: exchangeId,
      from: toId,
      to: fromId ?? toId,
      text,
      role: 'reply',
      replyTo: exchangeId,
      time: Date.now(),
    })
  }
  const sender = fromId ? rt.botOf?.(fromId) : undefined
  if (!sender || sender.id === toId) return
  await rt.deliver?.({
    fromId: toId,
    toId: fromId,
    text,
    role: 'reply',
    replyTo: exchangeId,
    ...(work ? { work } : {}),
  })
}

export async function handleJoinedTurn(rt, msg = {}) {
  const { fromId, toId, text, exchangeId, work } = msg
  const to = rt.botOf?.(toId)
  if (!joinedShadow(to)) return { ok: false, error: 'joined shadow cannot dispatch' }
  const nodeId = trimmed(to.worker?.nodeId)
  const remoteBotId = trimmed(to.worker?.remoteBotId)
  if (nodeId === '' || remoteBotId === '') return { ok: false, error: 'joined shadow missing remoteBotId' }
  const id = shadowId(nodeId, remoteBotId)
  const row = rt.state?.bots?.[id]
  if (!row || row.id !== to.id) return { ok: false, error: 'joined shadow not on roster' }
  const xid = trimmed(exchangeId) || randomUUID()
  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  if (!registry || typeof registry.send !== 'function') {
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: BRIDGE_DOWN_TEXT })
    return { ok: false, error: 'bridge-down' }
  }
  const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : (rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS)
  const wait = listenBotTurnResult(registry, xid, nodeId, timeoutMs)
  const sent = registry.send(nodeId, 'bot/turn', { nodeId, remoteBotId, exchangeId: xid, text: text ?? '' })
  if (sent !== true) {
    wait.cancel()
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: BRIDGE_DOWN_TEXT })
    return { ok: false, error: 'bridge-down' }
  }
  const result = await wait.pending
  if (!result || result.error === 'bridge-down') {
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: BRIDGE_DOWN_TEXT })
    return { ok: false, error: result?.error ?? 'bot-turn-lost' }
  }
  if (result.ok === false) {
    const error = result.error ?? 'bot-turn-failed'
    await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: `副机没有接上：${error}` })
    return { ok: false, error }
  }
  await replyToSender(rt, { fromId, toId, exchangeId: xid, work, text: result.text ?? '' })
  return xid
}

function findLocal(rt, remoteBotId) {
  const bots = rt.state?.bots ?? {}
  const direct = bots[remoteBotId]
  if (direct && direct.id === remoteBotId) return direct
  return Object.values(bots).find((bot) => bot && bot.id === remoteBotId)
}

export function createBotTurnReceiver(rt, { timeoutMs = JOINED_TURN_TIMEOUT_MS } = {}) {
  const pending = new Map()
  rt.settleJoinedTurn = (exchangeId, text, error) => {
    const waiter = pending.get(exchangeId)
    if (!waiter) return false
    pending.delete(exchangeId)
    clearTimeout(waiter.timer)
    if (error) waiter.reject(error)
    else waiter.resolve(typeof text === 'string' ? text : '')
    return true
  }
  return async function acceptJoinedTurn(turn) {
    const remoteBotId = trimmed(turn?.remoteBotId)
    const exchangeId = trimmed(turn?.exchangeId)
    if (remoteBotId === '' || exchangeId === '') return { ok: false, error: 'bot-turn-missing' }
    const bot = findLocal(rt, remoteBotId)
    if (!bot || bot.type === 'remote-worker' || bot.origin === 'joined') return { ok: false, error: 'bot-not-on-roster' }
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(exchangeId)
        reject(Object.assign(new Error('joined-turn-timeout'), { code: 'joined-turn-timeout' }))
      }, timeoutMs)
      timer.unref?.()
      pending.set(exchangeId, { resolve, reject, timer })
    })
    try {
      await rt.deliver({
        toId: bot.id,
        sessionId: rt.chatOf?.(bot.id),
        text: turn.text ?? '',
        role: 'request',
        exchangeId,
        joinedTurn: true,
      })
    } catch {
      const waiter = pending.get(exchangeId)
      if (waiter) {
        pending.delete(exchangeId)
        clearTimeout(waiter.timer)
      }
      return { ok: false, error: 'bot-turn-deliver-failed' }
    }
    try {
      const text = await done
      return { ok: true, exchangeId, text }
    } catch (err) {
      return { ok: false, exchangeId, error: err?.code ?? 'bot-turn-failed', text: '' }
    }
  }
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => typeof block?.text === 'string' ? block.text : '').join('')
}

function wrapSendUser(rt) {
  const orig = rt.sendUser
  if (typeof orig !== 'function' || orig.__joinedTurn === true) return
  const wrapped = async function sendUserJoined(args) {
    const bot = rt.botOf?.(args?.sessionId)
    if (!joinedShadow(bot)) return orig(args)
    const result = await rt.handleJoinedTurn({
      fromId: undefined,
      toId: bot.id,
      text: textOfContent(args?.content),
      role: 'request',
      exchangeId: typeof args?.requestId === 'string' ? args.requestId : undefined,
    })
    if (result && result.ok === false) {
      const message = result.error === 'bridge-down' || result.error === 'bot-turn-lost'
        ? BRIDGE_DOWN_TEXT
        : (result.error ?? 'joined shadow cannot dispatch')
      throw Object.assign(new Error(message), { code: 'bot/joined' })
    }
    return result
  }
  wrapped.__joinedTurn = true
  rt.sendUser = wrapped
}

export function exposeBotTurnReceiver(ctx, accept) {
  try { ctx?.provide?.('remote-agent:bot-turn', accept) } catch { /* registry plugin may be absent */ }
}

export function install(rt) {
  rt.handleJoinedTurn = (msg) => handleJoinedTurn(rt, msg)
  const accept = createBotTurnReceiver(rt)
  exposeBotTurnReceiver(rt.ctx, accept)
  wrapSendUser(rt)
}
