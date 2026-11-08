// Step 1: a remote DS-Bot roster becomes shadow rows in the controller sidebar.
// No turn is started here, and no local session is created.

export function joinedShadow(bot) {
  return Boolean(bot && bot.origin === 'joined' && bot.worker && bot.worker.home === 'remote')
}

// Step 1 must not start a remote task and must not fall through to a local session.
export function refuseJoinedDispatch(bot) {
  if (!joinedShadow(bot)) return undefined
  return { ok: false, error: 'joined shadow cannot dispatch' }
}

export function shadowId(nodeId, remoteBotId) {
  return `joined:${encodeURIComponent(nodeId)}:${encodeURIComponent(remoteBotId)}`
}

export function reportableBots(bots) {
  return Object.values(bots ?? {}).flatMap((bot) => {
    if (!bot || typeof bot !== 'object') return []
    if (bot.type === 'remote-worker') return []
    const id = typeof bot.id === 'string' ? bot.id.trim() : ''
    if (id === '') return []
    return [{
      id,
      name: typeof bot.name === 'string' ? bot.name : '',
      role: typeof bot.role === 'string' ? bot.role : '',
    }]
  })
}

export function applyRosterReport(state, report, now = Date.now()) {
  if (!state.bots || typeof state.bots !== 'object') state.bots = {}
  const nodeId = typeof report?.nodeId === 'string' ? report.nodeId.trim() : ''
  if (nodeId === '') return []
  const hostname = typeof report?.hostname === 'string' && report.hostname !== '' ? report.hostname : nodeId
  const online = report?.online !== false
  const bots = Array.isArray(report?.bots) ? report.bots : []
  const seen = []
  for (const bot of bots) {
    if (!bot || typeof bot !== 'object' || bot.type === 'remote-worker') continue
    const remoteBotId = typeof bot.id === 'string' ? bot.id.trim() : ''
    if (remoteBotId === '') continue
    const id = shadowId(nodeId, remoteBotId)
    const existing = state.bots[id]
    const row = {
      ...(existing ?? {}),
      id,
      name: String(bot.name ?? existing?.name ?? remoteBotId).slice(0, 40),
      role: String(bot.role ?? existing?.role ?? '').slice(0, 24),
      type: 'remote-worker',
      origin: 'joined',
      createdAt: existing?.createdAt ?? now,
      capabilities: existing?.capabilities ?? [],
      worker: {
        ...(existing?.worker ?? {}),
        nodeId,
        remoteBotId,
        hostname,
        home: 'remote',
        online,
        lastSeen: now,
      },
    }
    state.bots[id] = row
    seen.push(row)
  }
  return seen
}

export function markNodeOffline(state, nodeId, now = Date.now()) {
  for (const bot of Object.values(state?.bots ?? {})) {
    if (bot?.worker?.home === 'remote' && bot.worker.nodeId === nodeId && bot.origin === 'joined') {
      bot.worker.online = false
      bot.worker.lastSeen = now
    }
  }
}

/**
 * Migrate legacy joined Bots: rebuild mirror sessions from node history.
 * For each joined Bot:
 *   - Fetch all history via joinedChatPage (paginating to cursor=null)
 *   - Group items by turn into {userText, botText, turn, seq} pairs
 *   - If bot.mirrorWatermark >= maxSeq → skip (already up-to-date)
 *   - Else rebuild: create new session, importHistory, update watermark
 * opts.dryRun: return wouldRebuild list, zero writes
 * Returns {migrated, skipped, failed, errors}
 */
export async function migrateLegacyJoined(rt, opts = {}) {
  const { dryRun = false } = opts
  const { importHistory } = await import('./mirror.js')
  // Use rt.joinedChatPage if available (testability), else import from module
  const joinedChatPage = typeof rt.joinedChatPage === 'function'
    ? rt.joinedChatPage
    : (await import('./joined-page.js')).joinedChatPage
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const bots = Object.values(rt?.state?.bots ?? {}).filter(b => b?.origin === 'joined')
  const migrated = []
  const skipped = []
  const failed = []
  const errors = []
  const wouldRebuild = []

  // Snapshot state before any writes
  if (!dryRun && bots.length > 0) {
    const dshHome = rt.dshHome ?? join(homedir(), '.dsh')
    const backupData = JSON.stringify(rt.state?.bots, null, 2)
    let backupPath = join(dshHome, 'bot-home-s2-backup.json')
    if (existsSync(backupPath)) {
      backupPath = join(dshHome, `bot-home-s2-backup-${Date.now()}.json`)
    }
    try {
      mkdirSync(dshHome, { recursive: true })
      writeFileSync(backupPath, backupData, { encoding: 'utf8', flag: 'wx' })
    } catch (backupErr) {
      rt.warn?.('ds-bot: migrateLegacyJoined backup failed: %s', backupErr?.message ?? backupErr)
    }
  }

  for (const bot of bots) {
    try {
      // Fetch all history from node, paginating to cursor=null
      const allItems = []
      let cursor = undefined
      let offlineDetected = false

      do {
        const page = await joinedChatPage(rt, bot.id, cursor)
        const items = page?.items ?? []
        // Detect offline/error items (only 1 item with kind:'bot' and no seq)
        if (items.length === 1 && items[0].kind === 'bot' && typeof items[0].seq !== 'number') {
          offlineDetected = true
          break
        }
        allItems.push(...items)
        // ?? null ensures undefined cursor stops the loop (undefined != null is true without this)
        cursor = page?.cursor ?? null
      } while (cursor != null)

      if (offlineDetected) {
        const msg = 'node offline or history unavailable'
        failed.push(bot.id)
        errors.push({ botId: bot.id, error: msg })
        rt.warn?.('ds-bot: migrateLegacyJoined %s failed: %s', bot.id, msg)
        continue
      }

      // Group items by turn into {userText, botText, turn, seq} pairs
      // allItems is newest-first (pagination order) — reverse to get time-ascending order
      const orderedItems = [...allItems].reverse()
      const byTurn = new Map()
      let maxSeq = 0
      for (const item of orderedItems) {
        if (typeof item.seq === 'number' && item.seq > maxSeq) maxSeq = item.seq
        const t = item.turn ?? 0
        if (!byTurn.has(t)) byTurn.set(t, { turn: t, userText: '', botText: '', seq: null })
        const g = byTurn.get(t)
        // join multi-text blocks with newline (newest-first pagination can yield multiple per turn)
        if (item.kind === 'user') g.userText = g.userText ? g.userText + '\n' + (item.text ?? '') : (item.text ?? '')
        if (item.kind === 'bot') { g.botText = g.botText ? g.botText + '\n' + (item.text ?? '') : (item.text ?? ''); if (typeof item.seq === 'number' && (g.seq === null || item.seq > g.seq)) g.seq = item.seq }
      }

      // Filter: only complete pairs (user + bot)
      const groups = [...byTurn.values()]
        .filter(g => g.userText !== '' && g.botText !== '')
        .sort((a, b) => a.turn - b.turn)

      // Skip: empty history + existing mirror → preserve (node may have been wiped, don't clobber mirror)
      if (allItems.length === 0 && typeof bot.sessionId === 'string' && bot.sessionId !== '') {
        skipped.push(bot.id)
        continue
      }

      // Skip if bot already has a mirror session and watermark covers all items
      const currentWatermark = bot.mirrorWatermark ?? 0
      if (typeof bot.sessionId === 'string' && bot.sessionId !== '' && currentWatermark >= maxSeq) {
        // watermark >= maxSeq: mirror is up-to-date — preserve
        skipped.push(bot.id)
        continue
      }

      if (dryRun) {
        wouldRebuild.push({ botId: bot.id, turns: groups.length, maxSeq, currentWatermark })
        continue
      }

      // Rebuild: create new session
      const oldSessionId = bot.sessionId ?? null
      let newSessionId
      try {
        newSessionId = await rt.createSession(bot.id + ' (mirror)')
      } catch (createErr) {
        const msg = 'createSession failed: ' + (createErr?.message ?? createErr)
        failed.push(bot.id)
        errors.push({ botId: bot.id, error: msg })
        rt.warn?.('ds-bot: migrateLegacyJoined %s failed: %s', bot.id, msg)
        continue
      }

      let agent
      try {
        agent = await rt.resolveAgent(newSessionId)
      } catch (resolveErr) {
        const msg = 'resolveAgent failed: ' + (resolveErr?.message ?? resolveErr)
        failed.push(bot.id)
        errors.push({ botId: bot.id, error: msg })
        rt.warn?.('ds-bot: migrateLegacyJoined %s failed: %s', bot.id, msg)
        continue
      }

      const session = agent.session
      const seenKeys = new Set()
      const closedKeys = new Set()
      const seenSteps = new Set()

      let importResult
      try {
        importResult = await importHistory(session, groups, {
          botId: bot.id,
          watermark: 0,
          gapMode: 'turn',  // bulk migration: check turn order not seq continuity
          seenKeys,
          closedKeys,
          seenSteps,
        })
      } catch (importErr) {
        // Import failed: revert bot state (don't leave half-built session)
        const msg = 'importHistory failed: ' + (importErr?.message ?? importErr)
        failed.push(bot.id)
        errors.push({ botId: bot.id, error: msg })
        rt.warn?.('ds-bot: migrateLegacyJoined %s failed: %s', bot.id, msg)
        // Don't update bot.sessionId — leave it pointing to old session
        continue
      }

      // Update bot state, then save — rollback all fields if save fails
      const prevSessionId = bot.sessionId
      const prevLegacyMirrorSessionId = bot.legacyMirrorSessionId
      const prevWatermark = bot.mirrorWatermark
      const prevRebuiltAt = bot.mirrorRebuiltAt
      bot.legacyMirrorSessionId = oldSessionId
      bot.sessionId = newSessionId
      rt.updateBySessionId?.(bot.id, oldSessionId, newSessionId)
      bot.mirrorWatermark = maxSeq
      bot.mirrorRebuiltAt = new Date().toISOString()
      try {
        await rt.save?.()
      } catch (saveErr) {
        // Rollback all state changes
        bot.sessionId = prevSessionId
        bot.legacyMirrorSessionId = prevLegacyMirrorSessionId
        bot.mirrorWatermark = prevWatermark
        bot.mirrorRebuiltAt = prevRebuiltAt
        rt.updateBySessionId?.(bot.id, newSessionId, prevSessionId)
        throw saveErr
      }

      migrated.push({ botId: bot.id, imported: importResult.imported, warnings: importResult.warnings })
    } catch (err) {
      const msg = err?.message ?? String(err)
      failed.push(bot.id)
      errors.push({ botId: bot.id, error: msg })
      rt.warn?.('ds-bot: migrateLegacyJoined %s failed: %s', bot.id, msg)
    }
  }

  if (dryRun) return { wouldRebuild, skipped, failed, errors }
  return { migrated, skipped, failed, errors }
}

export function install(rt) {
  const ctx = rt.ctx
  let _migrated = false
  const onRoster = (report) => {
    applyRosterReport(rt.state, report)
    void rt.save?.()
    if (!_migrated) {
      _migrated = true
      setTimeout(() => void migrateLegacyJoined(rt).catch(err => rt.warn?.('ds-bot: auto-migrate failed: %s', err?.message ?? err)), 0)
    }
  }
  const onOffline = ({ nodeId } = {}) => {
    if (typeof nodeId !== 'string' || nodeId === '') return
    markNodeOffline(rt.state, nodeId)
    void rt.save?.()
  }
  const attach = () => {
    let registry
    try { registry = ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
    if (!registry || typeof registry.on !== 'function' || registry.__rosterJoin === true) return
    registry.__rosterJoin = true
    registry.on('roster', onRoster)
    registry.on('nodeOffline', onOffline)
  }
  const publish = () => {
    let report
    try { report = ctx?.get?.('remote-agent:roster-report') } catch { report = undefined }
    if (typeof report !== 'function') return
    report({ bots: reportableBots(rt.state?.bots) })
  }
  attach()
  publish()
  const timer = setInterval(() => { attach(); publish() }, 5_000)
  timer.unref?.()
}
