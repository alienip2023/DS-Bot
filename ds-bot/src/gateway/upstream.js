// upstream.js — filter upstream providers, excluding the gateway itself
/**
 * readUpstreamProviders(providers, gatewayOrigin) -> filtered providers
 * Excludes providers whose baseURL origin matches the gateway's own origin.
 * 127.0.0.1:11434 (ollama) is preserved because its port differs from gateway port.
 */
export function readUpstreamProviders(providers, gatewayOrigin) {
  if (!Array.isArray(providers)) return []
  return providers.filter(p => {
    if (!p.baseURL) return true
    try {
      const u = new URL(p.baseURL)
      return u.origin !== gatewayOrigin
    } catch {
      return true
    }
  })
}
