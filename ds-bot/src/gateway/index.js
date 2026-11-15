// index.js — Gateway server start/stop
import { createServer } from 'node:http'
import { createRouter } from './router.js'
import { authMiddleware } from './auth.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4387

/**
 * createGatewayServer({ gatewayHost, gatewayPort, secrets, store, providers, rt }) -> { start, stop }
 * start() -> Promise<port>
 * stop()  -> Promise<void>
 *
 * On EADDRINUSE: logs rt.warn and resolves with null (1F: host starts normally).
 */
export function createGatewayServer({ gatewayHost, gatewayPort, secrets, store, providers, rt, timeoutMs, bodyLimit }) {
  const host = gatewayHost ?? DEFAULT_HOST
  const port = gatewayPort ?? DEFAULT_PORT
  let server = null
  let starting = null
  let generation = 0

  const close = async s => {
    s.closeAllConnections?.()
    await new Promise(resolve => s.close(resolve))
  }

  const auth = authMiddleware(secrets, store)
  const route = createRouter({ auth, providers, timeoutMs, bodyLimit })

  return {
    async start() {
      if (starting !== null) return starting
      if (server !== null) return server.address()?.port ?? null
      const startedAt = generation
      const s = createServer((req, res) => {
        req.on('error', () => res.destroy())
        res.on('error', () => req.destroy())
        route(req, res).catch(err => {
          if (!res.headersSent) { res.writeHead(500); res.end() }
          else res.destroy()
          rt?.warn?.('ds-bot: gateway route error: %s', err?.message ?? err)
        })
      })
      starting = (async () => {
        try {
          await new Promise((resolve, reject) => {
            s.once('error', reject)
            s.listen(port, host, resolve)
          })
        } catch (err) {
          if (err.code === 'EADDRINUSE') {
            rt?.warn?.('ds-bot: gateway port %s:%s in use (EADDRINUSE) — gateway disabled', host, port)
            return null
          }
          throw err
        }
        // A disposed runtime must never publish or leave behind a late listener.
        if (startedAt !== generation) {
          await close(s)
          return null
        }
        server = s
        const actualPort = s.address().port
        try { rt?.ctx?.provide?.('ds-bot:gateway-port', actualPort) } catch {}
        return actualPort
      })().finally(() => { starting = null })
      return starting
    },
    async stop() {
      generation++
      const pending = starting
      const s = server
      server = null
      if (s) await close(s)
      if (pending) await pending.catch(() => {})
    },
  }
}
