// Config source: builds the model-provider payload the main DSH pushes to remote nodes
// (remote-agent's `remote-agent:config-sync` service calls the source synchronously).
//
// A provider goes out only when it is complete: a route in the llm-pi-ai settings with
// a protocol and a credential ref, whose key the credentials file really holds. A
// provider without a key is skipped, never pushed half-made. The key travels in the
// payload (the node writes it to its own credentials file) and never goes into a log
// line or an error message here: logs name provider ids and counts only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PI_AI = 'llm-pi-ai'
const PROVIDER_ID = /^[A-Za-z0-9._-]+$/
const CRED_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
const RETRY_MS = 5_000

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
  try { return parseCredentialRefs(readFileSync(join(rt.dshHome, '.credentials.yaml'), 'utf8')) } catch { return new Map() }
}

/**
 * The payload for remote nodes: `{ providers, defaultModel }` (no revision; the hub adds it).
 * Synchronous. `defaultModel` is passed in because resolving it is async (see `install`).
 *
 * @param {object} gateway - optional { host, port, tokens } for per-provider gateway rewriting.
 *   tokens is a Map(providerId -> { refName, value }) from the gateway token store.
 *   Only providers whose profile.gateway === true are rewritten; others pass through unchanged.
 *   If gateway is not provided, or a provider has no gateway flag, behavior is unchanged.
 */
export function buildConfigPayload(rt, { defaultModel = null, readRefs = readRefsFile, gateway } = {}) {
  const ctx = rt.ctx
  const settings = ctx.get?.('settings')
  const entries = typeof ctx.llm?.listConfigurableProviders === 'function' ? ctx.llm.listConfigurableProviders() : []
  const providers = []
  let skipped = 0
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
      const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : ''
      const apiKey = refs.get(apiKeyEnv)
      if (!PROVIDER_ID.test(entry.provider) || !CRED_REF.test(apiKeyEnv) || typeof profile.api !== 'string' || profile.api === '' || typeof apiKey !== 'string' || apiKey === '') {
        skipped += 1
        continue
      }
      const models = (Array.isArray(profile.models) ? profile.models : [])
        .filter(model => model && typeof model.id === 'string' && model.id !== '')
        .map(model => ({ id: model.id, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id }))

      // Per-provider gateway rewriting: only when profile.gateway === true and gateway param is set
      // gateway = { host, port, token: { refName, value } } — one token shared by all gateway providers
      let finalBaseURL = typeof profile.baseURL === 'string' && profile.baseURL !== '' ? profile.baseURL : undefined
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
        api: profile.api,
        ...(finalBaseURL !== undefined ? { baseURL: finalBaseURL } : {}),
        apiKeyEnv: finalApiKeyEnv,
        apiKey: finalApiKey,
        models,
      })
    }
    if (gwFallbackCount > 0) rt.warn?.('ds-bot: config-source gateway not started, %d provider(s) fall back to direct', gwFallbackCount)
    if (gwTokenMissingCount > 0) rt.warn?.('ds-bot: config-source gateway token missing, %d provider(s) fall back to direct', gwTokenMissingCount)
  }
  if (skipped > 0) rt.warn?.('ds-bot: config-source skipped %d provider(s) without a protocol or key', skipped)
  // Ensure defaultModel's provider is among the pushed providers
  let validatedDefault = null
  if (typeof defaultModel === 'string' && defaultModel !== '' && providers.length > 0) {
    const pushedProviderIds = new Set(providers.map(p => p.id))
    const defaultProviderId = defaultModel.includes('/') ? defaultModel.split('/')[0] : defaultModel
    if (pushedProviderIds.has(defaultProviderId)) {
      validatedDefault = defaultModel
    }
  }
  return { providers, defaultModel: validatedDefault }
}

export function install(rt) {
  const ctx = rt.ctx
  // The hub calls the source synchronously, but the default model is resolved through
  // the (async) catalog, so it is refreshed here and read from the cache.
  let defaultModel = null
  const refreshDefault = async () => {
    try {
      const ref = (await rt.defaultBotModel?.()) ?? null
      // Exclude embedding models and ensure the provider is in the payload
      if (typeof ref === 'string' && ref !== '' && !/embedding/i.test(ref)) {
        defaultModel = ref
      } else { defaultModel = null }
    } catch { defaultModel = null }
  }
  let attached = false
  const attach = () => {
    if (attached) return
    let service
    try { service = ctx?.get?.('remote-agent:config-sync') } catch { service = undefined }
    if (!service || typeof service.setSource !== 'function') return
    attached = true
    service.setSource(() => buildConfigPayload(rt, { defaultModel, gateway: rt.gateway }))
  }
  const tick = () => {
    attach()
    if (attached) void refreshDefault()
  }
  tick()
  // remote-agent may come up after ds-bot; look again until its service is there, then keep
  // the default model fresh.
  const timer = setInterval(tick, RETRY_MS)
  timer.unref?.()
}
