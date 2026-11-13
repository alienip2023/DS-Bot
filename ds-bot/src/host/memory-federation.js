// Memory federation, the hub side: the one place that answers a node's reads and
// writes of the files under `<home>/memory/nodes/<node>/`, and the one writer of the
// change log there. It keeps the global `seq` a node compares its snapshot against,
// remembers the result of each request so a retried frame is not written twice, and
// pushes the whole rendered memory to a node whose view went stale.
//
// The files themselves are changed by memory.js, on its single `queued` writer: this
// module never opens a file, never keeps a second write queue, and never calls the
// file system. `rt.memoryHost` is the only door.
import { MEMORY_LIMITS, bodySize, cleanTopic, entryId, fitSnapshot, isExpired, isPinned } from './memory-entries.js'
import { joinedShadow, shadowId } from './roster-join.js'

const CAP = 'memory-sync/1'
const DEBOUNCE_MS = 500
const ATTACH_MS = 5_000
const INBOX_MAX = 1_000
const INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_READ = 30
const MAX_READ = 50
const MAX_SNAPSHOT_BOTS = 64
const USER = { id: 'user', name: 'user' }

const CODES = {
  teamReadOnly: 'memory/team-read-only',
  readOnly: 'memory/read-only',
  notOnRoster: 'memory/not-on-roster',
  tooLarge: 'memory/too-large',
  refused: 'memory/refused',
  denied: 'memory/denied',
  noMatch: 'memory/no-match',
  ambiguous: 'memory/ambiguous',
  failed: 'memory/failed',
}

const text = value => (typeof value === 'string' ? value.trim() : '')

export function install(rt) {
  const { ctx } = rt

  if (rt.memoryEnabled === false || rt.memoryHost === undefined || rt.config?.memory === false) {
    // Memory is off on this host: the endpoint says so the same way memory.js does.
    Object.assign(rt, {
      memoryHubEndpoint: async () => { throw new Error('Memory is turned off on this host') },
      memoryHub: Object.freeze({ enabled: false }),
    })
    return
  }

  const host = rt.memoryHost
  const dirty = new Set()
  const attached = new Map()
  let timer
  const inflight = new Map()
  let ticker
  let stopped = false

  const warn = (message, ...args) => {
    try { rt.warn(`ds-bot: ${message}`, ...args) } catch { /* a warn never stops a frame */ }
  }
  const warnf = (error, what) => warn(`memory federation: ${what}: %s`, error?.message ?? error)

  // The state object keeps its identity across an adopt, but its fields are replaced:
  // read `state.memoryFederation` every time instead of holding the object.
  function federation() {
    const state = rt.state
    let fed = state.memoryFederation
    if (fed === null || typeof fed !== 'object' || Array.isArray(fed)) fed = state.memoryFederation = {}
    if (!Number.isInteger(fed.seq) || fed.seq < 0) fed.seq = 0
    if (fed.schemaVersion !== 1) fed.schemaVersion = 1
    if (fed.nodes === null || typeof fed.nodes !== 'object' || Array.isArray(fed.nodes)) fed.nodes = {}
    if (fed.inbox === null || typeof fed.inbox !== 'object' || Array.isArray(fed.inbox)) fed.inbox = {}
    return fed
  }
  const seq = () => federation().seq

  function nodeRecord(nodeId) {
    const fed = federation()
    let record = fed.nodes[nodeId]
    if (record === null || typeof record !== 'object' || Array.isArray(record)) record = fed.nodes[nodeId] = {}
    if (!Number.isInteger(record.lastSeq) || record.lastSeq < 0) record.lastSeq = 0
    if (!Number.isInteger(record.sentSeq) || record.sentSeq < 0) record.sentSeq = 0
    return record
  }

  function registryOf() {
    try { return rt.ctx?.get?.('remote-agent:registry') } catch { return undefined }
  }
  function capsOf(registry, nodeId) {
    const node = registry?.getNode?.(nodeId)
    const caps = node?.hello?.caps ?? node?.caps
    return Array.isArray(caps) ? caps : []
  }
  const speaksMemory = (registry, nodeId) => capsOf(registry, nodeId).includes(CAP)
  const hostnameOf = nodeId => {
    const node = registryOf()?.getNode?.(nodeId)
    return node?.hello?.hostname ?? node?.hostname ?? federation().nodes[nodeId]?.hostname ?? nodeId
  }

  // The remote Bots this host knows on one node: the joined rows of its latest roster.
  function botsOn(nodeId) {
    const bots = Object.values(rt.state.bots ?? {})
    return bots.filter((bot) => {
      if (!joinedShadow(bot) || bot.worker.nodeId !== nodeId) return false
      return !rt.isPrivate?.(bot.id)
    })
  }
  const memoryNodes = (registry) => {
    const nodes = registry?.onlineNodes?.() ?? []
    return nodes.filter(node => speaksMemory(registry, node?.nodeId)).map(node => node.nodeId).filter(id => typeof id === 'string' && id !== '')
  }
  const allMemoryNodeIds = () => {
    const registry = registryOf()
    const online = memoryNodes(registry)
    const known = Object.keys(federation().nodes)
    return [...new Set([...online, ...known.filter(nodeId => speaksMemory(registry, nodeId))])]
  }

  function shadowFor(nodeId, remoteBotId) {
    if (nodeId === '' || remoteBotId === '') return undefined
    const bot = rt.botOf(shadowId(nodeId, remoteBotId))
    if (!joinedShadow(bot) || bot.worker.nodeId !== nodeId) return undefined
    if (rt.isPrivate?.(bot.id)) return undefined
    return bot
  }

  // One rendered scope: the entries as the prompt section lists them, topics named.
  function renderScope(files) {
    const lines = []
    for (const file of files) {
      if (file.entries.length === 0) continue
      if (file.topic !== undefined) lines.push(`## [[${file.topic}]]`)
      for (const entry of file.entries) lines.push(`- ${entry.text}`)
    }
    return lines.join('\n')
  }

  // The whole memory one node's Bots may see, rendered, then cut to the snapshot
  // budget team -> node -> bot. `truncated` is set on the section that was cut, and
  // is also reported on the frame.
  async function buildSnapshot(nodeId) {
    const team = renderScope(await host.readScope({ kind: 'team' }))
    const node = renderScope(await host.readScope({ kind: 'node', nodeId }))
    const bots = []
    for (const bot of botsOn(nodeId).slice(0, MAX_SNAPSHOT_BOTS)) {
      const remoteBotId = bot.worker.remoteBotId
      if (typeof remoteBotId !== 'string' || remoteBotId === '') continue
      const body = renderScope(await host.readScope({ kind: 'bot', nodeId, botId: remoteBotId }))
      if (body === '') continue
      bots.push({ remoteBotId, text: body })
    }
    const fitted = fitSnapshot([
      { kind: 'team', text: team },
      { kind: 'node', text: node },
      ...bots.map(bot => ({ kind: 'bot', botId: bot.remoteBotId, text: bot.text })),
    ])
    const section = kind => fitted.sections.find(item => item.kind === kind)
    const out = {
      seq: seq(),
      team: section('team')?.text ?? '',
      node: section('node')?.text ?? '',
      bots: {},
    }
    for (const item of fitted.sections) {
      if (item.kind !== 'bot') continue
      out.bots[item.botId] = { text: item.text, ...(item.truncated === true ? { truncated: true } : {}) }
    }
    if (fitted.truncated === true) {
      out.truncated = true
      out.truncatedAt = Date.now()
    }
    return out
  }

  function sendFrame(nodeId, type, payload) {
    const registry = registryOf()
    if (registry === undefined || typeof registry.send !== 'function') return false
    try {
      return registry.send(nodeId, type, payload) === true
    } catch (error) {
      warnf(error, `sending ${type} to ${nodeId}`)
      return false
    }
  }

  async function push(nodeId) {
    if (stopped) return false
    const registry = registryOf()
    if (registry === undefined || !speaksMemory(registry, nodeId)) return false
    const payload = await buildSnapshot(nodeId)
    if (stopped || sendFrame(nodeId, 'mem/snapshot', payload) !== true) return false
    nodeRecord(nodeId).sentSeq = payload.seq
    nodeRecord(nodeId).hostname = hostnameOf(nodeId)
    return true
  }

  // One timer for every node touched in the window: a team change marks all of them,
  // and each still gets one whole snapshot.
  function markDirty(nodeId) {
    if (nodeId === '*') for (const id of allMemoryNodeIds()) dirty.add(id)
    else if (typeof nodeId === 'string' && nodeId !== '') dirty.add(nodeId)
    if (dirty.size === 0 || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, DEBOUNCE_MS)
    timer.unref?.()
  }

  async function flush() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const nodes = [...dirty]
    dirty.clear()
    for (const nodeId of nodes) {
      try { await push(nodeId) } catch (error) { warnf(error, `pushing the snapshot to ${nodeId}`) }
    }
  }

  // A request that is retried after the hub already wrote it replays the first
  // answer, seq included, so the node sees one write and one sequence step.
  function replayed(key) {
    const fed = federation()
    const entry = fed.inbox[key]
    if (entry === null || typeof entry !== 'object') return undefined
    if (!Number.isFinite(entry.at) || entry.at < Date.now() - INBOX_TTL_MS) return undefined
    return entry.frame
  }

  // Seven days or a thousand answers, whichever comes first. Runs when an inbox is
  // written and once at start: a stale answer is worse than none, because it can
  // hide a write the node thinks it still has to retry.
  function cleanInbox() {
    const fed = federation()
    const cutoff = Date.now() - INBOX_TTL_MS
    let removed = 0
    for (const name of Object.keys(fed.inbox)) {
      const entry = fed.inbox[name]
      if (entry === null || typeof entry !== 'object' || !Number.isFinite(entry.at) || entry.at < cutoff) {
        delete fed.inbox[name]
        removed += 1
      }
    }
    const left = Object.keys(fed.inbox)
    if (left.length <= INBOX_MAX) return removed
    left.sort((a, b) => (fed.inbox[a].at ?? 0) - (fed.inbox[b].at ?? 0))
    for (const name of left.slice(0, left.length - INBOX_MAX)) {
      delete fed.inbox[name]
      removed += 1
    }
    return removed
  }

  function touch(nodeId) {
    if (nodeId === '') return
    const record = nodeRecord(nodeId)
    record.lastSeen = Date.now()
    record.hostname = hostnameOf(nodeId)
  }

  function errorCode(error) {
    const code = typeof error?.code === 'string' ? error.code : ''
    const message = String(error?.message ?? '')
    if (/at most \d+ characters/.test(message)) return CODES.tooLarge
    if (/matches \d+ entries/.test(message)) return CODES.ambiguous
    if (code === 'memory/no-match') return CODES.noMatch
    if (code === 'memory/denied') return CODES.denied
    if (code === 'memory/bot-gone') return CODES.notOnRoster
    if (code === 'memory/too-large') return CODES.tooLarge
    if (code.startsWith('memory/')) return code
    return CODES.failed
  }

  function writeScope(message, nodeId, bot) {
    const name = text(message?.scope)
    if (name === 'node') return { kind: 'node', nodeId }
    if (name === 'own' || name === 'bot') return { kind: 'bot', nodeId, botId: bot.worker.remoteBotId }
    return undefined
  }

  async function writeFrame(message) {
    const nodeId = text(message?.nodeId)
    const bot = shadowFor(nodeId, text(message?.remoteBotId))
    if (bot === undefined) return { ok: false, seq: seq(), error: CODES.notOnRoster }
    if (rt.readOnly() !== undefined) return { ok: false, seq: seq(), error: CODES.readOnly }
    const name = text(message?.scope)
    // The node's own tool route refused a team write before it sent anything; the hub
    // refuses it again here, before a file or the sequence is touched.
    if (name === 'team') return { ok: false, seq: seq(), error: CODES.teamReadOnly }
    const scope = writeScope(message, nodeId, bot)
    if (scope === undefined) return { ok: false, seq: seq(), error: CODES.denied }
    const op = text(message?.op)
    if (op !== 'add' && op !== 'replace' && op !== 'forget') return { ok: false, seq: seq(), error: CODES.denied }
    const value = typeof message?.text === 'string' ? message.text : ''
    const target = typeof message?.replace === 'string' ? message.replace : ''
    if (op !== 'forget') {
      const problem = host.entryProblem(value)
      if (problem !== undefined) return { ok: false, seq: seq(), error: /at most \d+ characters/.test(problem) ? CODES.tooLarge : CODES.refused }
    }
    if (op === 'forget' && target === '') return { ok: false, seq: seq(), error: CODES.noMatch }
    const actor = { id: bot.id, name: bot.name }
    const label = scope.kind === 'node' ? 'the node memory' : 'its own memory'
    const meta = { source: 'memory federation', by: bot.id, added: today() }
    try {
      const result = op === 'add'
        ? await host.addEntry({ scope, topic: message?.topic, text: value, meta, actor, label })
        : op === 'replace'
          ? await host.replaceEntry({ scope, topic: message?.topic, match: target, text: value, meta, actor, label })
          : await host.removeEntry({ scope, topic: message?.topic, match: target, actor, label })
      if (result?.changed === true) federation().seq += 1
      return { ok: true, seq: seq(), changed: result?.changed === true }
    } catch (error) {
      return { ok: false, seq: seq(), error: errorCode(error) }
    }
  }

  async function readFrame(message) {
    const nodeId = text(message?.nodeId)
    const bot = shadowFor(nodeId, text(message?.remoteBotId))
    if (bot === undefined) return { ok: false, seq: seq(), error: CODES.notOnRoster }
    const name = text(message?.scope)
    const scope = name === 'team' ? { kind: 'team' }
      : name === 'node' ? { kind: 'node', nodeId }
        : name === 'own' || name === 'bot' ? { kind: 'bot', nodeId, botId: bot.worker.remoteBotId }
          : undefined
    if (scope === undefined) return { ok: false, seq: seq(), error: CODES.denied }
    const limit = Math.max(1, Math.min(MAX_READ, Number.isInteger(message?.limit) ? message.limit : DEFAULT_READ))
    const files = await host.readScope(scope)
    let entries = files.flatMap(file => file.entries.map(entry => ({ entry, topic: file.topic })))
    if (typeof message?.topic === 'string' && message.topic !== '') entries = entries.filter(item => item.topic === message.topic)
    if (typeof message?.query === 'string' && message.query.trim() !== '') {
      const query = message.query.trim().toLowerCase()
      entries = entries.filter(item => item.entry.text.toLowerCase().includes(query))
    }
    const result = {
      ok: true,
      seq: seq(),
      entries: entries.slice(0, limit).map(item => ({
        id: entryId(item.entry),
        text: item.entry.text,
        ...(item.topic === undefined ? {} : { topic: item.topic }),
      })),
    }
    if (typeof message?.topic === 'string' && message.topic !== '') result.topic = message.topic
    return result
  }

  function onHello(message) {
    const nodeId = text(message?.nodeId)
    if (nodeId === '') return
    const record = nodeRecord(nodeId)
    if (Number.isInteger(message?.appliedSeq) && message.appliedSeq >= 0) record.lastSeq = message.appliedSeq
    touch(nodeId)
    cleanInbox()
    void rt.save()
    void push(nodeId).catch(error => warnf(error, `pushing the first snapshot to ${nodeId}`))
  }

  function onAck(message) {
    const nodeId = text(message?.nodeId)
    if (nodeId === '') return
    const acked = Number.isInteger(message?.seq) && message.seq >= 0 ? message.seq : undefined
    if (acked === undefined) return
    const record = nodeRecord(nodeId)
    // A node cannot have applied a sequence the hub has not reached yet.
    record.lastSeq = Math.min(acked, seq())
    touch(nodeId)
    void rt.save()
  }

  async function onWrite(message) {
    const nodeId = text(message?.nodeId)
    const requestId = text(message?.requestId)
    if (nodeId === '' || requestId === '') return
    const key = `${nodeId}:${requestId}`
    const prior = replayed(key)
    if (prior !== undefined) {
      sendFrame(nodeId, 'mem/write-result', { ...prior, requestId })
      return
    }
    // A retry that arrives while the first copy is still running waits for it and
    // gets its answer: two copies of one request never reach the writer at once.
    const running = inflight.get(key)
    if (running !== undefined) {
      const frame = await running
      sendFrame(nodeId, 'mem/write-result', { ...frame, requestId })
      return
    }
    const job = (async () => {
      const frame = { requestId, ...(await writeFrame(message)) }
      if (frame.ok === true) {
        federation().inbox[key] = { at: Date.now(), frame }
        cleanInbox()
        markDirty(text(message?.scope) === 'team' ? '*' : nodeId)
        void rt.save()
      }
      return frame
    })()
    inflight.set(key, job)
    try {
      sendFrame(nodeId, 'mem/write-result', await job)
    } finally {
      inflight.delete(key)
    }
  }

  async function onRead(message) {
    const nodeId = text(message?.nodeId)
    const requestId = text(message?.requestId)
    if (nodeId === '' || requestId === '') return
    touch(nodeId)
    const frame = { requestId, ...(await readFrame(message)) }
    sendFrame(nodeId, 'mem/read-result', frame)
  }

  // Every frame is handled alone: a failure is logged and never breaks the listener
  // line. The returned promise lets a test wait for the frame it emitted.
  const guarded = (name, run) => (message) => Promise.resolve()
    .then(() => run(message))
    .catch(error => warnf(error, `handling ${name}`))

  function attach() {
    if (stopped) return
    const registry = registryOf()
    if (registry === undefined || typeof registry.on !== 'function' || attached.has(registry)) return
    const pairs = [
      ['memoryHello', guarded('memoryHello', onHello)],
      ['memoryRead', guarded('memoryRead', onRead)],
      ['memoryWrite', guarded('memoryWrite', onWrite)],
      ['memoryAck', guarded('memoryAck', onAck)],
    ]
    for (const [name, handler] of pairs) registry.on(name, handler)
    attached.set(registry, pairs)
    // Nodes connected before this host was ready still get what they missed.
    for (const nodeId of memoryNodes(registry)) void push(nodeId).catch(error => warnf(error, `catching up ${nodeId}`))
  }

  const detach = () => {
    for (const [registry, pairs] of attached) {
      for (const [name, handler] of pairs) {
        try { registry.off?.(name, handler) } catch { /* the registry may already be gone */ }
      }
    }
    attached.clear()
  }

  // ---------------------------------------------------------------------------
  // The hub's own endpoints, for the memory panel: the same scopes, through the same
  // write path, with the user as the actor. The panel is the only writer of team
  // entries on this side (a node never writes the team memory).

  const today = () => {
    try {
      const format = new Intl.DateTimeFormat('en-CA', { ...(rt.config?.timeZone ? { timeZone: rt.config.timeZone } : {}), year: 'numeric', month: '2-digit', day: '2-digit' })
      return format.format(new Date())
    } catch { return new Date().toISOString().slice(0, 10) }
  }

  function panelScope(raw) {
    if (raw === 'team' || raw?.kind === 'team') return { kind: 'team' }
    if (raw === null || typeof raw !== 'object') return undefined
    if (raw.kind === 'node') return typeof raw.nodeId === 'string' && raw.nodeId !== '' ? { kind: 'node', nodeId: raw.nodeId } : undefined
    if (raw.kind === 'bot') {
      const remoteBotId = typeof raw.remoteBotId === 'string' && raw.remoteBotId !== '' ? raw.remoteBotId : typeof raw.botId === 'string' ? raw.botId : ''
      return typeof raw.nodeId === 'string' && raw.nodeId !== '' && remoteBotId !== '' ? { kind: 'bot', nodeId: raw.nodeId, botId: remoteBotId } : undefined
    }
    return undefined
  }
  function panelLabel(scope) {
    if (scope.kind === 'team') return 'the team memory'
    if (scope.kind === 'node') return `the memory of node ${scope.nodeId}`
    return `the memory of ${scope.botId} on ${scope.nodeId}`
  }

  async function view(body) {
    const scope = panelScope(body?.scope)
    if (scope === undefined) throw new Error('Unknown memory scope')
    const files = await host.readScope(scope)
    // The same tag and entry shape memoryView uses, so the panel reads one list format:
    // a remote scope has no summary and no model call behind it.
    const tag = scope.kind === 'team' ? 'team' : scope.kind === 'node' ? 'node' : 'own'
    const day = today()
    const entries = files.flatMap(file => file.entries.map(entry => ({
      scope: tag,
      topic: file.topic ?? null,
      text: entry.text,
      id: entryId(entry),
      added: entry.meta.added ?? null,
      by: entry.meta.by ?? null,
      source: entry.meta.source ?? null,
      until: entry.meta.until ?? null,
      pinned: isPinned(entry),
      expired: isExpired(entry, day),
    })))
    return {
      scope: host.logKeyOf(scope) ?? 'team',
      kind: scope.kind,
      ...(scope.nodeId === undefined ? {} : { nodeId: scope.nodeId }),
      ...(scope.kind === 'bot' ? { remoteBotId: scope.botId } : {}),
      entries,
      sizes: { [tag]: bodySize(files[0] ?? { entries: [] }) },
      limits: { ...MEMORY_LIMITS, [tag]: host.mainLimit(scope) },
      keys: { [tag]: host.logKeyOf(scope) ?? 'team' },
      summary: null,
      fresh: entries.length === 0,
      summarizing: false,
      error: null,
    }
  }

  async function afterPanelChange(scope) {
    federation().seq += 1
    await rt.save()
    markDirty(scope.kind === 'team' ? '*' : scope.nodeId)
  }

  async function add(body) {
    const scope = panelScope(body?.scope)
    if (scope === undefined) throw new Error('Unknown memory scope')
    const value = typeof body?.text === 'string' ? body.text : ''
    const problem = host.entryProblem(value)
    if (problem !== undefined) throw Object.assign(new Error(problem), { code: /at most \d+ characters/.test(problem) ? CODES.tooLarge : CODES.refused })
    const topic = body?.topic === null || body?.topic === undefined || body?.topic === '' ? undefined : cleanTopic(body.topic)
    const result = await host.addEntry({ scope, topic, text: value, meta: { source: 'memory hub', by: 'user', added: today() }, actor: USER, label: panelLabel(scope) })
    if (result?.changed === true) await afterPanelChange(scope)
    return await view({ scope })
  }

  async function forget(body) {
    const scope = panelScope(body?.scope)
    if (scope === undefined) throw new Error('Unknown memory scope')
    const topic = body?.topic === null || body?.topic === undefined || body?.topic === '' ? undefined : cleanTopic(body.topic)
    const result = await host.removeEntry({ scope, topic, match: String(body?.text ?? ''), actor: USER, label: panelLabel(scope) })
    if (result?.changed === true) await afterPanelChange(scope)
    return await view({ scope })
  }

  async function scopes() {
    const fed = federation()
    const online = new Set(memoryNodes(registryOf()))
    const ids = allMemoryNodeIds()
    const count = files => files.reduce((total, file) => total + file.entries.length, 0)
    return {
      team: { entries: count(await host.readScope({ kind: 'team' })) },
      nodes: ids.map((nodeId) => {
        const record = fed.nodes[nodeId] ?? {}
        return {
          nodeId,
          hostname: hostnameOf(nodeId),
          online: online.has(nodeId),
          lastSeq: record.lastSeq ?? 0,
          sentSeq: record.sentSeq ?? 0,
          lastSeen: record.lastSeen ?? null,
          bots: botsOn(nodeId).map(bot => ({ remoteBotId: bot.worker.remoteBotId, name: bot.name, entries: 0 })),
        }
      }),
    }
  }

  async function memoryHubEndpoint(endpoint, body) {
    if (endpoint === 'memory-hub-scopes') return await scopes()
    if (endpoint === 'memory-hub-view') return await view(body)
    if (endpoint === 'memory-hub-add') return await add(body)
    if (endpoint === 'memory-hub-forget') return await forget(body)
    throw new Error(`Unknown endpoint ${endpoint}`)
  }

  Object.assign(rt, {
    memoryHubEndpoint,
    memoryHub: Object.freeze({
      enabled: true,
      seq,
      flush,
      push,
      snapshotOf: buildSnapshot,
      cleanInbox,
      scopes,
      view,
    }),
  })

  // Start reading after the first load, so the inbox cleanup and the attach see the
  // state on disk. A hub that starts with nodes already connected pushes once.
  ctx.effect(() => {
    void rt.load().then(() => {
      if (stopped) return
      cleanInbox()
      attach()
      ticker = setInterval(attach, ATTACH_MS)
      ticker.unref?.()
    }).catch(error => warnf(error, 'starting'))
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      if (ticker !== undefined) clearInterval(ticker)
      timer = undefined
      ticker = undefined
      dirty.clear()
      detach()
    }
  }, 'ds-bot: memory federation')
}
