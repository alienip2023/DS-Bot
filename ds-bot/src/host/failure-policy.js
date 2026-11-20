export function classifyLlmFailure(err) {
  const status = Number(err?.status ?? err?.statusCode)
  const code = typeof err?.code === 'string' ? err.code.toUpperCase() : ''
  const message = typeof err === 'string' ? err : err?.message ?? ''

  // Providers can describe a 429 as insufficient quota for the current rate window.
  if (status === 429 || code === 'RATE_LIMIT') return { kind: 'rate_limit', retryable: true }
  if (status === 401 || status === 403 || /^(AUTH|(?:MISSING|INVALID)_CREDENTIAL|ACCOUNT_(?:SIGN_IN_REQUIRED|SIGNED_OUT|TOKEN_INVALID)|LOCAL_AGENT_SIGNIN)$/.test(code)) {
    return { kind: 'auth', retryable: false }
  }
  if (status === 402 || /quota|insufficient[_\s-]+(?:balance|credit|funds)|billing/i.test(`${code} ${message}`)) {
    return { kind: 'billing', retryable: false }
  }
  if ((status >= 500 && status < 600) || code === 'SERVER' || code === 'EMPTY_RESPONSE') return { kind: 'server', retryable: true }
  if (/^(NETWORK|TIMEOUT|TRANSPORT|STREAM_CLOSED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)$/.test(code)) {
    return { kind: 'network', retryable: true }
  }
  return { kind: 'unknown', retryable: false }
}

/**
 * 确定性重试决策（吸收书 1-E retryDecision）。
 *
 * 决策逻辑：
 *   1. rate_limit 直接结束回合（防无退避紧循环）。
 *   2. 有 fallback 路由且未耗尽时，优先走 fallback（即使 attempt 预算还有余量）。
 *   3. 无 fallback 时，retryable 失败在预算内重试。
 *   4. 其余一律停止。
 *
 * @param {object} failure  classifyLlmFailure 的返回值 { kind, retryable }
 * @param {object} config   bot 或会话配置，可选字段：
 *                            fallback: string[]  备用 ref 列表
 *                            maxAttempts: number 最大尝试次数（含首次，默认 3）
 * @param {number} attempt  本次是第几次尝试（从 1 开始）
 * @returns {{ action: 'retry'|'fallback'|'stop', fallbackRef?: string, reason: string }}
 */
export function retryDecision(failure, config = {}, attempt = 1) {
  const { kind, retryable } = failure ?? {}
  // rate_limit 不管有无 fallback，直接停止——调用方应等用户修复或稍后再试
  if (kind === 'rate_limit') return { action: 'stop', reason: 'rate_limit' }

  const fallbacks = Array.isArray(config?.fallback) ? config.fallback.filter(r => typeof r === 'string' && r !== '') : []
  const maxAttempts = Number.isInteger(config?.maxAttempts) && config.maxAttempts > 0 ? config.maxAttempts : 3
  // fallbackRef 由调用方传入当前已用 fallback 下标（config.fallbackIndex），
  // 未提供时用 attempt 推算（attempt 1 = 首次，从 fallback[0] 开始）
  const fallbackIndex = Number.isInteger(config?.fallbackIndex) ? config.fallbackIndex : attempt - 1

  // fallback 优先于预算（防止 maxAttempts=1 时永远走不到备用路由）
  if (fallbacks.length > 0) {
    const ref = fallbacks[fallbackIndex] ?? fallbacks[fallbacks.length - 1]
    if (ref !== undefined) return { action: 'fallback', fallbackRef: ref, reason: `fallback[${fallbackIndex}]` }
  }

  if (!retryable) return { action: 'stop', reason: `${kind}_not_retryable` }
  if (attempt >= maxAttempts) return { action: 'stop', reason: 'max_attempts' }
  return { action: 'retry', reason: `${kind}_retryable attempt ${attempt}/${maxAttempts}` }
}

/**
 * Per-session 滑动窗口失败计数（吸收书 1-E nextRequestAttempt）。
 *
 * 与 bot.blocked（生命周期级别）分离：
 *   - bot.blocked 由单次致命失败（AUTH/QUOTA 等）设置，需用户修复。
 *   - 这里的计数器是"本次请求的连续失败次数"，10 分钟滑动窗口，
 *     超时或成功自动清零，防历史失败提前耗尽预算。
 *
 * @param {Map} store   调用方维护的 Map<sessionId, {count, windowStart}>
 * @param {string} sessionId
 * @param {{ windowMs?: number, success?: boolean }} [opts]
 *   success=true 时清零计数器；windowMs 默认 10 分钟
 * @returns {number} 更新后的失败次数（success 时为 0）
 */
export function nextRequestAttempt(store, sessionId, { windowMs = 10 * 60 * 1000, success = false } = {}) {
  if (success) {
    store.delete(sessionId)
    return 0
  }
  const now = Date.now()
  const existing = store.get(sessionId)
  if (existing === undefined || now - existing.windowStart > windowMs) {
    store.set(sessionId, { count: 1, windowStart: now })
    return 1
  }
  existing.count += 1
  return existing.count
}

