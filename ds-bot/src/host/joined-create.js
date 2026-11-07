// Step 3: create a Bot on a remote node from the main controller.
// No local session is created. No handleRemoteTurn, no mode:'agent', no task/start.
import { randomUUID } from 'node:crypto'
import { resolve as pathResolve } from 'node:path'
import { shadowId } from './roster-join.js'

export const BOT_CREATE_TIMEOUT_MS = 30_000
const MAX_INSTRUCTIONS_BYTES = 8000

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
export async function createBotOnNode(rt, { nodeId, name, role, modelRef = null, effort = null, workDir = null, instructions = null } = {}) {
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

  // Hub-side: resolve modelRef to provider/model using rt.resolveModel if available.
  // A bare model id that maps to exactly one provider is normalised; unknown id → error.
  let resolvedModelRef = modelRef ?? null
  if (modelRef !== null && typeof rt.resolveModel === 'function') {
    try {
      resolvedModelRef = await rt.resolveModel(modelRef)
    } catch (err) {
      return { ok: false, error: 'bot-create-model-unknown' }
    }
  }

  // Enforce instructions byte limit (§1.1 contract: ≤8000 bytes).
  let clampedInstructions = instructions ?? null
  if (typeof clampedInstructions === 'string') {
    const buf = Buffer.from(clampedInstructions, 'utf8')
    if (buf.byteLength > MAX_INSTRUCTIONS_BYTES) clampedInstructions = buf.subarray(0, MAX_INSTRUCTIONS_BYTES).toString('utf8')
  }

  const sent = registry.send(nid, 'bot/create', {
    nodeId: nid,
    name: trimmed(name).slice(0, 40),
    role: typeof role === 'string' ? trimmed(role).slice(0, 24) : '',
    requestId,
    modelRef: resolvedModelRef,
    effort: effort ?? null,
    workDir: workDir ?? null,
    instructions: clampedInstructions,
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
    model: resolvedModelRef ?? null,
    effort: effort ?? null,
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
    const modelRef = spec?.modelRef ?? null
    const effort = spec?.effort ?? null
    const workDir = spec?.workDir ?? null
    const instructions = spec?.instructions ?? null

    // roster.js install 把 createBot 挂到 rt 上（见 roster.js Object.assign(rt, {...createBot...})）
    const createBot = rt.createBot
    if (typeof createBot !== 'function') return { ok: false, error: 'bot-create-no-roster' }

    // §4 校验顺序：modelRef → workDir → createBot
    if (modelRef !== null) {
      // Use ds-bot's real model catalog: ctx.llm.listProviders() tells us which providers exist;
      // rt.missingKeys() uses the real credentials service (providers.js:190) to check keys.
      const providerId = modelRef.includes('/') ? modelRef.split('/')[0] : modelRef
      const llm = rt.ctx?.get?.('llm') ?? rt.ctx?.llm
      const providerIds = typeof llm?.listProviders === 'function'
        ? llm.listProviders().map(p => typeof p === 'string' ? p : p.id)
        : null
      if (providerIds !== null) {
        if (!providerIds.includes(providerId)) return { ok: false, error: 'bot-create-model-unknown' }
        const missing = typeof rt.missingKeys === 'function' ? await rt.missingKeys([providerId]) : new Set()
        if (missing.has(providerId)) return { ok: false, error: 'bot-create-model-no-key' }
      }
    }

    if (workDir !== null) {
      // Fail-closed: if node-policy unavailable, reject workDir (never allow-all).
      // Path boundary: compare resolved workDir against root+'/' to prevent prefix attacks
      // (e.g. /root/workevil must not pass /root/work).
      let policy
      try { policy = rt.ctx?.get?.('remote-agent:node-policy') } catch { policy = undefined }
      if (!policy) return { ok: false, error: 'bot-create-workdir-denied' }
      const roots = Array.isArray(policy.roots) ? policy.roots : []
      if (roots.length === 0) return { ok: false, error: 'bot-create-workdir-denied' }
      const resolved = pathResolve(workDir)
      const inRoots = roots.some((r) => resolved === pathResolve(r) || resolved.startsWith(pathResolve(r) + '/'))
      if (!inRoots) return { ok: false, error: 'bot-create-workdir-denied' }
    }

    try {
      // 不传 type:'remote-worker'，建出来是普通本地 Bot，reportableBots 才会上报
      const id = await createBot({ name, role, model: modelRef, effort, workDir, instructions })
      const bot = rt.state?.bots?.[id]
      return {
        ok: true,
        remoteBotId: id,
        name: bot?.name ?? name,
        role: bot?.role ?? role,
      }
    } catch (err) {
      // Log the full stack so journalctl -u dsh-worker captures it for diagnostics.
      rt.warn?.('ds-bot: createBotCreateReceiver failed: %s\n%s', err?.message ?? err, err?.stack ?? '')
      return { ok: false, error: 'bot-create-failed: ' + (err?.message ?? String(err)) }
    }
  }
}

export function exposeBotCreateReceiver(ctx, accept) {
  try { ctx?.provide?.('remote-agent:bot-create', accept) } catch { /* registry plugin may be absent */ }
}

export function install(rt) {
  rt.createBotOnNode = (opts) => createBotOnNode(rt, opts)
  const accept = createBotCreateReceiver(rt)
  exposeBotCreateReceiver(rt.ctx, accept)
}
