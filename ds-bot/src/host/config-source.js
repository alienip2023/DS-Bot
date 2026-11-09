// Config source: builds the model-provider payload the main DSH pushes to remote nodes
// (remote-agent's `remote-agent:config-sync` service calls the source synchronously).
//
// A provider goes out only when it is complete: a route in the llm-pi-ai settings with
// a protocol and a credential ref, whose key the credentials file really holds. A
// provider without a key is skipped, never pushed half-made. The key travels in the
// payload (the node writes it to its own credentials file) and never goes into a log
// line or an error message here: logs name provider ids and counts only.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { env } from 'node:process'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createGatewayServer } from '../gateway/index.js'
import { createTokenStore } from '../gateway/token-store.js'
import { readUpstreamProviders } from '../gateway/upstream.js'
import { DEEPSEEK_ENTRY, deepseekPlugin, modelV2, nodeSpeaksV2, providerExtrasV2 } from './config-v2.js'

const PI_AI = 'llm-pi-ai'
export const PROVIDER_ID = /^[A-Za-z0-9._-]+$/
const CRED_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
const RETRY_MS = 5_000

// Catalog routes of llm-pi-ai (xai, anthropic, groq, ...) are usually configured with a
// `models` list only: the wire protocol and the endpoint live in pi-ai's built-in catalog,
// and the key is read from the provider's native env name (`nativeAuth.env`). A node has
// no catalog entry to lean on for a pushed route, so the source completes the route from
// the catalog before pushing. The endpoint comes from the configurable-provider directory
// entry (`defaultBaseURL`, generated from pi-ai's PROVIDER_DATA); the protocol is this
// snapshot of the installed catalog, limited to routes that speak ONE protocol the node
// can serve (anthropic-messages / openai-completions / openai-responses). A route that is
// not listed here (mixed protocols, bedrock, vertex, ...) is still skipped, never guessed.
//
// Source of the table: `@earendil-works/pi-ai` 1.3.0, `dist/models.generated.js` `MODELS[<provider>][*].api`
// (the pi-ai that `@deepseek-ai/dsh-llm-pi-ai` 0.2.2-alpha.2 depends on, as shipped in DSH Desktop 0.13.2).
// A provider is listed only when ALL its models use the same protocol. Re-check the table when pi-ai is upgraded;
// `test/config-source.test.js` ('C5-table-matches-pi-ai') does it when a DSH install is at hand.
// Keys are looked up with Object.hasOwn: a provider id such as `constructor` or `toString` must not resolve to
// an Object.prototype member (see 'C5-proto-keys').
export const CATALOG_API = Object.freeze({
  ...Object.fromEntries(['ant-ling', 'baseten', 'cerebras', 'deepseek', 'groq', 'huggingface', 'kimi-coding', 'moonshotai', 'moonshotai-cn', 'nvidia', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'together', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn'].map(id => [id, 'openai-completions'])),
  ...Object.fromEntries(['anthropic', 'minimax', 'minimax-cn'].map(id => [id, 'anthropic-messages'])),
  ...Object.fromEntries(['meta', 'xai'].map(id => [id, 'openai-responses'])),
})

// Find the directory that actually contains settings.yaml.
// Order: rt.dshHome → ~/.dsh → DSH_HOME env — first with settings.yaml wins.
function findSettingsDir(rt) {
  const candidates = []
  if (typeof rt?.dshHome === 'string' && rt.dshHome !== '') candidates.push(rt.dshHome)
  const homeCandidate = join(homedir(), '.dsh')
  if (!candidates.includes(homeCandidate)) candidates.push(homeCandidate)
  const envHome = env.DSH_HOME
  if (typeof envHome === 'string' && envHome !== '' && !candidates.includes(envHome)) candidates.push(envHome)
  for (const dir of candidates) {
    try { if (existsSync(join(dir, 'settings.yaml'))) return dir } catch { /* skip */ }
  }
  return candidates[candidates.length - 1] ?? homeCandidate
}

// `refs:` section of $DSH_HOME/.credentials.yaml as a Map(name -> value). Text-level
// on purpose (no yaml dependency); a value this cannot read as one line is skipped.
export function parseCredentialRefs(text) {
  const refs = new Map()
  let inRefs = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (/^\S/.test(line)) { inRefs = false; continue }
    if (!inRefs) continue
    const match = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const [, name, raw] = match
    let value
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw) } catch { continue }
    } else if (raw.startsWith("'")) {
      if (!raw.endsWith("'") || raw.length < 2) continue
      value = raw.slice(1, -1).replace(/''/g, "'")
    } else if (raw === '' || raw === '|' || raw === '>' || raw.startsWith('#')) {
      continue
    } else {
      value = raw
    }
    if (typeof value === 'string' && value !== '') refs.set(name, value)
  }
  return refs
}

function readRefsFile(rt) {
  // Merge from all candidates. Reversed loop → last wins: env.DSH_HOME < ~/.dsh < rt.dshHome.
  const candidates = []
  if (typeof rt?.dshHome === 'string' && rt.dshHome !== '') candidates.push(rt.dshHome)
  const homeCandidate = join(homedir(), '.dsh')
  if (!candidates.includes(homeCandidate)) candidates.push(homeCandidate)
  const envHome = env.DSH_HOME
  if (typeof envHome === 'string' && envHome !== '' && !candidates.includes(envHome)) candidates.push(envHome)
  const merged = new Map()
  for (const dir of [...candidates].reverse()) {
    try {
      const refs = parseCredentialRefs(readFileSync(join(dir, '.credentials.yaml'), 'utf8'))
      for (const [k, v] of refs) merged.set(k, v)
    } catch { /* skip */ }
  }
  return merged
}

/**
 * The payload for remote nodes: `{ providers, defaultModel }` (no revision; the hub adds it).
 * Synchronous. `defaultModel` is passed in because resolving it is async (see `install`).
 *
 * `schema: 2` is only for a node that announced `config-sync/2` (see `install`). It adds the full model
 * fields, `plugins[]` (deepseek-official, with its key) and `cliExpect[]`; the default `schema: 1` payload
 * is byte-for-byte what a node without that cap has always received, so its revision does not move.
 *
 * @param {object} gateway - optional { host, port, tokens } for per-provider gateway rewriting.
 *   tokens is a Map(providerId -> { refName, value }) from the gateway token store.
 *   Only providers whose profile.gateway === true are rewritten; others pass through unchanged.
 *   If gateway is not provided, or a provider has no gateway flag, behavior is unchanged.
 */
export function buildConfigPayload(rt, { defaultModel = null, readRefs = readRefsFile, gateway, schema = 1 } = {}) {
  const ctx = rt.ctx
  const settings = ctx.get?.('settings')
  const entries = typeof ctx.llm?.listConfigurableProviders === 'function' ? ctx.llm.listConfigurableProviders() : []
  const providers = []
  const plugins = []
  let skipped = 0
  let droppedPluginFields = 0
  const v2 = schema === 2
  if (settings && entries.length > 0) {
    const sections = new Map(settings.describe({ redactSecrets: true }).map(section => [section.ns, section]))
    const refs = readRefs(rt)
    const LOCAL_CLI_PREFIX = /^(claude-code|codex-cli)(\/|$)/
    let gwFallbackCount = 0
    let gwTokenMissingCount = 0
    for (const entry of entries) {
      // Skip local CLI providers (process-based, not API-key based)
      if (LOCAL_CLI_PREFIX.test(entry.provider)) { skipped += 1; continue }
      const profile = entry.settingsPath.reduce((value, key) => value?.[key], sections.get(entry.settingsNs)?.value)
      if (!profile || typeof profile !== 'object') continue
      // v2: deepseek-official is a plugin entry (llm-deepseek-api-key), not a pi-ai route. No key → nothing goes
      // out, and the node removes the ref and the entry it owns (that is how a revoked key propagates).
      if (v2 && entry.provider === DEEPSEEK_ENTRY.provider) {
        const built = deepseekPlugin(profile, name => refs.get(name))
        if (built) { plugins.push(built.plugin); droppedPluginFields += built.dropped }
        continue
      }
      // Catalog route that names neither protocol nor credential ref: complete it from the catalog.
      const catalogApi = Object.hasOwn(CATALOG_API, entry.provider) ? CATALOG_API[entry.provider] : undefined
      const nativeEnv = Array.isArray(entry.nativeAuth?.env) ? entry.nativeAuth.env.find(name => typeof name === 'string' && CRED_REF.test(name)) : undefined
      const apiKeyEnv = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : (catalogApi !== undefined && nativeEnv !== undefined ? nativeEnv : '')
      const api = typeof profile.api === 'string' && profile.api !== '' ? profile.api : (catalogApi ?? '')
      const apiKey = refs.get(apiKeyEnv)
      if (!PROVIDER_ID.test(entry.provider) || !CRED_REF.test(apiKeyEnv) || api === '' || typeof apiKey !== 'string' || apiKey === '') {
        skipped += 1
        continue
      }
      const models = (Array.isArray(profile.models) ? profile.models : [])
        .filter(model => model && typeof model.id === 'string' && model.id !== '')
        .map(model => v2 ? modelV2(model) : ({ id: model.id, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id }))

      // Per-provider gateway rewriting: only when profile.gateway === true and gateway param is set
      // gateway = { host, port, token: { refName, value } } — one token shared by all gateway providers
      let finalBaseURL = typeof profile.baseURL === 'string' && profile.baseURL !== '' ? profile.baseURL
        : (catalogApi !== undefined && typeof entry.defaultBaseURL === 'string' && entry.defaultBaseURL !== '' && !entry.defaultBaseURL.includes('{') ? entry.defaultBaseURL : undefined)
      let finalApiKeyEnv = apiKeyEnv
      let finalApiKey = apiKey
      if (profile.gateway === true && gateway != null) {
        const { host, port, token } = gateway
        const gwPort = typeof port === 'number' ? port : null
        if (gwPort != null && token?.refName && token?.value) {
          finalBaseURL = `http://${host ?? '127.0.0.1'}:${gwPort}/gw/${entry.provider}/v1`
          finalApiKeyEnv = token.refName
          finalApiKey = token.value
        } else if (gwPort == null) {
          // Aggregate count; warn once after loop
          gwFallbackCount += 1
        } else {
          // Gateway running but token not yet registered — count for aggregated warn
          gwTokenMissingCount += 1
        }
      }

      providers.push({
        id: entry.provider,
        api,
        ...(finalBaseURL !== undefined ? { baseURL: finalBaseURL } : {}),
        apiKeyEnv: finalApiKeyEnv,
        apiKey: finalApiKey,
        models,
        ...(v2 ? { ...providerExtrasV2(profile), ...(typeof profile.api !== 'string' || profile.api === '' ? { catalog: true } : {}) } : {}),
      })
    }
    if (gwFallbackCount > 0) rt.warn?.('ds-bot: config-source gateway not started, %d provider(s) fall back to direct', gwFallbackCount)
    if (gwTokenMissingCount > 0) rt.warn?.('ds-bot: config-source gateway token missing, %d provider(s) fall back to direct', gwTokenMissingCount)
  }
  if (skipped > 0) rt.warn?.('ds-bot: config-source skipped %d provider(s) without a protocol or key', skipped)
  // Counts only: never a key, a ref name or a field value.
  if (v2 && droppedPluginFields > 0) rt.warn?.('ds-bot: config-source v2 dropped %d plugin config field(s) the node would refuse', droppedPluginFields)
  // Ensure defaultModel's provider is among the pushed providers
  let validatedDefault = null
  if (typeof defaultModel === 'string' && defaultModel !== '' && providers.length > 0) {
    const pushedProviderIds = new Set(providers.map(p => p.id))
    const defaultProviderId = defaultModel.includes('/') ? defaultModel.split('/')[0] : defaultModel
    if (pushedProviderIds.has(defaultProviderId)) {
      validatedDefault = defaultModel
    }
  }
  if (!v2) return { providers, defaultModel: validatedDefault }
  // cliExpect stays empty in this slice (the CLI comparison is a later one).
  return { schema: 2, providers, defaultModel: validatedDefault, plugins, cliExpect: [] }
}

export function listGatewayProviders(rt) {
  const ctx = rt.ctx
  const settings = ctx?.get?.('settings')
  const entries = typeof ctx?.llm?.listConfigurableProviders === 'function' ? ctx.llm.listConfigurableProviders() : []
  if (!settings || entries.length === 0) return []
  const sections = new Map(settings.describe({ redactSecrets: true }).map(sec => [sec.ns, sec]))
  const refs = (() => {
    return readRefsFile(rt)
  })()
  const CLI_PREFIX = /^(claude-code|codex-cli)(\/|$)/
  const result = []
  for (const entry of entries) {
    if (CLI_PREFIX.test(entry.provider)) continue
    const profile = entry.settingsPath.reduce((v, k) => v?.[k], sections.get(entry.settingsNs)?.value)
    if (!profile || typeof profile !== 'object') continue
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : ''
    const apiKey = refs.get(apiKeyEnv)
    if (!PROVIDER_ID.test(entry.provider) || typeof profile.baseURL !== 'string' || profile.baseURL === '' || typeof apiKey !== 'string' || apiKey === '') continue
    const models = (Array.isArray(profile.models) ? profile.models : [])
      .filter(m => m && typeof m.id === 'string' && m.id !== '')
      .map(m => ({ id: m.id, name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id }))
    result.push({ id: entry.provider, baseURL: profile.baseURL, apiKey, models })
  }
  return result
}

export function install(rt) {
  const ctx = rt.ctx

  // ── Gateway startup ──────────────────────────────────────────────────────
  // Priority: settings.describe 'ds-bot' ns → DS_BOT_GATEWAY_HOST/PORT env → defaults
  // Parse top-level `ds-bot:` section from a settings.yaml text (line-by-line, no yaml dep).
  // Reads gatewayHost (string) and gatewayPort (integer) only.
  const parseSettingsYaml = (text) => {
    const result = {}
    let inDsBot = false
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const line = raw.trimEnd()
      if (/^ds-bot:\s*$/.test(line)) { inDsBot = true; continue }
      if (/^\S/.test(line)) { inDsBot = false; continue }
      if (!inDsBot) continue
      const hostM = line.match(/^\s+gatewayHost:\s*(.+)$/)
      if (hostM) { const v = hostM[1].trim().replace(/^['"]|['"]$/g, ''); if (v) result.gatewayHost = v }
      const portM = line.match(/^\s+gatewayPort:\s*(\d+)$/)
      if (portM) { const n = Number(portM[1]); if (Number.isInteger(n)) result.gatewayPort = n }
    }
    return result
  }

  const settingsDir = findSettingsDir(rt)
  rt.warn?.('ds-bot: settingsDir=%s credsDir=%s', settingsDir, (() => { const e = env.DSH_HOME; return (e && e !== '') ? e : join(homedir(), '.dsh') })())

  const pushOnline = (service, reason) => {
    try {
      const registry = ctx?.get?.('remote-agent:registry')
      if (registry && typeof registry.onlineNodes === 'function') {
        const nodes = registry.onlineNodes()
        for (const node of nodes) {
          const nodeId = node.nodeId
          if (nodeId) {
            try { service.sendPush(nodeId) }
            catch (err) { rt.warn?.('ds-bot: push (%s) to %s failed: %s', reason, nodeId, err?.message ?? err) }
          }
        }
      }
    } catch { /* no registry */ }
  }

  const readGatewaySettings = () => {
    let host, port, from = 'default'
    // Priority 1: settings.describe() 'ds-bot' ns
    try {
      const settings = ctx?.get?.('settings')
      if (settings) {
        const section = settings.describe({ redactSecrets: false })
          .find(s => s.ns === 'ds-bot' || s.ns === 'ds-bot-main')
        const cfg = section?.value ?? {}
        if (typeof cfg.gatewayHost === 'string' && cfg.gatewayHost !== '') host = cfg.gatewayHost
        if (typeof cfg.gatewayPort === 'number') port = cfg.gatewayPort
        if (host !== undefined || port !== undefined) from = 'settings.describe'
      }
    } catch { /* ignore */ }
    if ((host === undefined || port === undefined) && settingsDir) {
      try {
        const settingsPath = join(settingsDir, 'settings.yaml')
        const raw = readFileSync(settingsPath, 'utf8')
        const parsed = parseSettingsYaml(raw)
        if (host === undefined && typeof parsed.gatewayHost === 'string' && parsed.gatewayHost !== '') host = parsed.gatewayHost
        if (port === undefined && typeof parsed.gatewayPort === 'number') port = parsed.gatewayPort
        if (host !== undefined || port !== undefined) from = 'yaml:' + settingsPath
      } catch { /* no settings.yaml or unreadable */ }
    }
    if (host === undefined && typeof env.DS_BOT_GATEWAY_HOST === 'string' && env.DS_BOT_GATEWAY_HOST !== '') { host = env.DS_BOT_GATEWAY_HOST; from = 'env' }
    if (port === undefined && typeof env.DS_BOT_GATEWAY_PORT === 'string' && env.DS_BOT_GATEWAY_PORT !== '') {
      const p = Number(env.DS_BOT_GATEWAY_PORT)
      if (Number.isInteger(p) && p >= 0 && p < 65536) { port = p; from = 'env' }
    }
    return { host, port, from }
  }

  const secrets = new Map()
  const tokenStore = createTokenStore()
  let actualPort = null
  let gwHost = '127.0.0.1'
  let gwServer = null

  // ensureToken(nodeId): synchronous — register + read creds + generate if missing + persist async
  const ensureToken = (nodeId) => {
    const { refName } = tokenStore.register(nodeId)     // idempotent
    if (secrets.has(refName)) return { refName, value: secrets.get(refName) }
    // credSvc is async; source callback must return synchronously — file read only.
    const refs = readRefsFile(rt)
    const existing = refs.get(refName)
    const value = (typeof existing === 'string' && existing !== '') ? existing : randomBytes(32).toString('base64url')
    secrets.set(refName, value)
    try {
      const credSvc = ctx?.get?.('credentials')
      if (credSvc?.set) credSvc.set(refName, value).catch(err => rt.warn?.('ds-bot: gateway token persist: %s', err?.message ?? err))
    } catch { /* no credentials service */ }
    return { refName, value }
  }

  ctx?.effect?.(() => {
    void (async () => {
      const { host, port, from } = readGatewaySettings()
      gwHost = host ?? '127.0.0.1'
      const gwPort = typeof port === 'number' ? port : 4387
      rt.warn?.('ds-bot: gateway config host=%s port=%s from=%s', host ?? '(default)', port ?? '(default)', from)
      const providersFn = () => {
        const origin = `http://${gwHost}:${actualPort ?? gwPort}`
        return readUpstreamProviders(listGatewayProviders(rt), origin)
      }
      gwServer = createGatewayServer({ gatewayHost: gwHost, gatewayPort: gwPort, secrets, store: tokenStore, providers: providersFn, rt })
      actualPort = await gwServer.start()
      if (actualPort !== null) {
        rt.warn?.('ds-bot: gateway listening on %s:%d', gwHost, actualPort)
        let svc
        try { svc = ctx?.get?.('remote-agent:config-sync') } catch { svc = undefined }
        if (attached && svc && typeof svc.setSource === 'function') {
          pushOnline(svc, 'gateway-ready')
        }
      }
    })().catch(err => rt.warn?.('ds-bot: model gateway start failed: %s', err?.message ?? err))
    return () => {
      const s = gwServer; gwServer = null
      void s?.stop?.()
    }
  }, 'ds-bot: model gateway')

  // ── Config-sync source ───────────────────────────────────────────────────
  let defaultModel = null
  const refreshDefault = async () => {
    try {
      const ref = (await rt.defaultBotModel?.()) ?? null
      if (typeof ref === 'string' && ref !== '' && !/embedding/i.test(ref)) {
        defaultModel = ref
      } else { defaultModel = null }
    } catch { defaultModel = null }
  }
  // schema:2 only for a node whose hello announced `config-sync/2`; an unknown node, a missing registry or a
  // registry that throws all mean v1, the payload every node has always understood.
  const schemaOf = (nodeId) => {
    if (typeof nodeId !== 'string' || nodeId === '') return 1
    try {
      const registry = ctx?.get?.('remote-agent:registry')
      return nodeSpeaksV2(registry?.getNode?.(nodeId)?.hello?.caps) ? 2 : 1
    } catch { return 1 }
  }
  let attached = false
  const attach = () => {
    if (attached) return
    let service
    try { service = ctx?.get?.('remote-agent:config-sync') } catch { service = undefined }
    if (!service || typeof service.setSource !== 'function') return
    attached = true
    // setSource receives nodeId per-payload; use it to ensure the node has its own token.
    // MUST remain synchronous — ra rejects a Promise source.
    service.setSource((nodeId) => {
      if (actualPort === null) {
        rt.warn?.('ds-bot: gateway not ready, providers pushed direct')
      }
      const gw = (nodeId && actualPort !== null)
        ? { host: gwHost, port: actualPort, token: ensureToken(nodeId) }
        : null
      return buildConfigPayload(rt, { defaultModel, gateway: gw, schema: schemaOf(nodeId) })
    })
    rt.warn?.('ds-bot: config-sync source attached')
    pushOnline(service, 'attach')
  }
  const tick = () => {
    attach()
    if (attached) void refreshDefault()
  }
  tick()
  const timer = setInterval(tick, RETRY_MS)
  timer.unref?.()
}
