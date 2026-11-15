import { importHistory } from './mirror.js'

const keyOf = item => JSON.stringify([item.partId, item.turn])
const isMessage = item => item.kind === 'user' || item.kind === 'bot'

export function hasHistoryIdentity(items) {
  const messages = items.filter(isMessage)
  return messages.length > 0 && messages.every(item => typeof item.partId === 'string' && item.partId !== ''
    && Number.isInteger(item.turn) && Number.isInteger(item.seq) && item.seq >= 0)
}

function historyGroups(items) {
  const groups = new Map()
  for (const item of items.filter(isMessage)) {
    const key = keyOf(item)
    if (!groups.has(key)) groups.set(key, { partId: item.partId, turn: item.turn, seq: 0, userText: '', botText: '', complete: false })
    const group = groups.get(key)
    const field = item.kind === 'user' ? 'userText' : 'botText'
    group[field] += (group[field] ? '\n' : '') + (item.text ?? '')
    group.seq = Math.max(group.seq, item.seq)
    group.complete ||= item.turnComplete === true
  }
  return [...groups.values()]
}

// The Session is authoritative: state.json may be older after an interrupted save.
function importedHistory(session, botId) {
  const imported = new Map()
  const messageTurns = new Set()
  let turn
  for (const event of session?.log ?? []) {
    if (event.type === 'turn/start') turn = event.data?.turn
    if (event.type === 'user/message' || event.type === 'assistant/message') messageTurns.add(turn)
    const source = event.type === 'turn/end' && event.data?.mirrorHistory
    if (source && source.botId === botId) {
      if (event.data.reason?.kind === 'completed') imported.set(keyOf(source), source.seq)
      messageTurns.delete(event.data.turn)
    }
  }
  return { imported, untracked: messageTurns.size > 0 }
}

export async function syncJoinedHistory(rt, bot, items, originalSession, unchanged, opts) {
  const groups = historyGroups(items)
  const { imported, untracked } = importedHistory(originalSession, bot.id)
  if (untracked) return { deferred: 'mirror contains turns without remote part identity' }
  const pending = groups.filter(group => !imported.has(keyOf(group)))
  // A turn already imported must never silently acquire a second copy or lose a tail.
  if (groups.some(group => imported.has(keyOf(group)) && imported.get(keyOf(group)) !== group.seq)) {
    return { deferred: 'an imported node turn changed; reconciliation requires an explicit snapshot' }
  }
  const ready = pending.filter(group => group.complete && group.userText !== '' && group.botText !== '')
  if (pending.length > ready.length) return { deferred: 'node history contains incomplete or unclosed turns' }
  if (ready.length === 0) return { skipped: true }
  if (opts.dryRun) return { wouldRebuild: { botId: bot.id, turns: ready.length, incremental: true } }

  const oldSessionId = bot.sessionId
  const sessionId = oldSessionId || await rt.createSession(bot.id + ' (mirror)')
  const session = originalSession ?? (await rt.resolveAgent(sessionId)).session
  if (!session) throw new Error('mirror session unavailable')
  if (!unchanged()) return { skipped: true }
  // importHistory appends synchronously before returning its Promise. The final check
  // above and those writes cannot interleave with either live mirror writer.
  const result = await importHistory(session, ready, {
    botId: bot.id, gapMode: 'none', seenKeys: new Set(), seenSteps: new Set(),
  })
  if (result.imported !== ready.length) throw new Error('history import incomplete: ' + result.warnings.join('; '))
  await rt.ctx?.sessions?.flush?.(session)
  if (!oldSessionId && !unchanged()) return { skipped: true }
  bot = rt.botOf?.(bot.id) ?? rt.state.bots[bot.id]
  if (!bot || bot.sessionId !== oldSessionId || opts.isActive?.() === false) return { skipped: true }
  const previous = bot.mirrorHistory
  const parts = new Map()
  for (const event of session.log) {
    const source = event.type === 'turn/end' && event.data?.mirrorHistory
    if (source?.botId === bot.id && event.data.reason?.kind === 'completed') {
      parts.set(source.partId, Math.max(parts.get(source.partId) ?? 0, source.seq))
    }
  }
  bot.sessionId = sessionId
  bot.mirrorHistory = { sessionId, parts: [...parts].map(([partId, seq]) => ({ partId, seq })) }
  if (!oldSessionId) rt.updateBySessionId?.(bot.id, oldSessionId, sessionId)
  try {
    await rt.save?.()
  } catch (error) {
    const current = rt.botOf?.(bot.id) ?? rt.state.bots[bot.id]
    if (current?.sessionId === sessionId) {
      current.mirrorHistory = previous
      if (!oldSessionId) {
        current.sessionId = oldSessionId
        rt.updateBySessionId?.(bot.id, sessionId, oldSessionId)
      }
    }
    throw error
  }
  return { migrated: { botId: bot.id, imported: result.imported, warnings: result.warnings } }
}
