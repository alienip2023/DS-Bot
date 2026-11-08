/**
 * M3: open the chat of a joined (remote) Bot.
 *
 * NODE SIDE (runs on the remote machine's ds-bot):
 *   createBotPageReceiver(rt) → async (spec) → { ok, sessionId, items, cursor }
 *   exposeBotPageReceiver(ctx, accept) → ctx.provide('remote-agent:bot-page', accept)
 *
 * HUB SIDE (runs on the controller's ds-bot):
 *   joinedChatPage(rt, botId, cursor) → { sessionId, items, cursor }
 *   Sends a bot/history frame to the node and waits for bot/history-result.
 *   On node offline or timeout returns { sessionId: botId, items: [offline-item], cursor: null }.
 */
import { randomUUID } from 'node:crypto'
import { checkWorkDirRoots } from './joined-create.js'
import { joinedShadow } from './roster-join.js'

const JOINED_HISTORY_TIMEOUT_MS = 15_000

// ── hub side ─────────────────────────────────────────────────────────────────

function listenBotHistoryResult(registry, requestId, nodeId, timeoutMs) {
  let settled = false
  let resolve
  const pending = new Promise((res) => { resolve = res })
  const finish = (value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    registry.off?.('botHistoryResult', onResult)
    registry.off?.('nodeOffline', onOffline)
    resolve(value)
  }
  const onResult = (payload) => {
    if (payload?.requestId !== requestId) return
    finish(payload)
  }
  const onOffline = (payload) => {
    if (payload?.nodeId && payload.nodeId !== nodeId) return
    finish({ ok: false, error: 'bridge-down', requestId })
  }
  const timer = setTimeout(() => finish(undefined), timeoutMs)
  timer.unref?.()
  registry.on?.('botHistoryResult', onResult)
  registry.on?.('nodeOffline', onOffline)
  return { pending, cancel: () => finish({ ok: false, error: 'bridge-down', requestId }) }
}

export async function joinedChatPage(rt, botId, cursor) {
  const bot = rt.botOf?.(botId)
  const nid = bot?.worker?.nodeId ?? ''
  const remoteBotId = bot?.worker?.remoteBotId ?? ''
  const offlinePage = (message) => ({
    sessionId: botId,
    items: [{ kind: 'bot', text: message, time: Date.now() }],
    cursor: null,
  })
  if (nid === '' || remoteBotId === '') return offlinePage('副机 Bot 信息不完整，无法读取对话。')

  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  if (!registry) return offlinePage('副机插件不可用，暂时看不到对话。')

  const node = registry.nodes?.get?.(nid)
  if (!node?.online) return offlinePage('副机离线，暂时看不到对话。')

  const requestId = randomUUID()
  const timeoutMs = rt.joinedHistoryTimeoutMs ?? JOINED_HISTORY_TIMEOUT_MS
  const wait = listenBotHistoryResult(registry, requestId, nid, timeoutMs)
  const sent = registry.send(nid, 'bot/history', {
    nodeId: nid,
    requestId,
    remoteBotId,
    cursor: cursor ?? null,
  })
  if (sent !== true) {
    wait.cancel()
    return offlinePage('副机桥已断，暂时看不到对话。')
  }
  const result = await wait.pending
  if (!result || result.ok === false) {
    return offlinePage('副机暂时无法返回对话（' + (result?.error ?? '超时') + '）。')
  }
  return {
    sessionId: result.sessionId || botId,
    items: result.items ?? [],
    cursor: result.cursor ?? null,
  }
}

// ── node side ─────────────────────────────────────────────────────────────────

export function createBotPageReceiver(rt) {
  return async function acceptBotPage(spec) {
    const remoteBotId = typeof spec?.remoteBotId === 'string' ? spec.remoteBotId.trim() : ''
    if (remoteBotId === '') return { ok: false, error: 'bot-history-remoteBotId-missing' }
    if (typeof rt.chatPage !== 'function') return { ok: false, error: 'bot-history-no-chatPage' }
    try {
      const page = await rt.chatPage(remoteBotId, spec?.cursor ?? undefined)
      return { ok: true, sessionId: page.sessionId ?? '', items: page.items ?? [], cursor: page.cursor ?? null }
    } catch (err) {
      return { ok: false, error: 'bot-history-failed: ' + (err?.message ?? String(err)) }
    }
  }
}

export function exposeBotPageReceiver(ctx, accept) {
  try { ctx?.provide?.('remote-agent:bot-page', accept) } catch { /* registry plugin may be absent */ }
}

export function install(rt) {
  rt.joinedChatPage = (botId, cursor) => joinedChatPage(rt, botId, cursor)
  rt.joinedUpdateBot = (botId, patch) => joinedUpdateBot(rt, botId, patch)
  const pageAccept = createBotPageReceiver(rt)
  exposeBotPageReceiver(rt.ctx, pageAccept)
  const updateAccept = createBotUpdateReceiver(rt)
  exposeBotUpdateReceiver(rt.ctx, updateAccept)
}
// ── bot/update hub side ───────────────────────────────────────────────────────
const BOT_UPDATE_TIMEOUT_MS = 30000

function listenBotUpdateResult(registry, requestId, nodeId, timeoutMs) {
  let finish
  const pending = new Promise((resolve, reject) => { finish = { resolve, reject } })
  const onResult = (r) => {
    if (r?.requestId !== requestId) return
    registry.off?.('botUpdateResult', onResult)
    clearTimeout(timer)
    finish.resolve(r)
  }
  registry.on?.('botUpdateResult', onResult)
  const timer = setTimeout(() => {
    registry.off?.('botUpdateResult', onResult)
    finish.resolve({ requestId, ok: false, error: 'bot-update-timeout' })
  }, timeoutMs)
  if (timer.unref) timer.unref()
  return { pending, cancel: () => { clearTimeout(timer); registry.off?.('botUpdateResult', onResult); finish.resolve({ requestId, ok: false, error: 'bridge-down' }) } }
}

/**
 * Hub side: send bot/update to the node and await the result.
 * Updates the shadow row on success.
 */
export async function joinedUpdateBot(rt, botId, patch) {
  const bot = rt.botOf?.(botId)
  if (!bot || bot.origin !== 'joined' || bot.worker?.home !== 'remote') return { ok: false, error: 'bot-not-joined' }
  const { nodeId, remoteBotId } = bot.worker ?? {}
  if (!nodeId || !remoteBotId) return { ok: false, error: 'bot-update-missing-worker' }

  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  if (!registry || typeof registry.send !== 'function') return { ok: false, error: 'bridge-down' }

  const online = typeof registry.onlineNodes === 'function' ? registry.onlineNodes() : []
  if (!online.some(n => n.nodeId === nodeId)) return { ok: false, error: 'node-offline' }

  const requestId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)
  const timeoutMs = rt.botUpdateTimeoutMs ?? BOT_UPDATE_TIMEOUT_MS
  const waiter = listenBotUpdateResult(registry, requestId, nodeId, timeoutMs)

  const sent = registry.send(nodeId, 'bot/update', {
    nodeId, requestId, remoteBotId,
    model: patch.model ?? null,
    effort: patch.effort ?? null,
    instructions: patch.instructions ?? null,
    workDir: patch.workDir ?? null,
  })
  if (sent !== true) {
    waiter.cancel()
    return { ok: false, error: 'bridge-down' }
  }

  const result = await waiter.pending
  if (!result?.ok) return { ok: false, error: result?.error ?? 'bot-update-failed' }

  // Sync shadow row — write both bot.model (what UI reads via modelOf) and bot.worker.model
  if (result.model !== undefined && result.model !== null) {
    if (!bot.worker) bot.worker = {}
    bot.worker.model = result.model
    bot.model = result.model
  }
  if (result.effort !== undefined) bot.effort = result.effort
  await rt.save?.()
  return { ok: true, model: result.model, effort: result.effort, instructions: result.instructions, workDir: result.workDir }
}

// ── bot/update node side ──────────────────────────────────────────────────────
export function createBotUpdateReceiver(rt) {
  return async function acceptBotUpdate(spec) {
    const remoteBotId = typeof spec?.remoteBotId === 'string' ? spec.remoteBotId.trim() : ''
    if (!remoteBotId) return { ok: false, error: 'bot-update-remoteBotId-missing' }
    if (typeof rt.updateBot !== 'function') return { ok: false, error: 'bot-update-no-roster' }

    const workDir = spec.workDir ?? null
    const modelRef = typeof spec.model === 'string' ? spec.model : null

    // workDir boundary check — reuse shared checkWorkDirRoots (fail-closed, same as createBotCreateReceiver)
    if (workDir !== null) {
      const wdErr = checkWorkDirRoots(rt, workDir)
      if (wdErr) return { ok: false, error: 'bot-update-workdir-denied' }
    }

    // model validation against node catalog (if llm available)
    if (modelRef !== null) {
      const providerId = modelRef.includes('/') ? modelRef.split('/')[0] : modelRef
      const llm = rt.ctx?.get?.('llm') ?? rt.ctx?.llm
      if (!llm || typeof llm.listProviders !== 'function') {
        return { ok: false, error: 'bot-update-model-unknown' }
      }
      const providerIds = llm.listProviders().map(p => typeof p === 'string' ? p : p.id)
      if (!providerIds.includes(providerId)) return { ok: false, error: 'bot-update-model-unknown' }
    }

    try {
      const patch = {}
      if (spec.model !== null) patch.model = spec.model
      if (spec.effort !== null) patch.effort = spec.effort
      if (spec.instructions !== null) patch.instructions = spec.instructions
      if (spec.workDir !== null) patch.workDir = spec.workDir
      const bot = await rt.updateBot(remoteBotId, patch)
      if (!bot) return { ok: false, error: 'bot-update-not-found' }
      return { ok: true, model: bot.model ?? null, effort: bot.effort ?? null, instructions: bot.instructions ?? null, workDir: bot.workDir ?? null }
    } catch (err) {
      return { ok: false, error: 'bot-update-failed: ' + (err?.message ?? String(err)) }
    }
  }
}

export function exposeBotUpdateReceiver(ctx, accept) {
  try { ctx?.provide?.('remote-agent:bot-update', accept) } catch { /* registry plugin may be absent */ }
}

