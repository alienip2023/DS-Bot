// models.js — GET /gw/:providerId/v1/models handler
/**
 * handleModels(providers, providerId, res)
 * Returns { data: [{id}] } for the given provider's profile.models.
 * 404 if provider not found.
 */
export function handleModels(providers, providerId, res) {
  const provider = providers.find(p => p.id === providerId)
  if (!provider) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'provider-not-found' }))
    return
  }
  const models = Array.isArray(provider.models) ? provider.models : []
  const data = models.map(m => ({ id: typeof m === 'string' ? m : m.id ?? m.ref ?? String(m) }))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ object: 'list', data }))
}
