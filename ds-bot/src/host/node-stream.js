// node-stream.js — the NODE side of bot/stream: forward the model's text-delta events to the hub
// as incremental bot/stream frames, so the hub's page can render the node Bot's reply token-by-token
// instead of waiting for the whole bot/turn-result.
//
// Only active when the hub declared `bot-stream/1` in its welcome (control.stream.enabled).
// Called from bot-turn.js's receiver path, same as the trace control object.
//
// Throttle: batches text-deltas over STREAM_FLUSH_MS (default 80ms) to avoid one frame per token.
// best-effort: a failed send is logged, not retried — bot/turn-result carries the full text anyway.

const BOT_STREAM_CAP = 'bot-stream/1'

export const STREAM_FLUSH_MS = 80

/**
 * Create a node-side stream forwarder for one bot/turn exchange.
 *
 * @param {object} opts
 * @param {string} opts.exchangeId     — the exchange this stream belongs to
 * @param {string} opts.sessionId      — the Bot's Session on this node (source of agent/assistant-stream)
 * @param {object} opts.ctx            — ds-bot rt.ctx (for session/event listener)
 * @param {string} opts.nodeId
 * @param {string} opts.remoteBotId
 * @param {function} opts.send         — (type, payload) => boolean
 * @param {object} opts.hubCaps        — () => string[] hub capability list (lazy)
 * @param {function} [opts.logger]     — optional logger
 * @param {number}  [opts.flushMs]     — throttle window (default STREAM_FLUSH_MS)
 * @returns {{ finish(): Promise<void> }}
 */
export function createNodeStreamer({ exchangeId, sessionId, ctx, nodeId, remoteBotId, send, hubCaps, logger, flushMs = STREAM_FLUSH_MS }) {
  // Only engage when hub declared the capability.
  const enabled = (() => {
    try { return typeof hubCaps === 'function' && hubCaps()?.includes?.(BOT_STREAM_CAP) === true } catch { return false }
  })()

  if (!enabled || typeof ctx?.on !== 'function') {
    return {
      finish: () => Promise.resolve(),
    }
  }

  let seq = 0
  let buffer = ''
  let closed = false
  let started = false       // the exchange's own user/message seen; events before it are not ours
  let timer

  const flushBuffer = () => {
    timer = undefined
    if (closed || buffer === '') return
    const text = buffer
    buffer = ''
    seq += 1
    try { send('bot/stream', { nodeId, remoteBotId, exchangeId, seq, text }) } catch (err) {
      logger?.warn?.('ds-bot: bot/stream send failed: %s', err?.message ?? err)
    }
  }

  function schedule() {
    if (timer !== undefined || closed) return
    timer = setTimeout(flushBuffer, flushMs)
    timer.unref?.()
  }

  // Listen to the session's stream events.
  const onEvent = (session, event) => {
    if (session?.id !== sessionId || closed) return
    if (event?.type === 'user/message') {
      if (!started && event.data?.source?.rpcId === exchangeId) started = true
      return
    }
    if (!started) return
    if (event?.type !== 'agent/assistant-stream-chunk') return
    const chunk = event.data?.chunk
    if (!chunk || chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return
    buffer += chunk.text
    schedule()
  }

  // agent/assistant-stream fires as a ctx event (not session/event) in some versions.
  // Listen to both paths so we work regardless of version.
  const onStream = ({ agent, frame }) => {
    if (agent?.id !== sessionId || closed) return
    if (!started) return
    if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string' && frame.chunk.text !== '') {
      buffer += frame.chunk.text
      schedule()
    }
  }

  ctx.on('session/event', onEvent)
  ctx.on('agent/assistant-stream', onStream)

  const cleanup = () => {
    ctx.off?.('session/event', onEvent)
    ctx.off?.('agent/assistant-stream', onStream)
    clearTimeout(timer)
    timer = undefined
  }

  return {
    async finish() {
      if (closed) return
      closed = true
      cleanup()
      // Flush any remaining buffer.
      if (buffer !== '') {
        seq += 1
        const text = buffer
        buffer = ''
        try { send('bot/stream', { nodeId, remoteBotId, exchangeId, seq, text, done: true }) } catch (err) {
          logger?.warn?.('ds-bot: bot/stream final send failed: %s', err?.message ?? err)
        }
      } else if (seq > 0) {
        // Send a done marker so the hub knows streaming is complete (even if last batch was empty).
        seq += 1
        try { send('bot/stream', { nodeId, remoteBotId, exchangeId, seq, text: '', done: true }) } catch {}
      }
    },
  }
}

/**
 * Registry of running streamers, keyed by Session id.
 * One `agent/assistant-stream` listener installed at most once.
 */
export function createStreamFeed(rt) {
  const bySession = new Map()
  return {
    start({ sessionId, exchangeId, hubCaps }) {
      if (!rt.ctx || typeof rt.ctx?.on !== 'function') return undefined
      try {
        const caps = typeof hubCaps === 'function' && hubCaps()
        if (!Array.isArray(caps) || !caps.includes(BOT_STREAM_CAP)) return undefined
      } catch { return undefined }

      const streamer = createNodeStreamer({
        exchangeId,
        sessionId,
        ctx: rt.ctx,
        nodeId: rt.nodeId ?? '',
        remoteBotId: '',  // filled in per-send below
        send: rt.send,
        hubCaps,
        logger: rt,
        flushMs: Number.isFinite(rt.nodeStreamFlushMs) ? rt.nodeStreamFlushMs : STREAM_FLUSH_MS,
      })

      let set = bySession.get(sessionId)
      if (!set) { set = new Set(); bySession.set(sessionId, set) }
      set.add(streamer)
      const origFinish = streamer.finish.bind(streamer)
      streamer.finish = async () => {
        set.delete(streamer)
        if (set.size === 0 && bySession.get(sessionId) === set) bySession.delete(sessionId)
        return origFinish()
      }
      return streamer
    },
  }
}
