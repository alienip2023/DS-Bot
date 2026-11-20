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
