import { createHash } from 'node:crypto'
import { looksSecret } from './memory-entries.js'

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const MAX_ITEMS = 64
const MAX_BYTES = 64 * 1024
const absolutePath = /(?:^|[\s"'`(=])(?:\/\S|[a-z]:[\\/]|\\\\|~[\\/])/i
const conversation = /(?:^|\n)\s*(?:User|Assistant|System|用户|助手)\s*[:：]|<\/?(?:work|conversation|message|skill)\b/i
const writers = new WeakMap()

export function sharedSkillProblem(item, rt) {
  if (!item || typeof item.name !== 'string' || item.name.length > 32 || !NAME.test(item.name)) return 'Invalid shared skill name.'
  if (typeof item.description !== 'string' || !item.description.trim() || item.description.length > 300
    || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 8000) return 'Shared skill text is missing or too large.'
  const text = `${item.name}\n${item.description}\n${item.content}`
  if (looksSecret(text) || /\$DSH_SECRET_|\b(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/i.test(text)
    || (rt.redactSecrets?.(text) ?? text) !== text) return 'Shared skills cannot contain secrets.'
  if (absolutePath.test(text)) return 'Shared skills cannot contain absolute paths. Use placeholders.'
  if (conversation.test(text)) return 'Shared skills cannot contain private conversations. Keep standalone instructions.'
  return undefined
}

export function sharedSkillSnapshot(rt, { forward = false } = {}) {
  const items = []
  for (const item of Object.values(rt.state.capabilities?.items ?? {})) {
    if (item.kind !== 'skill' || (!item.teamReusable && !(forward && item.sharedFrom))) continue
    if (item.createdBy && rt.isPrivate?.(item.createdBy)) continue
    const entry = { id: item.sharedId, name: item.sharedName ?? item.name, description: item.description, content: item.content }
    if (!ID.test(entry.id ?? '') || sharedSkillProblem(entry, rt)) continue
    if (items.length >= MAX_ITEMS || Buffer.byteLength(JSON.stringify({ version: 1, items: [...items, entry] }), 'utf8') > MAX_BYTES) break
    items.push(entry)
  }
  return { version: 1, items }
}

// Only the source of a snapshot may replace its imports; a name never grants ownership.
export function applySharedSkills(rt, source, snapshot, { isActive = () => true } = {}) {
  const run = (writers.get(rt) ?? Promise.resolve()).catch(() => {}).then(() => applySnapshot(rt, source, snapshot, isActive))
  writers.set(rt, run)
  return run.finally(() => { if (writers.get(rt) === run) writers.delete(rt) })
}

async function applySnapshot(rt, source, snapshot, isActive) {
  if (!isActive()) return false
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.items) || snapshot.items.length > MAX_ITEMS) return false
  if (Buffer.byteLength(JSON.stringify({ version: 1, items: snapshot.items }), 'utf8') > MAX_BYTES) return false
  await rt.load?.()
  if (rt.readOnly?.() !== undefined) return false
  await rt.loadSecrets?.()
  if (!isActive()) return false
  const incoming = new Map()
  for (const item of snapshot.items) {
    if (!ID.test(item?.id ?? '') || sharedSkillProblem(item, rt) || incoming.has(item.id)) return false
    incoming.set(item.id, { id: item.id, name: item.name, description: item.description, content: item.content })
  }
  const library = rt.state.capabilities.items
  const before = structuredClone(rt.state.capabilities)
  const attachments = new Map(Object.values(rt.state.bots).map(bot => [bot.id, [...(bot.capabilities ?? [])]]))
  let changed = false
  for (const [name, item] of Object.entries(library)) {
    if (item.sharedFrom !== source || incoming.has(item.sharedId)) continue
    delete library[name]
    for (const bot of Object.values(rt.state.bots)) bot.capabilities = (bot.capabilities ?? []).filter(value => value !== name)
    for (const pack of Object.values(library)) if (pack.kind === 'pack') pack.items = (pack.items ?? []).filter(value => value !== name)
    changed = true
  }
  for (const entry of incoming.values()) {
    const existing = Object.values(library).find(item => item.sharedId === entry.id)
    // A round trip must not turn the original into a remote import, nor move another source's item.
    if (existing && existing.sharedFrom !== source) continue
    const suffix = createHash('sha256').update(entry.id).digest('hex').slice(0, 12)
    const name = existing?.name ?? `${entry.name.slice(0, 19).replace(/-+$/, '')}-${suffix}`
    if (library[name] && library[name] !== existing) continue
    if (existing?.content === entry.content && existing?.description === entry.description && existing?.sharedName === entry.name) continue
    library[name] = {
      name, kind: 'skill', description: entry.description, content: entry.content,
      sharedId: entry.id, sharedName: entry.name, sharedFrom: source,
      createdBy: null, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
    }
    changed = true
  }
  if (!changed) return true
  try {
    await rt.save()
    rt.markPeerRosterDirty?.()
    return true
  } catch (error) {
    rt.state.capabilities = before
    for (const bot of Object.values(rt.state.bots)) bot.capabilities = attachments.get(bot.id) ?? bot.capabilities
    throw error
  }
}
