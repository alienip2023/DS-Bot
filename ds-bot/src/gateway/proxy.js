// proxy.js — SSE proxy for model gateway
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const PASSTHROUGH_STATUS = new Set([402, 429])
const PASSTHROUGH_RES_HEADERS = ['content-type', 'retry-after', 'x-request-id']

function resolveUpstreamUrl(baseURL, path) {
  const base = String(baseURL ?? '').replace(/\/$/, '')
  const tail = '/' + path.replace(/^\//, '')
  return new URL(base + tail)
}

function upstreamRequest(target, init, onResponse) {
  const fn = target.protocol === 'https:' ? httpsRequest : httpRequest
  return fn(target, init, onResponse)
}

export function proxyChat({ provider, body, clientReq, res, timeoutMs = 120000, signal }) {
  return new Promise((resolve) => {
    let resolved = false
    const done = () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve() } }
    const apiKey = provider.apiKey ?? provider.api?.key ?? ''
    let target
    try {
      target = resolveUpstreamUrl(provider.baseURL, '/chat/completions')
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'upstream-error' }))
      done()
      return
    }

    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'content-length': body.length,
      'accept': 'text/event-stream',
    }

    let aborted = false
    let upstreamReq = null

    const doAbort = () => {
      if (aborted) return
      aborted = true
      upstreamReq?.destroy()
      if (!res.writableEnded) { try { res.end() } catch {} }
      done()
    }

    signal?.addEventListener('abort', doAbort, { once: true })
    clientReq.on('close', doAbort)
    clientReq.on('aborted', doAbort)
    res.on('close', doAbort)

    const timer = setTimeout(() => {
      if (aborted) return
      aborted = true
      upstreamReq?.destroy()
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'gateway-timeout' }))
      } else if (!res.writableEnded) {
        res.destroy()
      }
      done()
    }, timeoutMs)

    upstreamReq = upstreamRequest(target, { method: 'POST', headers }, upstream => {
      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'upstream-error' }))
        } else if (!res.writableEnded) {
          res.destroy()
        }
        done()
      })

      upstream.on('close', () => { if (aborted) done() })

      const status = upstream.statusCode ?? 502

      if (PASSTHROUGH_STATUS.has(status)) {
        const heads = { 'content-type': 'application/json' }
        const ra = upstream.headers['retry-after']
        if (ra !== undefined) heads['retry-after'] = ra


        upstream.setEncoding('utf8')
        let raw = ''
        upstream.on('data', d => { raw += d })
        upstream.on('end', () => {
          res.writeHead(status, heads)
          res.end(raw)
          done()
        })
        return
      }

      if (status >= 400 || status < 200) {
        upstream.setEncoding('utf8')
        let raw = ''
        upstream.on('data', d => { raw += d })
        upstream.on('end', () => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(raw)
          done()
        })
        return
      }

      const isSSE = String(upstream.headers['content-type'] ?? '').includes('text/event-stream')
      const resHeads = { 'content-type': isSSE ? 'text/event-stream' : (upstream.headers['content-type'] ?? 'application/octet-stream') }
      for (const h of PASSTHROUGH_RES_HEADERS) if (upstream.headers[h] !== undefined) resHeads[h] = upstream.headers[h]
      res.writeHead(200, resHeads)

      upstream.on('data', chunk => { if (!res.writableEnded) res.write(chunk) })
      upstream.on('end', () => {
        if (!res.writableEnded) res.end()
        done()
      })
    })

    upstreamReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream-error' }))
      } else if (!res.writableEnded) {
        res.destroy()
      }
      done()
    })

    upstreamReq.write(body)
    upstreamReq.end()
  })
}
