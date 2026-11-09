// Config-sync payload v2 pieces (P1b-1): the fields a node that speaks `config-sync/2` understands.
//
// Everything here is pure and defensive on purpose. The node validates a v2 push BEFORE it writes
// anything and rejects the whole push on the first bad field (`plugin-config-invalid`), which would
// also hold back the unrelated provider updates in the same payload. So the source drops what the
// node would refuse (wrong type, out of range, unknown key) instead of sending it, and reports how
// many fields it dropped as a COUNT only: no key, no ref name and no field value goes into a log.

export const CONFIG_SYNC_V2_CAP = 'config-sync/2'

/** The single managed plugin of this slice. `ref` is the credential ref the node plugin reads. */
export const DEEPSEEK_ENTRY = Object.freeze({
  provider: 'deepseek-official',
  entryId: 'llm-deepseek',
  name: '@deepseek-ai/dsh-llm-deepseek-api-key',
  ref: 'DEEPSEEK_API_KEY',
  officialBaseURL: 'https://api.deepseek.com/anthropic',
})

const MAX_TIMER_DELAY_MS = 2147483647
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isStr = (value, max = 2000) => typeof value === 'string' && value !== '' && value.length <= max
const isPosInt = value => Number.isSafeInteger(value) && value >= 1
const MODALITIES = ['text', 'image']

/** Does the node's cap list say it can take a schema:2 payload? */
export function nodeSpeaksV2(caps) {
  return Array.isArray(caps) && caps.includes(CONFIG_SYNC_V2_CAP)
}

function inputOf(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  if (!value.every(item => MODALITIES.includes(item)) || new Set(value).size !== value.length) return undefined
  return [...value]
}

function reasoningEffortsOf(value) {
  if (value === false) return false
  if (!isPlain(value)) return undefined
  const out = {}
  for (const [key, wire] of Object.entries(value)) {
    if (!isStr(key, 40)) return undefined
    if (wire !== null && !isStr(wire, 100)) return undefined
    out[key] = wire
  }
  return out
}

/** A pi-ai provider model, completed with the fields v1 cut off (contextWindow/maxTokens/input/reasoningEfforts). */
export function modelV2(model) {
  const out = { id: model.id, name: isStr(model.name) ? model.name : model.id }
  if (isPosInt(model.contextWindow)) out.contextWindow = model.contextWindow
  if (isPosInt(model.maxTokens)) out.maxTokens = model.maxTokens
  const input = inputOf(model.input)
  if (input) out.input = input
  const efforts = reasoningEffortsOf(model.reasoningEfforts)
  if (efforts !== undefined) out.reasoningEfforts = efforts
  return out
}

/** The pi-ai profile fields a v2 provider adds: displayName / streamIdleTimeoutMs / compat. `headers` never goes (it can hold a secret). */
export function providerExtrasV2(profile) {
  const out = {}
  if (isStr(profile.displayName, 200)) out.displayName = profile.displayName
  const idle = profile.streamIdleTimeoutMs
  if (Number.isFinite(idle) && idle > 0 && idle <= MAX_TIMER_DELAY_MS) out.streamIdleTimeoutMs = idle
  if (isPlain(profile.compat)) {
    let text
    try { text = JSON.stringify(profile.compat) } catch { text = undefined }
    if (text !== undefined && text.length <= 4096) out.compat = JSON.parse(text)
  }
  return out
}

// ── llm-deepseek plugin entry ───────────────────────────────────────────────

const BACKOFF_KEYS = ['initialDelayMs', 'maxDelayMs', 'jitterRatio']

function backoffOf(value) {
  if (!isPlain(value)) return undefined
  const out = {}
  for (const key of BACKOFF_KEYS) {
    const v = value[key]
    if (v === undefined) continue
    const ok = key === 'jitterRatio' ? Number.isFinite(v) && v >= 0 && v <= 1 : Number.isFinite(v) && v >= 0 && v <= MAX_TIMER_DELAY_MS
    if (ok) out[key] = v
  }
  return out
}

function retryPolicyOf(value) {
  if (!isPlain(value)) return undefined
  if (value.mode === 'always') {
    const backoff = backoffOf(value.backoff)
    return { mode: 'always', ...(backoff && Object.keys(backoff).length > 0 ? { backoff } : {}) }
  }
  if (value.mode === 'normal') {
    const out = { mode: 'normal' }
    if (Number.isSafeInteger(value.maxRetries) && value.maxRetries >= 0) out.maxRetries = value.maxRetries
    if (Array.isArray(value.retryableCodes) && value.retryableCodes.length <= 64 && value.retryableCodes.every(code => isStr(code, 100))) out.retryableCodes = [...value.retryableCodes]
    const backoff = backoffOf(value.backoff)
    if (backoff && Object.keys(backoff).length > 0) out.backoff = backoff
    return out
  }
  return undefined
}

function deepseekModelOf(model) {
  if (!isPlain(model) || !isStr(model.id, 200)) return undefined
  const out = { id: model.id }
  if (isStr(model.name)) out.name = model.name
  if (isStr(model.description)) out.description = model.description
  if (isPosInt(model.contextWindow)) out.contextWindow = model.contextWindow
  if (isPosInt(model.maxTokens)) out.maxTokens = model.maxTokens
  const input = inputOf(model.inputModalities)
  if (input) out.inputModalities = input
  if (model.systemPromptUpdate === 'in-history') out.systemPromptUpdate = 'in-history'
  if (model.toolUpdate === 'in-history' || model.toolUpdate === 'addition-only') out.toolUpdate = model.toolUpdate
  return out
}

const isLoopback = host => host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./.test(host)

/** Only an endpoint the node can actually reach and that differs from the official one is worth sending. */
function baseURLOf(value) {
  if (!isStr(value, 2048)) return undefined
  let url
  try { url = new URL(value) } catch { return undefined }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined
  if (isLoopback(url.hostname)) return undefined
  const trim = text => text.replace(/\/+$/, '')
  if (trim(value) === trim(DEEPSEEK_ENTRY.officialBaseURL)) return undefined
  return value
}

/**
 * The whitelist the contract names (P1b.3): models / thinking / reasoningEffort / maxTokens /
 * defaultContextWindow / streamIdleTimeoutMs / retryPolicy, plus baseURL only for a non-official, reachable source.
 * Everything else in the main's section (image offload quotas, file API timeouts, ...) is dropped.
 * @returns {{ config: object, dropped: number }} dropped = fields present on the main side that did not go out.
 */
export function trimDeepseekConfig(profile) {
  const source = isPlain(profile) ? profile : {}
  const config = {}
  let dropped = 0
  const take = (key, value) => { if (value === undefined) { if (source[key] !== undefined) dropped += 1 } else config[key] = value }

  // The official endpoint (or one the node cannot reach) is simply not sent: not a dropped field.
  const baseURL = baseURLOf(source.baseURL)
  if (baseURL !== undefined) config.baseURL = baseURL
  take('thinking', source.thinking === 'enabled' || source.thinking === 'disabled' ? source.thinking : undefined)
  take('reasoningEffort', ['off', 'low', 'high', 'max'].includes(source.reasoningEffort) ? source.reasoningEffort : undefined)
  // The plugin throws at start when thinking is off and the effort is not `off`.
  if (config.thinking === 'disabled' && config.reasoningEffort !== undefined && config.reasoningEffort !== 'off') { delete config.reasoningEffort; dropped += 1 }
  take('maxTokens', isPosInt(source.maxTokens) ? source.maxTokens : undefined)
  take('defaultContextWindow', isPosInt(source.defaultContextWindow) ? source.defaultContextWindow : undefined)
  const idle = source.streamIdleTimeoutMs
  take('streamIdleTimeoutMs', Number.isFinite(idle) && idle > 0 && idle <= MAX_TIMER_DELAY_MS ? idle : undefined)
  take('retryPolicy', retryPolicyOf(source.retryPolicy))
  if (Array.isArray(source.models)) {
    const seen = new Set()
    const models = []
    for (const model of source.models) {
      const cleaned = deepseekModelOf(model)
      if (!cleaned || seen.has(cleaned.id)) { dropped += 1; continue }
      seen.add(cleaned.id)
      models.push(cleaned)
    }
    if (models.length > 0 && models.length <= 64) config.models = models
    else if (source.models.length > 0) dropped += 1
  }
  return { config, dropped }
}

/**
 * The `plugins[]` item for the main's deepseek-official, or null when there is nothing to send
 * (no section, or no key: then the node deletes the ref it owns, which is how a revoked key propagates).
 * @param profile the main's `llm-deepseek-api-key` section value
 * @param keyOf   (refName) => string|undefined, the credentials refs
 */
export function deepseekPlugin(profile, keyOf) {
  if (!isPlain(profile)) return null
  const sourceRef = typeof profile.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv) ? profile.apiKeyEnv : DEEPSEEK_ENTRY.ref
  const apiKey = keyOf(sourceRef)
  // A key with a control character would break the node's credentials file; the node refuses it too.
  if (typeof apiKey !== 'string' || apiKey === '' || /[\u0000-\u001f\u007f]/.test(apiKey)) return null
  const { config, dropped } = trimDeepseekConfig(profile)
  return {
    plugin: {
      entryId: DEEPSEEK_ENTRY.entryId,
      name: DEEPSEEK_ENTRY.name,
      config,
      // The node plugin reads DEEPSEEK_API_KEY whatever the main called its own ref.
      credentialRefs: [{ ref: DEEPSEEK_ENTRY.ref, apiKey }],
    },
    dropped,
  }
}
