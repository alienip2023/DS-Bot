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

// The turns this host wrote live (a hub message and the node's answer), which carry no identity from the node's
// own history. The node's history will list the same turns again; they are recognised by what was said, so the
// turns the node produced on its own (a routine, an IM message, its own Bot-to-Bot work) can still be imported
// without the live ones appearing twice.
const textOfMessage = (data) => {
  const content = data?.message?.content ?? data?.content
  return Array.isArray(content) ? content.map(block => (typeof block?.text === 'string' ? block.text : '')).join('') : ''
}
const normalize = (text) => String(text ?? '').replace(/^\[[^\r\n]*\]\r?\n?/, '').replace(/^[↩⚠][^\r\n]*\r?\n+/, '').replace(/\s+/g, ' ').trim()
const NOTICE = /^(节点仍在运行|没能让节点停下|⏹)/

function liveTurnsOf(session, botId) {
  const turns = []
  let current
  for (const event of session?.log ?? []) {
    if (event.type === 'turn/start') { current = { turn: event.data?.turn, user: undefined, bot: '' }; continue }
    if (current === undefined) continue
    if (event.type === 'user/message' && current.user === undefined) current.user = normalize(textOfMessage(event.data))
    else if (event.type === 'assistant/message') {
      const text = normalize(textOfMessage(event.data))
      if (text !== '' && !NOTICE.test(text)) current.bot = text
    } else if (event.type === 'turn/end') {
      const source = event.data?.mirrorHistory
      if (!(source && source.botId === botId)) turns.push(current)
      current = undefined
    }
  }
  if (current !== undefined) turns.push(current)   // a turn still open is the live one: its history is not final
  return turns
}

const sameTurn = (live, group) => {
  const user = normalize(group.userText)
  const bot = normalize(group.botText)
  if (live.user === undefined || live.user !== user) return false
  return live.bot === '' || bot === live.bot || bot.endsWith(live.bot) || live.bot.endsWith(bot)
}

export async function syncJoinedHistory(rt, bot, items, originalSession, unchanged, opts) {
  const allGroups = historyGroups(items)
  const { imported, untracked } = importedHistory(originalSession, bot.id)
  // A mirror that holds turns written live before the node's own history could be matched (it has no identity
  // for them) is never rewritten on a guess. The history as it stands now is taken as already represented (a
  // baseline per node part); from then on only what the node adds AFTER it is imported — the turns it produced
  // on its own (a routine, its IM, its own Bot-to-Bot work) — and the live ones are recognised by what was said.
  if (untracked && bot.historyBaseline === undefined) {
    const parts = {}
    for (const group of allGroups) parts[group.partId] = Math.max(parts[group.partId] ?? -1, group.seq)
    bot.historyBaseline = { parts, at: Date.now() }
    await rt.save?.()
    return { deferred: 'the mirror has live turns without remote identity: the history up to now is kept as it is, newer node turns will be imported' }
  }
  const baseline = bot.historyBaseline?.parts ?? {}
  const live = liveTurnsOf(originalSession, bot.id)
  // A node turn this host already wrote live is not imported again; each live turn matches at most one.
  const groups = allGroups.filter((group) => {
    if (imported.has(keyOf(group))) return true
    if (group.seq <= (baseline[group.partId] ?? -1)) return false
    const at = live.findIndex(turn => sameTurn(turn, group))
    if (at === -1) return true
    live.splice(at, 1)
    return false
  })
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
