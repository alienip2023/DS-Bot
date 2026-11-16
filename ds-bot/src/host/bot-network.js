// The hub publishes destinations; nodes keep the directory in remote-agent memory.
const DIRECTORY_DELAY_MS = 1_000
const REFRESH_MS = 60_000
const asks = new WeakMap()

function serviceOf(rt, name) {
  try { return rt.ctx?.get?.(name) } catch { return undefined }
}

export function directoryOf(rt) {
  return Object.values(rt.state.bots ?? {}).filter(bot => bot && bot.origin !== 'peer' && bot.private !== true).map(bot => ({
    id: bot.id,
    name: bot.name || bot.id,
    role: bot.role ?? '',
    nodeId: bot.origin === 'joined' ? bot.worker?.nodeId ?? null : null,
  }))
}

export async function publishDirectory(rt) {
  const registry = serviceOf(rt, 'remote-agent:registry')
  if (typeof registry?.send !== 'function' || typeof registry.onlineNodes !== 'function') return
  await rt.load?.()
  const payload = { bots: directoryOf(rt), at: Date.now() }
  for (const { nodeId } of registry.onlineNodes()) {
    try { registry.send(nodeId, 'bot/directory', payload) } catch (error) {
      rt.warn?.('ds-bot: Bot directory send to %s failed: %s', nodeId, error)
    }
  }
}

function pruneAsks(rt) {
  const seen = asks.get(rt)
  if (!seen) return
  const now = Date.now()
  for (const [id, at] of seen) if (now - at >= REFRESH_MS) seen.delete(id)
}

export async function handleNodeMessage(rt, payload) {
  if (!payload || !['ask', 'reply'].includes(payload.kind) || payload.depth >= 3) return
  await rt.load?.()
  const to = Object.hasOwn(rt.state.bots, payload.to?.id) ? rt.state.bots[payload.to.id] : undefined
  if (!to || to.origin === 'peer' || to.private === true) {
    rt.warn?.('ds-bot: Bot network destination unavailable: %s', payload.to?.id)
    return
  }
  if (payload.kind === 'ask') {
    pruneAsks(rt)
    let seen = asks.get(rt)
    if (!seen) { seen = new Map(); asks.set(rt, seen) }
    if (seen.has(payload.exchangeId)) return
    seen.set(payload.exchangeId, Date.now())
  }
  const message = {
    fromId: payload.from.id, toId: to.id, text: payload.text,
    role: 'default', exchangeId: payload.exchangeId,
  }
  if (to.origin === 'joined') return rt.handleJoinedTurn({
    ...message, senderName: payload.from.name, senderBotId: payload.from.id, defer: true,
  })
  return rt.deliver({ ...message, fromName: payload.from.name })
}

export function install(rt) {
  const { ctx } = rt
  let stopped = false
  let attached
  let dirtyTimer
  let lastDirectory = JSON.stringify(directoryOf(rt))
  const publish = () => {
    if (stopped) return
    void publishDirectory(rt).catch(error => rt.warn?.('ds-bot: Bot directory publish failed: %s', error))
  }
  const dirty = () => {
    if (stopped || dirtyTimer !== undefined) return
    dirtyTimer = setTimeout(() => { dirtyTimer = undefined; publish() }, DIRECTORY_DELAY_MS)
    dirtyTimer.unref?.()
  }
  const detach = () => {
    attached?.off?.('nodeOnline', publish)
    attached?.off?.('roster', dirty)
  }
  const attach = () => {
    const registry = serviceOf(rt, 'remote-agent:registry')
    if (registry === attached) return
    detach()
    attached = registry
    attached?.on?.('nodeOnline', publish)
    attached?.on?.('roster', dirty)
  }
  const offSaved = rt.onSaved?.(() => {
    const next = JSON.stringify(directoryOf(rt))
    if (next === lastDirectory) return
    lastDirectory = next
    dirty()
  })
  const receive = payload => stopped ? undefined : handleNodeMessage(rt, payload)
  const previous = serviceOf(rt, 'remote-agent:bot-message')
  let offReceiver
  if (previous === undefined) offReceiver = ctx?.provide?.('remote-agent:bot-message', receive)
  else if (typeof ctx?.set === 'function') ctx.set('remote-agent:bot-message', receive)

  rt.botNetwork = serviceOf(rt, 'remote-agent:bot-network')
  const offMessage = typeof rt.botNetwork?.onMessage === 'function'
    ? rt.botNetwork.onMessage(async payload => {
    if (stopped || payload.kind !== 'ask') return null
    await rt.load?.()
    const bot = Object.hasOwn(rt.state.bots, payload.to?.id) ? rt.state.bots[payload.to.id] : undefined
    if (!bot || bot.origin === 'joined' || bot.origin === 'peer' || bot.private === true) {
      rt.warn?.('ds-bot: Bot network local destination unavailable: %s', payload.to?.id)
      return null
    }
    await rt.sendUser({
      sessionId: rt.chatOf(bot.id),
      content: [{ type: 'text', text: `[来自 ${payload.from.name}] ${payload.text}` }],
      requestId: payload.exchangeId,
    })
    return null
  })
    : undefined
  attach()
  publish()
  const timer = setInterval(() => { attach(); pruneAsks(rt); publish() }, REFRESH_MS)
  timer.unref?.()
  ctx?.effect?.(() => () => {
    stopped = true
    clearTimeout(dirtyTimer)
    clearInterval(timer)
    detach()
    offSaved?.()
    offMessage?.()
    offReceiver?.()
    if (previous !== undefined && typeof ctx.set === 'function' && serviceOf(rt, 'remote-agent:bot-message') === receive) ctx.set('remote-agent:bot-message', previous)
    asks.delete(rt)
    rt.botNetwork = undefined
  }, 'ds-bot: Bot network')
}
