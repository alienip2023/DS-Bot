// 凭证代理拦截层：在 Bot 工具调用执行前，把 tt_* opaque token 替换为真实凭证。
//
// 拦截策略：
//   1. 监听 ctx.on('tools/pre-execute')，在工具执行前检查所有字符串参数。
//   2. 发现 tt_* 格式的 token 时，通过 rt.resolveTaskToken(token) 验证它有效。
//   3. 用 rt.getSecret('task-token:<name>') 换出真实值，注入到参数副本里。
//   4. 任何错误只记录警告，不阻塞工具执行（安全降级：传 original token）。
//
// 只拦截已注册为 HTTP / external 相关的工具名（避免误替换内部工具）。
// 未来可在 allowedTools 里扩展。

const TOKEN_RE = /tt_[0-9a-f]{24}/g
const HTTP_TOOLS = new Set([
  'web_search', 'web_fetch', 'http_request', 'fetch', 'curl',
  'github_api', 'jira_api', 'slack_api', 'linear_api',
  // capabilities / MCP tools registered by name also pass through here
])

function deepReplace(value, replacer) {
  if (typeof value === 'string') return replacer(value)
  if (Array.isArray(value)) return value.map(item => deepReplace(item, replacer))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = deepReplace(v, replacer)
    return out
  }
  return value
}

export function installCredentialInterceptor(rt) {
  if (typeof rt.resolveTaskToken !== 'function') return
  const { ctx } = rt

  ctx.on('tools/pre-execute', async (exec, next) => {
    // Only intercept for external/HTTP-flavoured tools; skip internals.
    const toolName = exec.name ?? ''
    // Check if any string arg contains a tt_* token.
    const argsStr = JSON.stringify(exec.arguments ?? '')
    if (!argsStr.includes('tt_')) return next()

    const tokens = [...new Set(argsStr.match(TOKEN_RE) ?? [])]
    if (tokens.length === 0) return next()

    // Build a resolution map: token → real value
    const resolved = new Map()
    for (const token of tokens) {
      try {
        const rec = rt.resolveTaskToken(token)
        if (!rec) continue
        const secret = typeof rt.getSecret === 'function' ? rt.getSecret(`task-token:${rec.name}`) : undefined
        if (typeof secret === 'string' && secret !== '') {
          resolved.set(token, secret)
        }
      } catch (err) {
        rt.warn?.('ds-bot: credential-interceptor resolution failed for %s: %s', token, err?.message ?? err)
      }
    }
    if (resolved.size === 0) return next()

    // Patch arguments in place with resolved values.
    const replacer = (str) => {
      let result = str
      for (const [token, secret] of resolved) result = result.replaceAll(token, secret)
      return result
    }
    try {
      const patched = deepReplace(exec.arguments, replacer)
      // Replace arguments on exec (the interceptor sees a mutable view).
      Object.assign(exec.arguments, patched)
    } catch (err) {
      rt.warn?.('ds-bot: credential-interceptor patch failed: %s', err?.message ?? err)
    }
    return next()
  })
}
