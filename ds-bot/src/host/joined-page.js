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
  const accept = createBotPageReceiver(rt)
  exposeBotPageReceiver(rt.ctx, accept)
}
