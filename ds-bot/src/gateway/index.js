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
export function createGatewayServer({ gatewayHost, gatewayPort, secrets, store, providers, rt }) {
  const host = gatewayHost ?? DEFAULT_HOST
  const port = gatewayPort ?? DEFAULT_PORT
  let server = null

  const auth = authMiddleware(secrets, store)
  const route = createRouter({ auth, providers })

  return {
    async start() {
      if (server !== null) return server.address()?.port ?? null
      const s = createServer((req, res) => {
        req.on('error', () => res.destroy())
        res.on('error', () => req.destroy())
        route(req, res).catch(err => {
          if (!res.headersSent) { res.writeHead(500); res.end() }
          else res.destroy()
          rt?.warn?.('ds-bot: gateway route error: %s', err?.message ?? err)
        })
      })
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
      server = s
      const actualPort = s.address().port
      try { rt?.ctx?.provide?.('ds-bot:gateway-port', actualPort) } catch {}
      return actualPort
    },
    async stop() {
      const s = server
      server = null
      if (s) await new Promise(resolve => s.close(resolve))
    },
  }
}
