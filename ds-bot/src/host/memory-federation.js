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
import { randomUUID } from 'node:crypto'
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

// A node queues what it could not send. The cap is on both the number of changes and
// their size: a queue that grows without end would either lose the newest change
// silently or fill the disk.
const OUTBOX_MAX = 500
const OUTBOX_BYTES = 256 * 1024
// How long one read or write frame waits for the hub before the tool call gives up.
// A write that timed out stays queued: the retry carries the same requestId, so the
// hub's inbox writes it once.
const REPLY_MS = 20_000
// How often a node looks for the memory link service and for a reconnection.
const NODE_TICK_MS = 2_000

const NODE_FRAMES = {
  hello: 'mem/hello',
  snapshot: 'mem/snapshot',
  read: 'mem/read',
  readResult: 'mem/read-result',
  write: 'mem/write',
  writeResult: 'mem/write-result',
  ack: 'mem/ack',
}

// A reply with one of these codes will not change on a retry: the entry is removed
// from the outbox instead of blocking everything behind it forever.
const TERMINAL_CODES = new Set([
  'memory/team-read-only', 'memory/too-large', 'memory/refused', 'memory/ambiguous',
  'memory/no-match', 'memory/not-on-roster', 'memory/read-only', 'memory/denied',
  'memory/bot-gone',
])

const NODE_MESSAGES = {
  'memory/federation-offline': 'This node is not connected to its hub, so federated memory cannot be reached now.',
  'memory/federation-unsupported': 'The hub this node talks to does not support federated memory (memory-sync/1), so nothing was saved.',
  'memory/federation-timeout': 'The hub did not answer the memory request in time. Nothing was written twice; try again.',
  'memory/outbox-full': `This node already has ${OUTBOX_MAX} memory changes waiting for the hub, or ${Math.round(OUTBOX_BYTES / 1024)}KB of them; the change was not saved. Reconnect and let them go out, then try again.`,
}

const HUB_MESSAGES = {
  'memory/not-on-roster': 'The hub does not have this Bot on its roster for this node, so the change was refused.',
  'memory/read-only': 'The hub is read-only right now, so it refused the change.',
  'memory/team-read-only': 'The team memory is written on the hub by a Main Bot or a group admin, not from a node.',
  'memory/too-large': 'That memory is full on the hub; remove an entry there first.',
  'memory/refused': 'The hub refused the change.',
  'memory/denied': 'The hub says this Bot may not change that memory.',
  'memory/ambiguous': 'More than one entry matches on the hub; quote more of the one you mean.',
  'memory/no-match': 'No entry in that memory matches.',
  'memory/bot-gone': 'That Bot no longer exists on the hub.',
  'memory/failed': 'The hub could not save the change.',
}

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
      // Every file of this scope counts, not just MEMORY.md: a scope's topics are
      // part of what it keeps, and the panel shows the whole of it.
      sizes: { [tag]: files.reduce((total, file) => total + bodySize(file), 0) },
      limits: { ...MEMORY_LIMITS, [tag]: host.mainLimit(scope) },
      keys: { [tag]: host.logKeyOf(scope) },
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

  // The three layers the panel opens on: the team, every machine the hub has heard
  // from, and each machine's Bots. Counts are read from disk here, once, when the
  // panel asks — nothing on a tick and nothing per turn.
  async function scopes() {
    const fed = federation()
    const online = new Set(memoryNodes(registryOf()))
    const ids = allMemoryNodeIds()
    const count = files => files.reduce((total, file) => total + file.entries.length, 0)
    const nodes = []
    for (const nodeId of ids) {
      const record = fed.nodes[nodeId] ?? {}
      const bots = []
      for (const bot of botsOn(nodeId)) {
        const remoteBotId = bot.worker?.remoteBotId
        if (remoteBotId === undefined) continue
        bots.push({
          remoteBotId,
          name: bot.name,
          entries: count(await host.readScope({ kind: 'bot', nodeId, botId: remoteBotId })),
        })
      }
      nodes.push({
        nodeId,
        hostname: hostnameOf(nodeId),
        online: online.has(nodeId),
        lastSeq: record.lastSeq ?? 0,
        sentSeq: record.sentSeq ?? 0,
        lastSeen: record.lastSeen ?? null,
        entries: count(await host.readScope({ kind: 'node', nodeId })),
        bots,
      })
    }
    return {
      team: { entries: count(await host.readScope({ kind: 'team' })) },
      nodes,
    }
  }

  // ---------------------------------------------------------------------------
  // Node side. The same module also runs on a machine that hosts Bots for a hub. It
  // keeps the last rendered snapshot the hub sent, queues writes that could not go
  // out, and answers the memory tools from those two. It never reads or writes a
  // memory file: on a node the hub owns `memory/nodes/<node>/`, and the cache lives
  // in the state document instead.
  //
  // The memory link is ra's `remote-agent:memory-link` service (S2). That service
  // already owns the four send gates (memory frames only, bound+online, hub announced
  // `memory-sync/1`, E2E for body frames), so this side only decides *when* to send.

  const nodePending = new Map()
  const nodeOff = []
  let nodeLink
  let nodeTicker
  let nodeDraining = false
  let nodeAnnounced = false
  let nodeWarnedOld = false

  const nodePrefOff = () => rt.state?.prefs?.memoryFederation === false
  const nodePolicyOf = () => {
    try { return ctx.get?.('remote-agent:node-policy') ?? ctx['remote-agent:node-policy'] } catch { return undefined }
  }
  const nodeIdOf = () => text(nodePolicyOf()?.nodeId) || undefined
  function nodeLinkOf() {
    try {
      const found = ctx.get?.('remote-agent:memory-link') ?? ctx['remote-agent:memory-link']
      return found !== null && typeof found === 'object' && typeof found.send === 'function' ? found : undefined
    } catch { return undefined }
  }
  const nodeOnline = () => {
    const found = nodeLinkOf()
    return Boolean(found !== undefined && found.isOnline === true)
  }
  // What the settings screen needs to decide two things: whether this machine is a
  // node (so its Bots can keep federated memory), and whether it is a hub (so the
  // three-layer panel has machines to show).
  const memoryFederationView = () => ({
    nodeId: nodeIdOf() ?? null,
    canFederate: nodeIdOf() !== undefined && !nodePrefOff(),
    hub: registryOf() !== undefined,
  })
  function nodeCapable() {
    const found = nodeLinkOf()
    if (found === undefined) return false
    try { return typeof found.hubSupportsMemory === 'function' ? found.hubSupportsMemory() === true : true } catch { return false }
  }

  function nodeError(code, message) {
    return Object.assign(new Error(message ?? NODE_MESSAGES[code] ?? code), { code })
  }
  const nodeFailure = code => nodeError(text(code) || 'memory/failed', HUB_MESSAGES[text(code)] ?? `The hub answered ${text(code) || 'an error'}.`)

  // What the hub last rendered for this node: the three segments exactly as the hub
  // built them, and the seq they belong to. `at` is when this node applied it.
  function nodeCache() {
    const state = rt.state
    let cache = state.memoryCache
    if (cache === null || typeof cache !== 'object' || Array.isArray(cache)) cache = state.memoryCache = {}
    if (!Number.isInteger(cache.seq) || cache.seq < 0) cache.seq = 0
    if (!Number.isInteger(cache.at) || cache.at < 0) cache.at = 0
    if (typeof cache.team !== 'string') cache.team = ''
    if (typeof cache.node !== 'string') cache.node = ''
    if (cache.bots === null || typeof cache.bots !== 'object' || Array.isArray(cache.bots)) cache.bots = {}
    cache.truncated = cache.truncated === true
    return cache
  }

  // What this node could not send yet, oldest first. Each item carries the requestId
  // it was born with: a retry reuses it, so the hub's inbox writes it once.
  function nodeOutbox() {
    const state = rt.state
    if (!Array.isArray(state.memoryOutbox)) state.memoryOutbox = []
    return state.memoryOutbox
  }
  const outboxBytes = () => {
    try { return Buffer.byteLength(JSON.stringify(nodeOutbox()), 'utf8') } catch { return Infinity }
  }

  const nodeSave = async () => { try { await rt.save?.() } catch (error) { warnf(error, 'saving the node memory state') } }

  // A reply may come before or after the tool call gave up; only the requestId ties
  // the two together, and a late reply for a request nobody waits for is dropped.
  function nodeSettle(expect, data) {
    if (data === null || typeof data !== 'object') return
    const requestId = text(data.requestId)
    if (requestId === '') return
    const waiting = nodePending.get(requestId)
    if (waiting === undefined || waiting.expect !== expect) return
    clearTimeout(waiting.timer)
    nodePending.delete(requestId)
    waiting.resolve(data)
  }

  function nodeRequest(type, expect, payload) {
    const found = nodeLinkOf()
    if (found === undefined) return Promise.reject(nodeError('memory/federation-offline'))
    const requestId = text(payload?.requestId)
    return new Promise((resolve, reject) => {
      const waitMs = Number.isFinite(rt.config?.memoryReplyMs) && rt.config.memoryReplyMs > 0 ? rt.config.memoryReplyMs : REPLY_MS
      const timer = setTimeout(() => {
        nodePending.delete(requestId)
        reject(nodeError('memory/federation-timeout'))
      }, waitMs)
      timer.unref?.()
      nodePending.set(requestId, { expect, resolve, reject, timer })
      let sent = false
      try { sent = found.send(type, payload) === true } catch { sent = false }
      if (sent) return
      clearTimeout(timer)
      nodePending.delete(requestId)
      reject(nodeError(nodeOnline() ? 'memory/federation-blocked' : 'memory/federation-offline'))
    })
  }

  async function nodeSnapshot(data) {
    if (data === null || typeof data !== 'object') return { applied: false }
    const seq = Number.isInteger(data.seq) && data.seq >= 0 ? data.seq : undefined
    if (seq === undefined) return { applied: false }
    const cache = nodeCache()
    if (seq < cache.seq) {
      if (!nodeWarnedOld) {
        nodeWarnedOld = true
        warn('memory federation: dropped a snapshot older than the one applied (%s < %s)', seq, cache.seq)
      }
      return { applied: false, reason: 'old' }
    }
    nodeWarnedOld = false
    cache.seq = seq
    cache.at = Date.now()
    cache.team = typeof data.team === 'string' ? data.team : ''
    cache.node = typeof data.node === 'string' ? data.node : ''
    cache.bots = {}
    const bots = data.bots !== null && typeof data.bots === 'object' ? Object.entries(data.bots) : []
    for (const [remoteBotId, segment] of bots.slice(0, MAX_SNAPSHOT_BOTS)) {
      if (segment === null || typeof segment !== 'object') continue
      cache.bots[remoteBotId] = {
        text: typeof segment.text === 'string' ? segment.text : '',
        truncated: segment.truncated === true,
      }
    }
    cache.truncated = data.truncated === true
    if (typeof data.truncatedAt === 'string') cache.truncatedAt = data.truncatedAt
    else delete cache.truncatedAt
    await nodeSave()
    try { nodeLinkOf()?.send?.(NODE_FRAMES.ack, { seq }) } catch { /* the ack is best effort */ }
    return { applied: true, seq }
  }

  async function nodeWrite(bot, change = {}) {
    if (nodePrefOff()) {
      throw nodeError('memory/federation-unsupported', 'Federated memory is turned off on this node (prefs.memoryFederation=false); nothing was saved.')
    }
    const scope = change.scope === 'node' ? 'node' : 'own'
    const item = {
      requestId: randomUUID(),
      remoteBotId: text(bot?.id),
      op: change.op === 'replace' || change.op === 'forget' ? change.op : 'add',
      scope,
      ...(typeof change.text === 'string' ? { text: change.text } : {}),
      ...(typeof change.replace === 'string' ? { replace: change.replace } : {}),
      ...(typeof change.topic === 'string' ? { topic: change.topic } : {}),
      ...(typeof change.until === 'string' ? { until: change.until } : {}),
      ...(change.pin === true ? { pin: true } : {}),
      ...(change.always === true ? { always: true } : {}),
    }
    const queueIt = () => {
      const queue = nodeOutbox()
      let size = 0
      try { size = JSON.stringify(item).length } catch { size = Infinity }
      if (queue.length >= OUTBOX_MAX || outboxBytes() + size > OUTBOX_BYTES) throw nodeError('memory/outbox-full')
      queue.push({ ...item, at: Date.now() })
      void nodeSave()
    }
    if (!nodeOnline()) {
      queueIt()
      return { ok: true, queued: true, changed: true }
    }
    if (!nodeCapable()) throw nodeError('memory/federation-unsupported')
    let result
    try {
      result = await nodeRequest(NODE_FRAMES.write, NODE_FRAMES.writeResult, item)
    } catch (failure) {
      if (failure?.code === 'memory/federation-offline' || failure?.code === 'memory/federation-blocked' || failure?.code === 'memory/federation-timeout') {
        queueIt()
        return { ok: true, queued: true, changed: true }
      }
      throw failure
    }
    if (result?.ok !== true) throw nodeFailure(result?.error)
    return { ok: true, changed: result.changed === true, id: result.id, seq: result.seq }
  }

  async function nodeRead(bot, request = {}) {
    if (nodePrefOff()) {
      throw nodeError('memory/federation-unsupported', 'Federated memory is turned off on this node (prefs.memoryFederation=false), so nothing can be read.')
    }
    if (!nodeOnline()) throw nodeError('memory/federation-offline')
    if (!nodeCapable()) throw nodeError('memory/federation-unsupported')
    const scope = request.scope === 'node' ? 'node' : request.scope === 'team' ? 'team' : 'own'
    const frame = {
      requestId: randomUUID(),
      remoteBotId: text(bot?.id),
      scope,
      ...(typeof request.query === 'string' && request.query !== '' ? { query: request.query.slice(0, 512) } : {}),
      ...(typeof request.topic === 'string' && request.topic !== '' ? { topic: request.topic.slice(0, 64) } : {}),
      ...(Number.isInteger(request.limit) ? { limit: request.limit } : {}),
    }
    const result = await nodeRequest(NODE_FRAMES.read, NODE_FRAMES.readResult, frame)
    if (result?.ok !== true) throw nodeFailure(result?.error)
    return result
  }

  function nodeCached(bot) {
    const cache = nodeCache()
    const key = text(bot?.id)
    const own = key === '' ? undefined : cache.bots[key]
    return {
      seq: cache.seq,
      at: cache.at,
      nodeId: nodeIdOf(),
      team: cache.team,
      node: cache.node,
      own: own !== null && typeof own === 'object' && typeof own.text === 'string' ? own.text : '',
      ownTruncated: own?.truncated === true,
      truncated: cache.truncated === true,
      synced: key !== '' && own !== undefined,
    }
  }

  function nodeStatus() {
    return {
      pref: !nodePrefOff(),
      nodeId: nodeIdOf(),
      linked: nodeLinkOf() !== undefined,
      online: nodeOnline(),
      capable: nodeCapable(),
      seq: nodeCache().seq,
      at: nodeCache().at,
      queued: nodeOutbox().length,
    }
  }

  async function nodeDrain() {
    if (nodeDraining) return 0
    nodeDraining = true
    let sent = 0
    try {
      for (;;) {
        if (stopped) return sent
        const queue = nodeOutbox()
        if (queue.length === 0 || !nodeOnline() || !nodeCapable()) return sent
        const item = queue[0]
        const { at, ...frame } = item
        let result
        try {
          result = await nodeRequest(NODE_FRAMES.write, NODE_FRAMES.writeResult, frame)
        } catch (failure) {
          // A timeout may mean the hub wrote it: the item keeps its requestId, so the
          // next attempt replays the same inbox answer instead of writing twice.
          if (failure?.code === 'memory/federation-timeout' || failure?.code === 'memory/federation-offline' || failure?.code === 'memory/federation-blocked') return sent
          throw failure
        }
        const code = text(result?.error)
        if (result?.ok === true || TERMINAL_CODES.has(code)) {
          queue.shift()
          sent += 1
          void nodeSave()
          continue
        }
        return sent
      }
    } finally {
      nodeDraining = false
    }
  }

  // The link can be provided after this module installs (ra loads before or after us
  // depending on the process), so it is looked up again on a tick instead of once.
  function nodeAttach() {
    const found = nodeLinkOf()
    if (found !== nodeLink) {
      while (nodeOff.length > 0) {
        try { nodeOff.pop()() } catch { /* the old link is gone */ }
      }
      nodeLink = found
      nodeAnnounced = false
      nodeWarnedOld = false
      if (found?.on) {
        nodeOff.push(found.on(NODE_FRAMES.snapshot, data => { void nodeSnapshot(data) }))
        nodeOff.push(found.on(NODE_FRAMES.readResult, data => { nodeSettle(NODE_FRAMES.readResult, data) }))
        nodeOff.push(found.on(NODE_FRAMES.writeResult, data => { nodeSettle(NODE_FRAMES.writeResult, data) }))
      }
      // The hub needs to know how far this node's cache got before it pushes again.
      try { found?.setAppliedSeq?.(() => nodeCache().seq) } catch { /* an older ra */ }
    }
    if (nodeLink === undefined) return
    const online = nodeLink.isOnline === true
    if (online && !nodeAnnounced) {
      nodeAnnounced = true
      // `online()` sends mem/hello with the appliedSeq thunk just installed.
      try { if (typeof nodeLink.online === 'function') nodeLink.online() } catch { /* the link decides */ }
      void nodeDrain()
    }
    if (!online) nodeAnnounced = false
  }

  function nodeDispose() {
    while (nodeOff.length > 0) {
      try { nodeOff.pop()() } catch { /* already gone */ }
    }
    nodeLink = undefined
    nodeAnnounced = false
    for (const [requestId, waiting] of nodePending) {
      clearTimeout(waiting.timer)
      nodePending.delete(requestId)
      try { waiting.reject(nodeError('memory/federation-offline')) } catch { /* nobody listens */ }
    }
    if (nodeTicker !== undefined) clearInterval(nodeTicker)
    nodeTicker = undefined
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
    memoryFederationView,
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
    // The node half. `enabled` answers whether federation is allowed here at all;
    // `status` says whether the hub can be reached right now. Tools and the prompt
    // section use those two and never read a file.
    memoryNode: Object.freeze({
      enabled: () => !nodePrefOff(),
      nodeId: () => nodeIdOf(),
      status: nodeStatus,
      cached: nodeCached,
      write: nodeWrite,
      read: nodeRead,
      apply: nodeSnapshot,
      drain: nodeDrain,
      flush: nodeDrain,
      attach: nodeAttach,
      outbox: () => nodeOutbox().map(item => ({ ...item })),
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
      // A node finds ra's link service on the same tick: either plugin may load first.
      nodeAttach()
      nodeTicker = setInterval(nodeAttach, NODE_TICK_MS)
      nodeTicker.unref?.()
    }).catch(error => warnf(error, 'starting'))
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      if (ticker !== undefined) clearInterval(ticker)
      timer = undefined
      ticker = undefined
      dirty.clear()
      detach()
      nodeDispose()
    }
  }, 'ds-bot: memory federation')
}
