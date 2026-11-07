// Step 3: create a Bot on a remote node from the main controller.
// No local session is created. No handleRemoteTurn, no mode:'agent', no task/start.
import { randomUUID } from 'node:crypto'
import { shadowId } from './roster-join.js'

export const BOT_CREATE_TIMEOUT_MS = 30_000

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function listenBotCreateResult(registry, requestId, nodeId, timeoutMs) {
  let settled = false
  let resolve
  const pending = new Promise((res) => { resolve = res })
  const finish = (value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    registry.off?.('botCreateResult', onResult)
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
  registry.on?.('botCreateResult', onResult)
  registry.on?.('nodeOffline', onOffline)
  return { pending, cancel: () => finish({ ok: false, error: 'bridge-down', requestId }) }
}

/**
 * 在指定 node 上新建一个 Bot，成功后写入影子行。
 * 返回影子行 id（成功）或 { ok: false, error }（失败）。
 */
export async function createBotOnNode(rt, { nodeId, name, role } = {}) {
  const nid = trimmed(nodeId)
  if (nid === '') return { ok: false, error: 'bot-create-nodeId-missing' }
  if (!name || trimmed(name) === '') return { ok: false, error: 'bot-create-name-missing' }

  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  if (!registry || typeof registry.send !== 'function') {
    return { ok: false, error: 'bridge-down' }
  }

  // node 必须在在线注册表里
  const online = typeof registry.onlineNodes === 'function' ? registry.onlineNodes() : []
  const found = online.some((n) => n.nodeId === nid)
  if (!found) return { ok: false, error: 'node-unknown' }

  const requestId = randomUUID()
  const timeoutMs = rt.botCreateTimeoutMs ?? BOT_CREATE_TIMEOUT_MS
  const wait = listenBotCreateResult(registry, requestId, nid, timeoutMs)

  const sent = registry.send(nid, 'bot/create', {
    nodeId: nid,
    name: trimmed(name).slice(0, 40),
    role: typeof role === 'string' ? trimmed(role).slice(0, 24) : '',
    requestId,
  })
  if (sent !== true) {
    wait.cancel()
    return { ok: false, error: 'bridge-down' }
  }

  const result = await wait.pending
  if (!result || result.error === 'bridge-down') {
    return { ok: false, error: result?.error ?? 'bot-create-lost' }
  }
  if (result.ok === false) {
    return { ok: false, error: result.error ?? 'bot-create-failed' }
  }

  // 副机创建成功，upsert 影子行（与 applyRosterReport 相同字段合同）
  const remoteBotId = trimmed(result.remoteBotId)
  if (remoteBotId === '') return { ok: false, error: 'bot-create-result-remoteBotId-missing' }

  const shadowBotId = shadowId(nid, remoteBotId)
  const hostname = result.hostname ?? nid
  const now = Date.now()
  if (!rt.state.bots || typeof rt.state.bots !== 'object') rt.state.bots = {}
  const existing = rt.state.bots[shadowBotId]
  rt.state.bots[shadowBotId] = {
    ...(existing ?? {}),
    id: shadowBotId,
    name: (result.name || trimmed(name)).slice(0, 40),
    role: (result.role || (typeof role === 'string' ? trimmed(role) : '')).slice(0, 24),
    type: 'remote-worker',
    origin: 'joined',
    createdAt: existing?.createdAt ?? now,
    capabilities: existing?.capabilities ?? [],
    worker: {
      ...(existing?.worker ?? {}),
      nodeId: nid,
      remoteBotId,
      hostname,
      home: 'remote',
      online: true,
      lastSeen: now,
    },
  }
  void rt.save?.()
  return { ok: true, id: shadowBotId, remoteBotId, name: rt.state.bots[shadowBotId].name }
}

/**
 * 副机侧：注册 remote-agent:bot-create 接收方，本地调用 createBot。
 * 建出来的是普通本地 Bot（不带 type:'remote-worker'），让 reportableBots 能上报它。
 */
export function createBotCreateReceiver(rt) {
  return async function acceptBotCreate(spec) {
    const name = trimmed(spec?.name)
    if (!name) return { ok: false, error: 'bot-create-name-missing' }
    const role = typeof spec?.role === 'string' ? trimmed(spec.role) : ''

    // roster.js install 把 createBot 挂到 rt 上（见 roster.js Object.assign(rt, {...createBot...})）
    const createBot = rt.createBot
    if (typeof createBot !== 'function') return { ok: false, error: 'bot-create-no-roster' }

    try {
      // 不传 type:'remote-worker'，建出来是普通本地 Bot，reportableBots 才会上报
      const id = await createBot({ name, role })
      const bot = rt.state?.bots?.[id]
      return {
        ok: true,
        remoteBotId: id,
        name: bot?.name ?? name,
        role: bot?.role ?? role,
      }
    } catch (err) {
      return { ok: false, error: typeof err?.message === 'string' ? err.message : 'bot-create-failed' }
    }
  }
}

export function install(rt) {
  rt.createBotOnNode = (opts) => createBotOnNode(rt, opts)
  const accept = createBotCreateReceiver(rt)
  try { rt.ctx?.set?.('remote-agent:bot-create', accept) } catch { /* registry plugin may be absent */ }
}
