// Step 3: create a Bot on a remote node from the main controller.
// No local session is created. No handleRemoteTurn, no mode:'agent', no task/start.
import { randomUUID } from 'node:crypto'
import { resolve as pathResolve, sep as pathSep } from 'node:path'
import { ensureMainThread } from './bot-store.js'
import { shadowId } from './roster-join.js'
import { isInsideRoot } from './path-guard.js'
import { MEMORY_BACKENDS } from './constants.js'

export const BOT_CREATE_TIMEOUT_MS = 30_000
const MAX_INSTRUCTIONS_BYTES = 8000

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// The memory backend the main picked for the Bot it is creating on a node. The node's
// own roster validates MEMORY_BACKENDS again, so an unknown value is dropped there;
// sending only a known value keeps a typo from reaching the frame at all.
//
// Exported for the update path: `bot/update` must apply the same rule as creation,
// otherwise a typo could reach a node that stores it as-is.
export function cleanMemory(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  return MEMORY_BACKENDS.includes(input.backend) ? { backend: input.backend } : null
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
/**
 * Shared fail-closed workDir root boundary check.
 * Returns null if OK, or an error string if rejected.
 */
export function checkWorkDirRoots(rt, workDir) {
  if (workDir === null || workDir === undefined) return null
  let policy
  try { policy = rt.ctx?.get?.('remote-agent:node-policy') } catch { policy = undefined }
  if (!policy) return 'bot-create-workdir-denied'
  const roots = Array.isArray(policy.roots) ? policy.roots : []
  if (roots.length === 0) return 'bot-create-workdir-denied'
  const resolved = pathResolve(workDir)
  const ignoreCase = process.platform === 'win32'
  const inRoots = roots.some((r) => isInsideRoot(resolved, pathResolve(r), { sep: pathSep, ignoreCase }))
  if (!inRoots) return 'bot-create-workdir-denied'
  return null
}

export async function createBotOnNode(rt, { nodeId, name, role, modelRef = null, effort = null, workDir = null, instructions = null, memoryConfig = null } = {}) {
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
  const nodeRec = online.find((n) => n.nodeId === nid)
  if (!nodeRec) return { ok: false, error: 'node-unknown' }

  // §4.1 校验 modelRef 按**节点 catalog**：节点有 catalog 且不含该 ref → 拒绝，不派发。
  // 节点 catalog 为空/null → 不拦（让节点自己判）。
  if (modelRef !== null) {
    const nodeModels = Array.isArray(nodeRec.models) ? nodeRec.models : null
    if (nodeModels !== null && nodeModels.length > 0) {
      const refs = nodeModels.map(m => m.ref ?? `${m.provider ?? ''}/${m.id ?? ''}`)
      if (!refs.includes(modelRef)) {
        return { ok: false, error: 'bot-create-model-unknown' }
      }
    }
  }

  // A Bot that lives on a node keeps its memory with the hub, but only a node that can
  // take the frames: one without `memory-sync/1` (an ra older than 0.10.1-fork.76) drops
  // the field, so defaulting to federation there would write a shadow row the node never
  // matches, and an upgrade would not repair it. An explicit pick still wins.
  const chosen = cleanMemory(memoryConfig)
  const caps = Array.isArray(nodeRec.hello?.caps) ? nodeRec.hello.caps : (Array.isArray(nodeRec.caps) ? nodeRec.caps : [])
  const nodeFederates = caps.includes('memory-sync/1')
  const memory = chosen ?? (nodeFederates ? { backend: 'federation' } : undefined)
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
  // Clamp at a UTF-8 character boundary to avoid splitting multi-byte sequences (U+FFFD).
  let clampedInstructions = instructions ?? null
  if (typeof clampedInstructions === 'string') {
    const buf = Buffer.from(clampedInstructions, 'utf8')
    if (buf.byteLength > MAX_INSTRUCTIONS_BYTES) {
      // Find last valid UTF-8 boundary at or before 8000 bytes.
      // Walk backwards from byte 8000 while we are inside a continuation byte (0x80-0xBF).
      let cut = MAX_INSTRUCTIONS_BYTES
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--
      clampedInstructions = buf.subarray(0, cut).toString('utf8')
    }
  }

  const sent = registry.send(nid, 'bot/create', {
    nodeId: nid,
    name: trimmed(name).slice(0, 40),
    role: typeof role === 'string' ? trimmed(role).slice(0, 24) : '',
    requestId,
    modelRef: resolvedModelRef,
    effort: effort ?? null,
    // The team's default level for a Bot whose creator named none: the node writes it as
    // the Bot's effort. `managedBy: 'hub'` is what makes a later turn fail closed instead
    // of falling back to a model the node happens to serve.
    defaultEffort: effort ?? null,
    managedBy: 'hub',
    workDir: workDir ?? null,
    instructions: clampedInstructions,
    // A node that cannot federate gets no field at all: sending the default would only
    // be dropped, and a node that can takes the explicit pick or the federation default.
    ...(memory === undefined ? {} : { memoryConfig: memory }),
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
  // `undefined` here means "this row never had a backend" and must stay that way; the
  // node's own Bot kept whatever default it was built with, so a hub-side default would
  // describe a federation that does not exist.
  const keptMemoryConfig = existing === undefined ? memory : (chosen ?? existing.memoryConfig)
  rt.state.bots[shadowBotId] = {
    ...(existing ?? {}),
    id: shadowBotId,
    name: (result.name || trimmed(name)).slice(0, 40),
    role: (result.role || (typeof role === 'string' ? trimmed(role) : '')).slice(0, 24),
    type: 'remote-worker',
    origin: 'joined',
    // Hub-created: the node's turn runs the model the hub chose or fails with a repair
    // card, never a silent fallback (models.js desiredModel).
    managedBy: 'hub',
    model: resolvedModelRef ?? null,
    effort: effort ?? null,
    createdAt: existing?.createdAt ?? now,
    capabilities: existing?.capabilities ?? [],
    // A row that is already known keeps the backend it runs with, including "never set":
    // re-reporting must not add today's default to a Bot created before the default
    // existed, which would also leave the panel waiting on a snapshot the node will never
    // send. Only a row this call creates gets `memory` (the explicit pick, else the
    // default); an explicit pick still wins for an existing row.
    ...(keptMemoryConfig === undefined ? {} : { memoryConfig: keptMemoryConfig }),
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
  // A joined shadow owns its Main Thread from its first save, without a local Session.
  ensureMainThread(rt.state, rt.state.bots[shadowBotId])
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
    // `defaultEffort` is the hub's pick when the creator named none; `effort` still wins.
    const defaultEffort = typeof spec?.defaultEffort === 'string' && spec.defaultEffort !== '' ? spec.defaultEffort.slice(0, 64) : null
    const effort = spec?.effort ?? defaultEffort ?? null
    // This receiver is the node end of the hub's `bot/create` and nothing else, so every Bot
    // it makes was chosen by the main. An older remote-agent validates the frame with a fixed
    // field list and drops the marker before it gets here (0.10.1-fork.74 does); an absent
    // marker must therefore still mean "the main owns this model", because losing it silently
    // restores the local fallback the marker exists to prevent. Only an explicit null — the
    // frame said this Bot is not the main's — keeps it local.
    const managedBy = spec?.managedBy === null ? undefined : 'hub'
    const workDir = spec?.workDir ?? null
    const instructions = spec?.instructions ?? null
    // The node's roster validates the value against MEMORY_BACKENDS and stores only a
    // known backend, so passing the object along is safe even from an older hub.
    const memoryConfig = cleanMemory(spec?.memoryConfig)

    // roster.js install 把 createBot 挂到 rt 上（见 roster.js Object.assign(rt, {...createBot...})）
    const createBot = rt.createBot
    if (typeof createBot !== 'function') return { ok: false, error: 'bot-create-no-roster' }

    // §4 校验顺序：modelRef (node-side, this bot's own llm) → workDir → createBot
    // This runs on the NODE, so llm.listProviders() reflects the node's actual providers.
    if (modelRef !== null) {
      // Fail-closed: if llm service unavailable, cannot verify provider → reject.
      const providerId = modelRef.includes('/') ? modelRef.split('/')[0] : modelRef
      const llm = rt.ctx?.get?.('llm') ?? rt.ctx?.llm
      if (!llm || typeof llm.listProviders !== 'function') {
        return { ok: false, error: 'bot-create-model-unknown' }
      }
      const providerIds = llm.listProviders().map(p => typeof p === 'string' ? p : p.id)
      if (!providerIds.includes(providerId)) return { ok: false, error: 'bot-create-model-unknown' }
      const missing = typeof rt.missingKeys === 'function' ? await rt.missingKeys([providerId]) : new Set()
      if (missing.has(providerId)) return { ok: false, error: 'bot-create-model-no-key' }
    }

    {
      const wdErr = checkWorkDirRoots(rt, workDir)
      if (wdErr) return { ok: false, error: wdErr }
    }

    try {
      // 不传 type:'remote-worker'，建出来是普通本地 Bot，reportableBots 才会上报
      // roster.js createBot resolves to the Bot object (buildBot returns `bot`), not an id.
      const bot = await createBot({ name, role, model: modelRef, effort, workDir, instructions, ...(memoryConfig === null ? {} : { memoryConfig }) })
      const id = typeof bot?.id === 'string' ? bot.id.trim() : ''
      // The row says who owns the model choice: a hub-created Bot fails closed on a
      // missing model/level instead of falling back (models.js), a local one does not.
      if (id !== '' && managedBy !== undefined) {
        bot.managedBy = managedBy
        await rt.save?.()
      }
      // The hub accepts only a non-empty string id and silently drops anything else, so an
      // answer without one is a failure here, never an empty or object-valued remoteBotId.
      if (id === '') return { ok: false, error: 'bot-create-failed: createBot returned no Bot id' }
      return {
        ok: true,
        remoteBotId: id,
        name: bot.name ?? name,
        role: bot.role ?? role,
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
