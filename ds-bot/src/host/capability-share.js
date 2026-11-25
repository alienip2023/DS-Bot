// capability-share.js — the hub's MCP servers on the nodes (docs: ds-bot-cluster/DESIGN-capability-sharing.md, fork.131).
//
// The hub registers a capability once and the Bots of every node use it as if it were their own, the way OpenMausBot
// lends one: the hub mounts the MCP server (capabilities.js, `rt.sharedMcp`), tells each node its interface
// (`team/caps`, over AC's reliable link: tool names, descriptions and schemas, never the command, URL, headers or
// secrets), and a node Bot's call goes back to the hub as one `team/act` request (`cap_call`), which runs it as that
// Bot's shadow and returns the result as text. The secrets stay where they were saved.
//
// A call is not queued for a hub that is away: `team/act` fails at once when the hub is not connected, and times out
// after 120 s, so a tool call is never run hours later.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isRemoteBot, postFrame, refOf } from './bot-link.js'

export const CAP_CALL = 'cap_call'
export const SECRET_SYNC = 'secret_sync'
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const HUB_ID = /^[A-Za-z0-9._-]{1,64}$/
const MAX_ITEMS = 64
const MAX_TOOLS = 100
const ARGS_MAX = 30 * 1024        // AC's team/act carries 32 KiB of arguments
const PER_BOT_CONCURRENT = 4
const PER_BOT_PER_MINUTE = 120
const SECRET_SYNC_MAX = 60 * 1024    // AC's team/act answer carries 64 KiB
const SECRET_PULL_MIN_MS = 3_000
// A hub that said "too soon" (or could not answer) is asked again soon at first, so a key taken back is gone within seconds.
const SECRET_PULL_RETRY_MS = [4_000, 10_000, 30_000, 30_000, 60_000, 60_000]
const REV = /^[0-9a-f]{16}$/
const proxyOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

const serviceOf = (rt, name) => { try { return rt.ctx?.get?.(name) } catch { return undefined } }
const networkOf = rt => serviceOf(rt, 'remote-agent:bot-network')
const onHubSide = rt => typeof serviceOf(rt, 'remote-agent:registry')?.send === 'function'

// ── NODE: the catalog from the hub, and a proxy tool for each tool in it ──

/** What a node keeps of one catalog entry, or undefined when it is not one. */
function entryOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !NAME.test(raw.name) || raw.name.length > 32) return undefined
  const prefix = `mcp__${raw.name}__`
  const tools = []
  for (const tool of Array.isArray(raw.tools) ? raw.tools.slice(0, MAX_TOOLS) : []) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.startsWith(prefix) || tool.name.length > 128) continue
    tools.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description.slice(0, 1000) : '',
      inputSchema: tool.inputSchema !== null && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    })
  }
  return { name: raw.name, description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : '', ok: raw.ok === true, ...(typeof raw.reason === 'string' ? { reason: raw.reason.slice(0, 300) } : {}), tools }
}

/**
 * On a node: replace what the hub shares with this catalog. An MCP of the node's own with the same name wins; what the
 * hub no longer shares goes. Returns true when the library changed.
 */
export async function applyCatalog(rt, hubId, items) {
  if (!HUB_ID.test(hubId ?? '') || !Array.isArray(items) || items.length > MAX_ITEMS) return false
  await rt.load?.()
  if (rt.readOnly?.() !== undefined) return false
  const source = `hub:${hubId}`
  const library = rt.state.capabilities.items
  const incoming = new Map()
  for (const raw of items) {
    const entry = entryOf(raw)
    if (entry !== undefined && !incoming.has(entry.name)) incoming.set(entry.name, entry)
  }
  let changed = false
  for (const [name, item] of Object.entries(library)) {
    if (item.kind !== 'mcp' || item.sharedFrom?.startsWith('hub:') !== true || incoming.has(name)) continue
    delete library[name]
    for (const bot of Object.values(rt.state.bots)) bot.capabilities = (bot.capabilities ?? []).filter(value => value !== name)
    for (const pack of Object.values(library)) if (pack.kind === 'pack') pack.items = (pack.items ?? []).filter(value => value !== name)
    changed = true
  }
  for (const entry of incoming.values()) {
    const existing = library[entry.name]
    if (existing && !(existing.kind === 'mcp' && existing.sharedFrom?.startsWith('hub:'))) continue   // the node's own wins
    if (rt.connectorConnected?.(entry.name) === true) continue   // so does a connector this node is signed in to itself
    const next = {
      name: entry.name, kind: 'mcp', transport: 'hub-proxy', description: entry.description, tools: entry.tools,
      ok: entry.ok, ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      sharedFrom: source, createdBy: null, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
    }
    if (existing && JSON.stringify({ ...existing, updatedAt: 0 }) === JSON.stringify({ ...next, createdAt: existing.createdAt, updatedAt: 0 })) continue
    library[entry.name] = next
    changed = true
  }
  if (!changed) return true
  await rt.save()
  return true
}

/** On a node: one call to the hub, as the Bot that makes it. Throws with the reason when it is not done. */
async function callHub(rt, exec, item, rawTool, args) {
  const caller = rt.botOf?.(rt.selfOf?.(exec?.agent?.id))
  if (caller === undefined) throw new Error('Only Bots on the team can call shared tools.')
  const network = networkOf(rt)
  if (typeof network?.teamAct !== 'function') throw new Error("This machine's AC cannot reach the hub (update AC on this machine).")
  const actor = refOf(rt, caller)
  if (actor === undefined) throw new Error('This machine is not connected to a hub.')
  const body = JSON.stringify({ capability: item.name, tool: rawTool, arguments: args ?? {} })
  if (Buffer.byteLength(body, 'utf8') > ARGS_MAX) throw new Error('The arguments are too large to send to the hub (30 KiB at most).')
  let out
  try {
    out = await network.teamAct({ requestId: randomUUID(), actor, tool: CAP_CALL, args: body })
  } catch (error) {
    throw new Error(`Not done: ${error?.message ?? error}`)
  }
  if (out?.ok !== true) throw new Error(out?.text || 'The hub gave no answer.')
  return out.text
}

/** Tool definitions for a shared MCP on a node, named as on the hub so the model cannot tell them apart. */
export function definitionsFor(rt, item) {
  return (item.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    output: proxyOutput,
    execute: (args, exec) => callHub(rt, exec, item, tool.name, args),
  }))
}

// ── HUB: the catalog out, and the calls in ──

/** On the hub: tell `nodeId` what is shared with it, when that is not what it was last told. */
export async function pushCatalog(rt, nodeId) {
  if (!onHubSide(rt) || typeof rt.sharedMcp?.catalog !== 'function') return false
  const items = await rt.sharedMcp.catalog()
  const sent = (rt.capsSent ??= new Map())
  // Which keys the user shared with the nodes, as a fingerprint of their names and times: no value is in it. The node
  // asks the hub for the keys (`secret_sync`) when it is not the one it last took.
  const secretsRev = rt.secretsRev?.()
  const hash = JSON.stringify([items, secretsRev])
  if (sent.get(nodeId) === hash) return false
  const hubId = rt.state.federation?.hubId
  if (!HUB_ID.test(hubId ?? '')) return false
  if (!postFrame(rt, nodeId, 'team/caps', { hubId, items, ...(REV.test(secretsRev ?? '') ? { secretsRev } : {}) })) return false
  sent.set(nodeId, hash)
  return true
}

const buckets = new WeakMap()
function admit(rt, botId) {
  let all = buckets.get(rt)
  if (!all) { all = new Map(); buckets.set(rt, all) }
  const now = Date.now()
  const bucket = all.get(botId) ?? { running: 0, stamps: [] }
  bucket.stamps = bucket.stamps.filter(at => now - at < 60_000)
  if (bucket.running >= PER_BOT_CONCURRENT) return { refused: `${PER_BOT_CONCURRENT} shared tool calls of this Bot are already running here; wait for one to finish.` }
  if (bucket.stamps.length >= PER_BOT_PER_MINUTE) return { refused: `This Bot has made ${PER_BOT_PER_MINUTE} shared tool calls in the last minute; slow down.` }
  bucket.running += 1
  bucket.stamps.push(now)
  all.set(botId, bucket)
  return { release: () => { bucket.running -= 1 } }
}

// What was called, by whom, and how it went: never the arguments or the result.
function audit(rt, line) {
  try {
    const dir = join(rt.home ?? '.', 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'capability-calls.jsonl'), `${JSON.stringify({ time: Date.now(), ...line })}\n`, { mode: 0o600 })
  } catch { /* the call itself matters more than its line */ }
}

/** On the hub: run one `cap_call` from a node Bot as its shadow. Returns { ok, text }. */
export async function runCapabilityCall(rt, shadow, act) {
  let call
  try { call = JSON.parse(act.args) } catch { return { ok: false, text: 'The call was not valid JSON.' } }
  const { capability, tool, arguments: args } = call ?? {}
  if (typeof capability !== 'string' || typeof tool !== 'string' || (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args)))) {
    return { ok: false, text: 'The call must name a capability and a tool, with an object of arguments.' }
  }
  if (typeof rt.sharedMcp?.call !== 'function') return { ok: false, text: 'This hub cannot run shared tools.' }
  // A connector the user turned off for this Bot (its shadow here) is off for it on the node too.
  if ((rt.connectorOffFor?.(shadow.id) ?? []).some(prefix => tool.startsWith(prefix))) return { ok: false, text: `${capability} is turned off for ${shadow.name}.` }
  const slot = admit(rt, shadow.id)
  if (slot.refused !== undefined) return { ok: false, text: slot.refused }
  const started = Date.now()
  const base = { nodeId: shadow.worker?.nodeId, bot: shadow.name, capability, tool }
  try {
    const text = await rt.sharedMcp.call(capability, tool, args ?? {}, { callId: act.requestId })
    audit(rt, { ...base, ok: true, ms: Date.now() - started, bytes: Buffer.byteLength(text, 'utf8') })
    return { ok: true, text }
  } catch (error) {
    const message = rt.redactSecrets?.(String(error?.message ?? error)) ?? String(error?.message ?? error)
    audit(rt, { ...base, ok: false, ms: Date.now() - started, error: message.slice(0, 200) })
    return { ok: false, text: message.slice(0, 2000) }
  } finally {
    slot.release()
  }
}

const pullTimes = new WeakMap()
/** On the hub: answer a node's `secret_sync`: the keys the user shared with the nodes. Returns { ok, text }. */
export async function runSecretSync(rt, shadow, act) {
  const nodeId = shadow.worker?.nodeId
  const times = pullTimes.get(rt) ?? new Map()
  pullTimes.set(rt, times)
  const now = Date.now()
  if (now - (times.get(nodeId) ?? 0) < SECRET_PULL_MIN_MS) return { ok: false, text: 'Asked again too soon; wait a few seconds.' }
  times.set(nodeId, now)
  let list
  try { list = await rt.sharedSecretsForNodes() } catch (error) { return { ok: false, text: String(error?.message ?? error).slice(0, 300) } }
  const body = JSON.stringify(list)
  if (Buffer.byteLength(body, 'utf8') > SECRET_SYNC_MAX) return { ok: false, text: `${list.length} keys are shared with the nodes, more than one answer can carry (60 KiB). Share fewer or shorter keys.` }
  // Names and a count only: never a value.
  audit(rt, { event: 'secret_sync', nodeId, bot: shadow.name, count: list.length })
  return { ok: true, text: body }
}

export function install(rt) {
  const { ctx } = rt
  let stopped = false
  let attached
  let off
  // AC may load after ds-bot: take the catalog frames whenever its bot-network shows up (or changes).
  const attach = () => {
    const network = networkOf(rt)
    if (network === attached) return
    off?.()
    attached = network
    off = typeof network?.onReliable === 'function'
      ? network.onReliable('team/caps', async (msg) => {
        if (stopped) throw new Error('ds-bot is unloading')
        // Only the hub says what is shared with this node: the link names who sent it.
        if (msg.from !== 'hub') return
        await applyCatalog(rt, msg.data?.hubId, msg.data?.items)
        void takeSecrets(msg.data?.secretsRev)
      })
      : undefined
  }
  // On a node: take the keys the hub shares when the hub's fingerprint is not the one this node last took. The keys come
  // as the answer to a request (`team/act`), never on a frame that is kept on disk; a hub that cannot answer now is
  // asked again a few times.
  let pulling = false
  let retryTimer
  let tries = 0
  let wanted
  async function takeSecrets(rev) {
    if (stopped || !REV.test(rev ?? '')) return
    wanted = rev   // the newest fingerprint heard of: a frame that comes while a pull runs is taken right after it
    if (pulling || rt.state.hubSecrets?.rev === rev) return
    pulling = true
    clearTimeout(retryTimer)
    let done = false
    try {
      const network = networkOf(rt)
      const caller = Object.values(rt.state.bots ?? {}).find(bot => !isRemoteBot(bot) && refOf(rt, bot) !== undefined)
      if (typeof network?.teamAct !== 'function' || caller === undefined) return
      const out = await network.teamAct({ requestId: randomUUID(), actor: refOf(rt, caller), tool: SECRET_SYNC, args: '{}' })
      if (out?.ok !== true) { rt.warn?.('ds-bot: the keys the hub shares were not taken: %s', String(out?.text ?? 'no answer').slice(0, 200)); return }
      let list
      try { list = JSON.parse(out.text) } catch { rt.warn?.('ds-bot: the hub answered with keys this node could not read'); return }
      const counts = await rt.applyHubSecrets(list)
      rt.state.hubSecrets = { rev, names: list.map(item => item?.name).filter(name => typeof name === 'string').sort(), at: Date.now() }
      await rt.save?.()
      if (counts.kept > 0) rt.warn?.('ds-bot: %d key(s) the hub shares were not taken: this node has its own of the same name', counts.kept)
      done = true
    } catch (error) {
      rt.warn?.('ds-bot: the keys the hub shares were not taken: %s', String(error?.message ?? error).slice(0, 200))
    } finally {
      pulling = false
      if (done) {
        tries = 0
        if (wanted !== rev && !stopped) void takeSecrets(wanted)
      } else if (!stopped && (tries += 1) <= SECRET_PULL_RETRY_MS.length) {
        retryTimer = setTimeout(() => void takeSecrets(wanted), SECRET_PULL_RETRY_MS[tries - 1])
        retryTimer.unref?.()
      }
    }
  }
  // On the hub: a key was shared or unshared, or changed: every node hears of it (the catalog frame carries the new
  // fingerprint).
  const secretsChanged = rt.secretsChanged
  let lastRev = rt.secretsRev?.()
  rt.secretsChanged = (...args) => {
    secretsChanged?.(...args)
    const rev = rt.secretsRev?.()
    if (rev !== lastRev) { lastRev = rev; if (onHubSide(rt)) rt.markPeerRosterDirty?.() }
  }
  attach()
  const timer = setInterval(attach, 5_000)
  timer.unref?.()
  // A shared MCP came or went (it connected, its tools changed): every node hears of it.
  const unlisten = rt.sharedMcp?.onChange?.(() => rt.markPeerRosterDirty?.())
  rt.capabilityProxy = { definitionsFor: item => definitionsFor(rt, item) }
  rt.pushSharedCatalog = nodeId => pushCatalog(rt, nodeId)
  ctx?.effect?.(() => () => {
    stopped = true
    clearInterval(timer)
    clearTimeout(retryTimer)
    off?.()
    unlisten?.()
    rt.secretsChanged = secretsChanged
    rt.capabilityProxy = undefined
    rt.pushSharedCatalog = undefined
  }, 'ds-bot: shared capabilities')
}

