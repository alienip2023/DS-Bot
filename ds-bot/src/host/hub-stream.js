// hub-stream.js — the HUB side of bot/stream: a node Bot's answer text, arriving as incremental
// bot/stream frames, written into the Bot's mirror Session while the turn is open so the page
// renders it token-by-token instead of waiting for the final bot/turn-result.
//
// A StreamSink belongs to one exchange. It accumulates text and writes mirrorTurnStream on each
// new frame, so the page always shows the latest text. When mirrorTurnFinish runs (from executor.js)
// it writes the authoritative final text, overwriting the accumulated stream text — so a lost frame
// or reorder only affects the live preview, never the settled answer.

import { mirrorTurnStream } from './mirror.js'
import { deferMirrorWrite } from './joined-mirror-writer.js'

/**
 * Open a stream sink for one bot/turn exchange on the hub side.
 * Mirrors the structure of openTraceSink in hub-trace.js.
 *
 * @param {object} rt
 * @param {object} opts
 * @param {object} opts.bot
 * @param {string} opts.exchangeId
 * @param {string} opts.nodeId
 * @param {object} [opts.binding]  — { session, turn, step } to write into immediately; may be deferred
 * @returns {object|undefined} sink, or undefined when streaming is unavailable/unsupported
 */
export function openStreamSink(rt, { bot, exchangeId, nodeId, binding }) {
  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  if (typeof registry?.on !== 'function' || typeof exchangeId !== 'string' || exchangeId === '') return undefined

  // Check hub caps: only engage when AC on this node declared bot-stream/1.
  // We check the registry's hub caps that were sent in welcome (what the node sees).
  // If we can't tell, still open the sink — a node that doesn't send bot/stream frames
  // just means the sink stays idle and disposes cleanly.

  const owner = nodeId ?? bot?.worker?.nodeId
  let session, turn, step
  let closed = false
  let accumulated = ''
  let seqSeen = 0
  const sink = {}

  const write = (text) => {
    if (!session || closed) return
    try {
      mirrorTurnStream(session, { turn, step: step ?? 1, text })
    } catch (err) {
      rt.warn?.('ds-bot: hub-stream write failed: %s', err?.message ?? err)
    }
  }

  const onStream = (frame) => {
    if (closed || frame?.exchangeId !== exchangeId) return
    if (frame.nodeId && owner && frame.nodeId !== owner) return
    if (typeof frame.text !== 'string') return
    // Seq ordering: skip frames that arrive out of order below the last seen.
    // We don't hold/reorder like hub-trace — stream is best-effort.
    if (Number.isInteger(frame.seq) && frame.seq <= seqSeen) return
    seqSeen = frame.seq ?? seqSeen
    accumulated += frame.text
    write(accumulated)
  }

  registry.on('botStream', onStream)

  const dispose = () => {
    closed = true
    registry.off?.('botStream', onStream)
    rt.joinedLate?.delete(dispose)
  }
  if (!rt.joinedLate) rt.joinedLate = new Set()
  rt.joinedLate.add(dispose)

  Object.assign(sink, {
    /** Bind to an open mirror turn so stream frames write into it. */
    bind({ session: s, turn: t, step: st }) {
      if (closed) return
      session = s; turn = t; step = st ?? 1
      // Write any text already received before bind().
      if (accumulated !== '') write(accumulated)
    },
    /** Clean up: stop listening. The final answer is written by mirrorTurnFinish. */
    dispose,
  })

  if (binding !== undefined) sink.bind(binding)
  return sink
}
