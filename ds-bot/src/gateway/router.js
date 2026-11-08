// router.js — HTTP router for model gateway
import { handleModels } from './models.js'
import { proxyChat } from './proxy.js'

const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024 // 8MB

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', chunk => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) { tooLarge = true; chunks.length = 0; reject(Object.assign(new Error('body too large'), { code: 'E_TOO_LARGE' })) }
      else chunks.push(chunk)
    })
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

/**
 * createRouter({ auth, providers }) -> (req, res) -> void
 * auth: authMiddleware(secrets, store) — (req, res, next) -> void
 * providers: Array<{id, models}>
 */
export function createRouter({ auth, providers = [], timeoutMs, bodyLimit }) {
  return async function route(req, res) {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    // GET /probe — health check (no auth)
    if (method === 'GET' && url === '/probe') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // All other routes require auth
    let authed = false
    auth(req, res, () => { authed = true })
    if (!authed) return

    // GET /gw/:providerId/v1/models
    const modelsMatch = /^\/gw\/([^\/]+)\/v1\/models$/.exec(url)
    if (method === 'GET' && modelsMatch) {
      handleModels(providers, modelsMatch[1], res)
      return
    }

    // POST /gw/:providerId/v1/chat/completions — 1A-2: not implemented in Slice 1A
    const chatMatch = /^\/gw\/([^\/]+)\/v1\/chat\/completions$/.exec(url)
    if (method === 'POST' && chatMatch) {
      const providerId = chatMatch[1]
      const provider = providers.find(p => p.id === providerId)
      if (!provider) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'provider-not-found' }))
        return
      }
      // Body size check
      let body
      try {
        body = await readBody(req, bodyLimit ?? DEFAULT_BODY_LIMIT)
      } catch (e) {
        if (e.code === 'E_TOO_LARGE') {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'request-entity-too-large' }))
          return
        }
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'read-error' }))
        return
      }
      // 1A-2: SSE proxy
      const ac = new AbortController()
      await proxyChat({ provider, body, clientReq: req, res, timeoutMs, signal: ac.signal })
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not-found' }))
  }
}
