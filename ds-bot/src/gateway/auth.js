// auth.js — Bearer token verification against token-store
// Supports current token and previous token within its expiry window.
import { timingSafeEqual } from 'node:crypto'

function tokenMatches(given, stored) {
  if (!stored || typeof stored !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(stored)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * extractBearer(authHeader) -> token string or null
 */
export function extractBearer(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header ?? ''))
  return m ? m[1] : null
}

/**
 * verifyToken(authHeader, secrets, store) -> { nodeId } | null
 * secrets: Map<refName, tokenValue>
 * store: TokenStore (has .resolve(refName))
 */
export function verifyToken(authHeader, secrets, store) {
  const given = extractBearer(authHeader)
  if (!given) return null
  // Search all refNames whose stored token matches the given value
  for (const [refName, tokenValue] of secrets) {
    if (!tokenMatches(given, tokenValue)) continue
    const nodeId = store.resolve(refName)
    if (nodeId !== null) return { nodeId }
  }
  return null
}

/**
 * authMiddleware(secrets, store) -> (req, res, next) -> void
 * Attaches req.nodeId if valid; otherwise sends 401.
 */
export function authMiddleware(secrets, store) {
  return (req, res, next) => {
    const result = verifyToken(req.headers.authorization, secrets, store)
    if (!result) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'gateway-token-invalid' }))
      return
    }
    req.nodeId = result.nodeId
    next()
  }
}
