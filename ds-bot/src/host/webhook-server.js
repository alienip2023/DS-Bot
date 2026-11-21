// Webhook triggers: a local HTTP server on 127.0.0.1 that receives POST requests
// and delivers a configured prompt to the target Bot's chat, like a one-shot scheduled
// task. Webhook records live in state.webhooks, keyed by a random 24-char hex id.
//
// A webhook POST body is JSON: { payload?: any }. The payload is passed to the prompt
// template as {{payload}} if the prompt contains that placeholder. Bearer token auth
// is required; the secret is generated once and stored in the webhook record.
//
// The server binds to 127.0.0.1 only: webhook callers on the same machine or via a
// reverse proxy (nginx, Cloudflare Tunnel, etc.) can reach it; the LAN cannot.
//
// Port defaults to 4388; the user can override via state.prefs.webhookPort.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const DEFAULT_PORT = 4388
const MAX_BODY = 64 * 1024
const TOKEN_RE = /^Bearer ([a-f0-9]{24,64})$/i
const TOKEN_BYTES = 12

export function generateWebhookToken() {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

export function generateWebhookId() {
  return randomBytes(12).toString('hex')
}

// Substitute {{payload}} in the prompt with a compact JSON representation.
function renderPrompt(template, payload) {
  if (!template.includes('{{payload}}')) return template
  const text = payload === undefined || payload === null ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload))
  return template.replace(/\{\{payload\}\}/g, text)
}

export function installWebhookServer(rt) {
  const { ctx } = rt
  let server = null
  let port = null
  let disposed = false

  ctx.effect?.(() => () => { disposed = true; stopServer() }, 'ds-bot: webhook server')

  function stopServer() {
    if (server === null) return
    const s = server
    server = null
    port = null
    s.close()
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    // Health check
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    // Webhook delivery: POST /webhook/<id>
    const match = /^\/webhook\/([a-f0-9]{24})$/i.exec(url.pathname)
    if (!match || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not-found' }))
      return
    }
    const webhookId = match[1].toLowerCase()

    // Read body with size limit
    let body = ''
    let tooLarge = false
    await new Promise((resolve) => {
      req.on('data', chunk => {
        body += chunk
        if (body.length > MAX_BODY) { tooLarge = true; req.destroy(); resolve() }
      })
      req.on('end', resolve)
      req.on('error', resolve)
    })
    if (tooLarge) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'payload-too-large' }))
      return
    }

    await rt.load()
    const webhook = (rt.state.webhooks ?? {})[webhookId]
    if (!webhook || webhook.disabled === true) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not-found' }))
      return
    }

    // Bearer token auth
    const auth = req.headers['authorization'] ?? ''
    const tokenMatch = TOKEN_RE.exec(auth)
    if (!tokenMatch || tokenMatch[1] !== webhook.secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    // Parse JSON body
    let parsed = {}
    if (body.trim() !== '') {
      try { parsed = JSON.parse(body) } catch { /* treat as empty */ }
    }
    const payload = parsed?.payload

    // Dispatch the prompt to the target Bot/room
    const prompt = renderPrompt(webhook.prompt, payload)
    try {
      await rt.webhookDeliver?.({ webhookId, botId: webhook.botId, roomId: webhook.roomId, prompt, payload })
      // Update lastFiredAt
      webhook.lastFiredAt = Date.now()
      webhook.fireCount = (webhook.fireCount ?? 0) + 1
      await rt.save()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, webhookId, fireCount: webhook.fireCount }))
    } catch (error) {
      rt.warn?.('ds-bot: webhook %s delivery failed: %s', webhookId, error?.message ?? error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'delivery-failed' }))
    }
  }

  async function startServer(desiredPort) {
    if (server !== null && port === desiredPort) return
    stopServer()
    if (disposed) return
    const s = createServer((req, res) => void handleRequest(req, res).catch(() => {}))
    await new Promise((resolve, reject) => {
      s.once('error', reject)
      s.listen(desiredPort, '127.0.0.1', resolve)
    })
    if (disposed) { s.close(); return }
    server = s
    port = desiredPort
    rt.warn?.('ds-bot: webhook server listening on 127.0.0.1:%d', port)
  }

  async function syncServer() {
    await rt.load()
    const webhooks = rt.state.webhooks ?? {}
    const hasActive = Object.values(webhooks).some(w => w && w.disabled !== true)
    if (!hasActive) { stopServer(); return }
    const desiredPort = rt.state.prefs?.webhookPort ?? DEFAULT_PORT
    await startServer(desiredPort).catch(err => rt.warn?.('ds-bot: webhook server start failed: %s', err?.message ?? err))
  }

  Object.assign(rt, {
    webhookPort: () => port,
    syncWebhookServer: syncServer,
  })

  // Start when the runtime loads, and re-sync when state changes.
  ctx.on?.('ds-bot/state-loaded', () => void syncServer())
}
