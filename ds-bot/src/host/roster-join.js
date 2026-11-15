// Step 1: a remote DS-Bot roster becomes shadow rows in the controller sidebar.
// No turn is started here, and no local session is created.
import { ensureMainThread } from './bot-store.js'
import { mirrorTurnOpen } from './joined-mirror-writer.js'
import { hasHistoryIdentity, syncJoinedHistory } from './joined-history.js'

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
    const entry = {
      id,
      name: typeof bot.name === 'string' ? bot.name : '',
      role: typeof bot.role === 'string' ? bot.role : '',
    }
    // Omit rather than send null/empty/over-long: the hub must not clear a known model.
    const model = typeof bot.model === 'string' ? bot.model.trim() : ''
    if (model !== '' && model.length <= 128) entry.model = model
    return [entry]
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
  const seenIds = new Set()
  for (const bot of bots) {
    if (!bot || typeof bot !== 'object' || bot.type === 'remote-worker') continue
    const remoteBotId = typeof bot.id === 'string' ? bot.id.trim() : ''
    if (remoteBotId === '') continue
    const id = shadowId(nodeId, remoteBotId)
    if (Array.isArray(state.deletedJoinedIds) && state.deletedJoinedIds.includes(id)) continue
    seenIds.add(id)
    const existing = state.bots[id]
    const reportedModel = typeof bot.model === 'string' ? bot.model.trim() : ''
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
        // Seen in this report: the missing flag must not stick from an earlier absence.
        missingFromReport: false,
      },
    }
    // No model in this report keeps existing?.model. Do not write null or ''.
    if (reportedModel !== '') row.model = reportedModel
    state.bots[id] = row
    // A shadow row without a Main Thread would route its messages to nowhere.
    ensureMainThread(state, row)
    seen.push(row)
  }
  // Mark joined bots from this node that are no longer in the report as missing.
  // They are NOT auto-deleted (the host-side tombstone is the authoritative delete action);
  // the missing flag lets the UI surface a warning so the user can delete explicitly.
  for (const bot of Object.values(state.bots)) {
    if (bot?.origin !== 'joined' || bot?.worker?.nodeId !== nodeId || bot?.worker?.home !== 'remote') continue
    if (seenIds.has(bot.id)) continue
    if (!bot.worker) bot.worker = {}
    bot.worker.missingFromReport = true
    bot.worker.lastSeen = bot.worker.lastSeen ?? now
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
 * Restore joined history. Identified node parts append to the existing mirror;
 * durable Session markers, rather than the legacy scalar watermark, deduplicate.
 * Automatic calls defer ambiguous legacy/live mirrors. Explicit legacy calls keep
 * the old rebuild path for callers that deliberately request that migration.
 * dryRun reports planned writes; botIds limits the pass to scheduled Bots.
 */
const migrations = new WeakMap()

export function migrateLegacyJoined(rt, opts = {}) {
  const previous = migrations.get(rt) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(() => migrateJoined(rt, opts))
  migrations.set(rt, pending)
  return pending.finally(() => { if (migrations.get(rt) === pending) migrations.delete(rt) })
}

async function migrateJoined(rt, opts) {
  const { dryRun = false } = opts
  const { importHistory } = await import('./mirror.js')
  // Use rt.joinedChatPage if available (testability), else import from module
  // Normalise to uniform (botId, cursor) call convention
  const joinedChatPage = typeof rt.joinedChatPage === 'function'
    ? (botId, cursor) => rt.joinedChatPage(botId, cursor)
    : async (botId, cursor) => (await import('./joined-page.js')).joinedChatPage(rt, botId, cursor)
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const bots = Object.values(rt?.state?.bots ?? {}).filter(b => b?.origin === 'joined' && (!opts.botIds || opts.botIds.includes(b.id)))
  const migrated = []
  const skipped = []
  const failed = []
  const errors = []
  const wouldRebuild = []
  const deferred = []

  // Snapshot state before any writes
  if (!dryRun && !opts.automatic && bots.length > 0) {
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

  for (let bot of bots) {
    try {
      const initialSessionId = bot.sessionId
      const originalSession = initialSessionId ? (await rt.resolveAgent(initialSessionId).catch(() => undefined))?.session : undefined
      const initialSeq = originalSession?.seq
      const initialLength = originalSession?.log?.length
      const unchanged = () => {
        const current = rt.botOf?.(bot.id) ?? rt.state.bots[bot.id]
        return current && current.sessionId === initialSessionId
          && originalSession?.seq === initialSeq && originalSession?.log?.length === initialLength
          && !rt.joinedInFlight?.has(bot.id) && !mirrorTurnOpen(rt, bot.id)
          && opts.isActive?.() !== false
      }
      // Fetch all history from node, paginating to cursor=null
      const allItems = []
      const pages = []
      let cursor = undefined
      let offlineDetected = false
      const cursors = new Set()
      let sourceSessionId

      do {
        const page = await joinedChatPage(bot.id, cursor)
        if (!page || !Array.isArray(page.items)) throw new Error('invalid history page')
        if (sourceSessionId && page.sessionId && sourceSessionId !== page.sessionId) throw new Error('node current part changed during history pagination')
        sourceSessionId ??= page.sessionId
        const items = page.items
        // Detect offline/error items (only 1 item with kind:'bot' and no seq)
        if (items.length === 1 && items[0].kind === 'bot' && typeof items[0].seq !== 'number') {
          offlineDetected = true
          break
        }
        allItems.push(...items)
        pages.push(items)
        // ?? null ensures undefined cursor stops the loop (undefined != null is true without this)
        cursor = page.cursor ?? null
        if (cursor !== null) {
          const key = JSON.stringify(cursor)
          if (cursors.has(key)) throw new Error('repeated history cursor')
          cursors.add(key)
        }
      } while (cursor != null)

      if (!unchanged()) { skipped.push(bot.id); continue }

      if (offlineDetected) {
        const msg = 'node offline or history unavailable'
        failed.push(bot.id)
        errors.push({ botId: bot.id, error: msg })
        rt.warn?.('ds-bot: migrateLegacyJoined %s failed: %s', bot.id, msg)
        continue
      }

      // Group items by turn into {userText, botText, turn, seq} pairs
      // Pages arrive newest first, but each page's text blocks are chronological.
      const orderedItems = pages.reverse().flat()
      if (hasHistoryIdentity(orderedItems)) {
        const result = await syncJoinedHistory(rt, bot, orderedItems, originalSession, unchanged, opts)
        if (result.deferred) deferred.push({ botId: bot.id, reason: result.deferred })
        else if (result.migrated) migrated.push(result.migrated)
        else if (result.wouldRebuild) wouldRebuild.push(result.wouldRebuild)
        else skipped.push(bot.id)
        continue
      }
      // Old peers have no durable part identity. Their existing mirrors must never
      // be replaced by a delayed automatic rebuild.
      if (opts.automatic && (initialSessionId || orderedItems.length > 0)) {
        deferred.push({ botId: bot.id, reason: 'legacy mirror requires remote part identity' })
        continue
      }
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

      if (importResult.imported + importResult.skipped !== groups.length) throw new Error('history import incomplete: ' + importResult.warnings.join('; '))
      await rt.ctx?.sessions?.flush?.(session)

      // Creation and import also await: a live page or a roster report may have
      // moved on meanwhile. Never replace that conversation with this snapshot.
      if (!unchanged()) { skipped.push(bot.id); continue }
      bot = rt.botOf?.(bot.id) ?? rt.state.bots[bot.id]
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

  if (dryRun) return { wouldRebuild, skipped, failed, errors, deferred }
  return { migrated, skipped, failed, errors, deferred }
}

export function install(rt) {
  const ctx = rt.ctx
  let stopped = false
  let attached
  let migrateTimer
  let migrating = false
  const pending = new Set()
  const settled = new Set()
  const schedule = (delay = 0) => {
    if (stopped || migrating || migrateTimer !== undefined || pending.size === 0) return
    migrateTimer = setTimeout(() => {
      migrateTimer = undefined
      if (stopped) return
      const botIds = [...pending]
      pending.clear()
      migrating = true
      void migrateLegacyJoined(rt, { botIds, automatic: true, isActive: () => !stopped }).then(result => {
        for (const id of botIds) settled.add(id)
        for (const id of result.failed) pending.add(id)
        for (const item of result.deferred) {
          rt.warn?.('ds-bot: history migration deferred for %s: %s', item.botId, item.reason)
          if (item.reason === 'node history contains incomplete or unclosed turns') pending.add(item.botId)
        }
        for (const id of result.skipped) if (!rt.botOf?.(id)?.sessionId) pending.add(id)
      }).catch(error => {
        for (const id of botIds) pending.add(id)
        rt.warn?.('ds-bot: auto-migrate failed: %s', error?.message ?? error)
      }).finally(() => { migrating = false; schedule(5_000) })
    }, delay)
    migrateTimer.unref?.()
  }
  const onRoster = (report) => {
    if (stopped) return
    applyRosterReport(rt.state, report)
    void rt.save?.()
    for (const bot of Object.values(rt.state.bots ?? {})) {
      if (bot?.origin === 'joined' && (!settled.has(bot.id) || bot.mirrorHistory)) pending.add(bot.id)
    }
    schedule()
  }
  const onOffline = ({ nodeId } = {}) => {
    if (typeof nodeId !== 'string' || nodeId === '') return
    markNodeOffline(rt.state, nodeId)
    void rt.save?.()
  }
  const attach = () => {
    let registry
    try { registry = ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
    if (registry === attached) return
    attached?.off?.('roster', onRoster)
    attached?.off?.('nodeOffline', onOffline)
    attached = undefined
    if (!registry || typeof registry.on !== 'function') return
    attached = registry
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
  ctx?.effect?.(() => () => {
    stopped = true
    clearInterval(timer)
    clearTimeout(migrateTimer)
    attached?.off?.('roster', onRoster)
    attached?.off?.('nodeOffline', onOffline)
    attached = undefined
  }, 'ds-bot: joined roster')
}
