// node-trace.js — the NODE side of bot/trace: what a node Bot thought and which tools it ran while it
// answered a hub's bot/turn, compacted for the wire so the hub's page can show it like a local Bot's page.
//
// The node has no page, but its Bot's own Session records everything: `assistant/message` (the reasoning
// blocks and the tool-call blocks of one model step) and `tool/result`. While an exchange runs, this reads
// those events of the Bot's Session and keeps an append-only list of steps:
//
//   { i, t: 'a', think?, calls?: [{ id, name, args }], end? }   one model step (end: it called no tool, its
//                                                                text is the answer the turn result carries)
//   { i, t: 'r', id, ok, out? }                                  one tool result
//
// `i` counts 1, 2, 3 … per exchange. The list goes to the hub two ways (AC's bot/trace frame, see
// lib/bot-turn.js there): live, in throttled batches through `control.trace`, and once more, whole, as the
// `trace` of the receiver's result — AC sends that one as `final` before bot/turn-result, so a batch that was
// lost on the way is made good by it. Nothing here is silent: text over a cap ends with a marker that says
// how many characters were cut, and steps past the cap are counted in `omitted`.
//
// Not carried: the assistant's visible text of a step that called tools. A turn's result already holds
// every text the turn wrote (turns.js joins them), so the hub's page shows them in the answer, as it did.

// The same numbers as AC's BOT_TRACE_LIMITS (lib/protocol.js there); test/node-trace-e2e.test.js pins them.
export const TRACE_LIMITS = Object.freeze({ maxItems: 400, maxBatchItems: 64, think: 6000, args: 1500, out: 3000, name: 120, callId: 200, calls: 16 })
// Live batches go out at most this often; the first one of a quiet period goes at once.
export const TRACE_FLUSH_MS = 400
// After a batch could not be sent (link down) the next try waits this long.
const RETRY_MS = 2000

function cut(text, max) {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…[已截断 ${text.length - end} 字]`
}

// The reasoning of a step as the reader should see it: a leading <signature> block is meant for the model.
function visibleReasoning(text) {
  if (text[0] !== '<' || !text.startsWith('<signature>')) return text
  const end = text.indexOf('</signature>')
  return end === -1 ? '' : text.slice(end + '</signature>'.length).replace(/^(\r?\n)+/, '')
}

// A tool's arguments stay valid JSON when they are too long: long string values are shortened in place
// (a file path stays readable next to a 40 KB `content`), and what is still too big becomes one marked string.
const LONG_VALUE = 200
function shrink(value, depth = 0) {
  if (typeof value === 'string') return cut(value, LONG_VALUE)
  if (depth >= 6) return '…'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => shrink(item, depth + 1))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, shrink(item, depth + 1)]))
  return value
}
export function clipArgs(raw, max = TRACE_LIMITS.args) {
  if (typeof raw !== 'string') return ''
  if (raw.length <= max) return raw
  try {
    const short = JSON.stringify(shrink(JSON.parse(raw)))
    if (short.length <= max) return short
  } catch { /* not JSON: marked below */ }
  const head = raw.slice(0, 300)
  return JSON.stringify({ _truncated: `${head}…[已截断 ${raw.length - head.length} 字]` })
}

const textOfBlocks = (blocks, kinds) => (Array.isArray(blocks) ? blocks : [])
  .filter(block => kinds.includes(block?.type) && typeof block.text === 'string')
  .map(block => block.text)

// What a tool returned, as text: images and files are named, not carried.
function outputOf(content) {
  return (Array.isArray(content) ? content : []).map((block) => {
    if (typeof block?.text === 'string') return block.text
    if (block?.type === 'image') return '[图片]'
    if (block?.type === 'file') return '[文件]'
    return ''
  }).filter(Boolean).join('\n')
}

/**
 * Follow one exchange on the node. `control` is what AC hands the receiver ({ enabled, trace(payload) });
 * `redact` removes the secrets the user keeps in this plugin from every text before it leaves.
 * Returns { onEvent(event), snapshot(), finish() }; finish() stops it and returns { items, omitted }.
 */
export function createNodeTracer({ exchangeId, control, redact = text => text, flushMs = TRACE_FLUSH_MS }) {
  const items = []
  const known = new Set()      // ids of the tool calls this exchange made
  let omitted = 0
  let sent = 0                 // items[0 .. sent) have gone out live
  let started = false          // the exchange's own user/message was seen: events before it are not its
  let closed = false
  let timer
  let lastSent = 0
  const clean = text => redact(String(text ?? ''))

  const add = (item) => {
    if (items.length >= TRACE_LIMITS.maxItems) { omitted += 1; return }
    items.push({ i: items.length + 1, ...item })
    schedule()
  }

  const flush = () => {
    timer = undefined
    if (closed) return
    while (sent < items.length) {
      const batch = items.slice(sent, sent + TRACE_LIMITS.maxBatchItems)
      let ok = false
      try { ok = control.trace({ items: batch }) === true } catch { ok = false }
      if (!ok) { schedule(RETRY_MS); return }
      sent += batch.length
      lastSent = Date.now()
    }
  }
  function schedule(delay = Math.max(0, flushMs - (Date.now() - lastSent))) {
    if (closed || timer !== undefined) return
    timer = setTimeout(flush, delay)
    timer.unref?.()
  }

  function assistant(data) {
    const content = data?.message?.content
    const think = visibleReasoning(textOfBlocks(content, ['reasoning']).join('\n\n')).trim()
    const calls = (Array.isArray(content) ? content : []).filter(block => block?.type === 'tool-call' && typeof block.id === 'string' && block.id !== '')
    const item = { t: 'a' }
    if (think !== '') item.think = cut(clean(think), TRACE_LIMITS.think)
    if (calls.length === 0) { item.end = true; if (item.think === undefined) return; add(item); return }
    item.calls = calls.slice(0, TRACE_LIMITS.calls).map((block) => {
      known.add(block.id)
      return { id: block.id.slice(0, TRACE_LIMITS.callId), name: String(block.name ?? '').slice(0, TRACE_LIMITS.name), args: clipArgs(clean(block.arguments)) }
    })
    add(item)
  }

  function result(data) {
    const message = data?.message
    const id = message?.toolCallId
    if (typeof id !== 'string' || !known.has(id)) return
    const out = cut(clean(outputOf(message.content)), TRACE_LIMITS.out)
    add({ t: 'r', id: id.slice(0, TRACE_LIMITS.callId), ok: message.isError !== true, ...(out === '' ? {} : { out }) })
  }

  return {
    onEvent(event) {
      if (closed) return
      switch (event?.type) {
        case 'user/message':
          if (!started && event.data?.source?.rpcId === exchangeId) started = true
          break
        case 'assistant/message':
          if (started) assistant(event.data)
          break
        case 'tool/result':
          if (started) result(event.data)
          break
        default:
      }
    },
    snapshot: () => ({ items: items.map(item => ({ ...item })), omitted }),
    finish() {
      closed = true
      clearTimeout(timer)
      timer = undefined
      return { items, omitted }
    },
  }
}

/**
 * The receiver's registry of running tracers, keyed by Session id, fed by ONE `session/event` listener.
 * `start` returns the tracer (or undefined when AC did not enable tracing or the Session is unknown).
 */
export function createTraceFeed(rt) {
  const bySession = new Map()
  let listening = false
  const listen = () => {
    if (listening || typeof rt.ctx?.on !== 'function') return
    listening = true
    rt.ctx.on('session/event', (session, event) => {
      const tracers = bySession.get(session?.id)
      if (tracers === undefined) return
      for (const tracer of tracers) {
        try { tracer.onEvent(event) } catch (error) { rt.warn?.('ds-bot: a node trace event was not read: %s', error?.message ?? error) }
      }
    })
  }
  return {
    start({ sessionId, exchangeId, control }) {
      if (control?.enabled !== true || typeof control.trace !== 'function') return undefined
      if (typeof sessionId !== 'string' || sessionId === '' || typeof rt.ctx?.on !== 'function') return undefined
      listen()
      const tracer = createNodeTracer({ exchangeId, control, redact: text => (typeof rt.redactSecrets === 'function' ? rt.redactSecrets(text) : text), ...(Number.isFinite(rt.nodeTraceFlushMs) ? { flushMs: rt.nodeTraceFlushMs } : {}) })
      let set = bySession.get(sessionId)
      if (set === undefined) { set = new Set(); bySession.set(sessionId, set) }
      set.add(tracer)
      const finish = tracer.finish
      tracer.finish = () => {
        set.delete(tracer)
        if (set.size === 0 && bySession.get(sessionId) === set) bySession.delete(sessionId)
        return finish()
      }
      return tracer
    },
  }
}
