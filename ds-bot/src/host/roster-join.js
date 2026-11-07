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

export function install(rt) {
  const ctx = rt.ctx
  const onRoster = (report) => {
    applyRosterReport(rt.state, report)
    void rt.save?.()
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
