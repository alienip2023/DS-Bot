// hub-trace.js — the HUB side of bot/trace: a node Bot's thinking and tool steps, written into the Bot's mirror
// Session in the events a local turn writes, so its page shows the "思考过程" row and the tool steps like a local
// Bot's page does (the page renders Session events; it cannot tell where they came from).
//
// What arrives (AC's `botTrace` registry event, one per bot/trace frame; see node-trace.js for the item shapes):
//   { nodeId, remoteBotId, exchangeId, seq, final?, items: [{ i, t: 'a' | 'r', … }], omitted?, clipped? }
//
// A TraceSink belongs to one exchange. It keeps the steps by their index `i`, which is what makes everything
// idempotent and ordered: a step with an `i` already applied (a replayed or duplicated frame) writes nothing,
// steps that come ahead of a missing one wait for it, and the `final` frame (the node's whole list, sent before
// the result) fills any hole a lost batch left. A TraceWriter writes the steps of an open mirror turn:
//
//   step n:  assistant/message { reasoning?, tool-call… }, tool/call…, tool/result…, step/end
//   …
//   last step:  the answer, written by mirror.js (mirrorTurnFinish / Fail / Abort), with the reasoning the node
//               had before it (a model step that called no tool: item.end) as a reasoning block in front.
//
// close() ends whatever is open: a tool call that never got its result is answered with an error result, the
// open step is ended, and the number of the step the closing message goes in is returned — so a turn that ends
// by a stop, a failure or a lost link never leaves a step or a thinking block dangling.
//
// The mirror Session holds ONE open turn; a sink writes only into the turn it was bound to (a page turn, a
// Bot-to-Bot exchange, or — when the exchange had to wait behind another turn — the turn written for it later).
// A steer that joined a page turn already open has no sink of its own: the node's events of that turn,
// steer included, come in that page turn's trace. A steer that is written as a turn of its own gets its steps
// inside that turn (executor.startSideTurn).
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { mirrorLateReply } from './mirror.js'
import { deferMirrorWrite } from './joined-mirror-writer.js'
import { AC_NEEDED, NODE_FEATURES, nodeCan, nodeCapsOf } from './node-compat.js'

const SOURCE = { kind: 'model', provider: 'mirror', model: 'mirror-proxy' }
export const TRACE_NOTE_MARK = '⚠ 思考过程'
export const NO_RESULT_TEXT = '（节点没有回传这个工具的结果）'
const omittedText = count => `⚠ 节点省略了 ${count} 个步骤（超出显示上限），下面是最终回答。`

class TraceWriter {
  constructor({ session, turn, step = 1, warn }) {
    Object.assign(this, { session, turn, step, warn, stepUsed: false, calls: new Map(), held: undefined, broken: false })
  }

  write(item) {
    if (this.broken) return
    try {
      if (item.t === 'a') this.assistant(item)
      else if (item.t === 'r') this.result(item)
    } catch (error) {
      this.broken = true
      this.warn?.('ds-bot: the steps of a node turn stopped being written: %s', error?.message ?? error)
    }
  }

  // End the step in progress: a tool call of it that never got its result gets an error result first,
  // so no step is left with a call nobody answered.
  endStep() {
    for (const [id, call] of this.calls) if (!call.answered && call.step === this.step) this.settle(id, { ok: false, out: NO_RESULT_TEXT })
    this.session.append('step/end', { turn: this.turn, step: this.step })
  }

  // The first model step uses the step the turn opened with; each later one opens its own.
  openStep() {
    if (!this.stepUsed) return
    this.endStep()
    this.step += 1
    this.session.append('step/start', { turn: this.turn, step: this.step })
    this.stepUsed = false
  }

  message(content) {
    this.session.append('assistant/message', {
      turn: this.turn, step: this.step,
      message: createAssistantMessage({ content, source: SOURCE }),
      stream: [],   // required by dsh-session assertAssistantSettlementShape
    }, { surfaceOp: 'append' })
    this.stepUsed = true
  }

  flushHeld() {
    if (this.held === undefined) return
    const { think } = this.held
    this.held = undefined
    this.openStep()
    this.message([{ type: 'reasoning', text: think }])
  }

  assistant(item) {
    this.flushHeld()
    const calls = Array.isArray(item.calls) ? item.calls : []
    // A step that called no tool is the one the answer comes from: its thinking waits for the answer's message.
    if (item.end === true || calls.length === 0) {
      if (typeof item.think === 'string' && item.think !== '') this.held = { think: item.think }
      return
    }
    this.openStep()
    const content = []
    if (typeof item.think === 'string' && item.think !== '') content.push({ type: 'reasoning', text: item.think })
    for (const call of calls) content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.args })
    this.message(content)
    for (const call of calls) {
      const event = this.session.append('tool/call', { turn: this.turn, step: this.step, callId: call.id, name: call.name, arguments: call.args })
      this.calls.set(call.id, { seq: event.seq, step: this.step, answered: false })
    }
  }

  settle(id, { ok, out }) {
    const call = this.calls.get(id)
    if (call === undefined || call.answered) return
    call.answered = true
    this.session.append('tool/result', {
      turn: this.turn, step: call.step,
      message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: out ?? '' }], isError: ok === false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  }

  result(item) {
    const call = this.calls.get(item.id)
    // A result for a step that is already over cannot be written into it (the node sends them in order, so this is a stray).
    if (call === undefined || call.step !== this.step) return
    this.settle(item.id, { ok: item.ok !== false, out: typeof item.out === 'string' ? item.out : '' })
  }

  /** End everything open. Returns { step, reasoning }: where the closing message goes, and the thinking that leads it. */
  close({ omitted = 0 } = {}) {
    if (!this.broken) {
      try {
        if (omitted > 0) { this.openStep(); this.message([{ type: 'text', text: omittedText(omitted) }]) }
        if (this.stepUsed) {
          this.endStep()
          this.step += 1
          this.session.append('step/start', { turn: this.turn, step: this.step })
          this.stepUsed = false
        }
      } catch (error) {
        this.broken = true
        this.warn?.('ds-bot: the steps of a node turn were not closed cleanly: %s', error?.message ?? error)
      }
    }
    return { step: this.step, reasoning: this.held?.think }
  }
}

/**
 * Open the sink of one node exchange (undefined when the node cannot send traces, or there is no registry).
 * Attach it BEFORE the frame that starts the exchange goes out. `binding` ({ session, turn, step, closedTurns })
 * is given when the turn is already open on the page; otherwise call bind() when it is written.
 */
export function openTraceSink(rt, { bot, exchangeId, nodeId, binding }) {
  if (!nodeCan(rt, bot, 'trace')) return undefined
  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch { registry = undefined }
  if (typeof registry?.on !== 'function' || typeof exchangeId !== 'string' || exchangeId === '') return undefined
  const owner = nodeId ?? bot?.worker?.nodeId
  const pending = new Map()     // steps not applied yet, by index
  let applied = 0               // every step up to this index is written (or skipped as a hole, see pump)
  let writer
  let closed = false
  let omitted = 0
  let result
  const sink = { finalSeen: false, frames: 0 }

  const pump = (force) => {
    if (writer === undefined) return
    for (;;) {
      let next = pending.get(applied + 1)
      if (next === undefined && force && pending.size > 0) {
        // A hole the node's whole list could not fill (it was past the cap): go on after it, the page says so.
        const later = Math.min(...pending.keys())
        next = pending.get(later)
        applied = later - 1
      }
      if (next === undefined) return
      pending.delete(next.i)
      applied = next.i
      writer.write(next)
    }
  }

  const onTrace = (frame) => {
    if (closed || frame?.exchangeId !== exchangeId) return
    if (frame.nodeId && owner && frame.nodeId !== owner) return
    sink.frames += 1
    if (Number.isSafeInteger(frame.omitted) && frame.omitted > omitted) omitted = frame.omitted
    for (const item of Array.isArray(frame.items) ? frame.items : []) {
      if (!Number.isSafeInteger(item?.i) || item.i <= applied || pending.has(item.i)) continue   // a repeat: nothing is written twice
      pending.set(item.i, item)
    }
    if (frame.final === true) sink.finalSeen = true
    pump(frame.final === true)
  }
  registry.on('botTrace', onTrace)

  const dispose = () => {
    closed = true
    registry.off?.('botTrace', onTrace)
    rt.joinedLate?.delete(dispose)
  }
  if (!rt.joinedLate) rt.joinedLate = new Set()
  rt.joinedLate.add(dispose)   // the plugin unloading drops the listener

  Object.assign(sink, {
    /** Start writing into the open turn. Steps that came earlier are written now, in order. */
    bind({ session, turn, step = 1, closedTurns }) {
      if (writer !== undefined || closed) return
      writer = new TraceWriter({ session, turn, step, warn: (...args) => rt.warn?.(...args) })
      void closedTurns
      pump(false)
    },
    /** The step the turn is in (where a progress line may go). */
    step: () => writer?.step,
    /** Close the trace: ends open steps and returns { step, reasoning } for the closing message. Repeatable. */
    close() {
      if (result !== undefined) return result
      if (!closed) pump(true)
      dispose()
      result = writer === undefined ? { step: binding?.step ?? 1 } : writer.close({ omitted })
      return result
    },
    bindAndClose(binding) {
      sink.bind(binding)
      return sink.close()
    },
    dispose,
  })
  if (binding !== undefined) sink.bind(binding)
  return sink
}

// ── The notice: the page says once per Bot why it shows no thinking ───────────────────────────────

const noted = new WeakMap()
const noteOnce = (rt, key) => {
  let set = noted.get(rt)
  if (set === undefined) { set = new Set(); noted.set(rt, set) }
  if (set.has(key)) return false
  set.add(key)
  return true
}

/** What the page tells the user when a node's answer came without its thinking, or undefined when nothing is amiss. */
export function traceGap(rt, bot, sink) {
  const caps = nodeCapsOf(rt, bot?.worker?.nodeId)
  if (caps === undefined) return undefined
  if (!caps.has(NODE_FEATURES.trace.cap)) {
    return { key: 'old-node', text: `节点上的 AC 版本太旧，这个 Bot 的页面看不到它的思考过程和工具步骤（只有最终回答）。请把节点升级到 AC ${AC_NEEDED}。` }
  }
  if (sink !== undefined && sink.finalSeen !== true) {
    return { key: 'no-trace', text: '这一轮没有收到节点发来的思考过程和工具步骤，页面只有最终回答。节点与主控的 AC 版本可能不一致（都需要 AC ' + AC_NEEDED + ' 或更新），或链路中途丢了帧。' }
  }
  return undefined
}

/**
 * After a node turn was answered: if its thinking could not be shown, say so on the Bot's page — once per Bot and
 * reason (so a node that stays old does not repeat it every turn), as a marked line after any turn that is open.
 */
export function noteTraceGap(rt, bot, sink, { session, state = {} } = {}) {
  try {
    const gap = traceGap(rt, bot, sink)
    if (gap === undefined || session === undefined || !noteOnce(rt, `${bot.id}:${gap.key}`)) return false
    return deferMirrorWrite(rt, bot.id, () => {
      try { mirrorLateReply(session, { botText: gap.text, botId: bot.id, mark: TRACE_NOTE_MARK, closedTurns: state.closedTurns }) }
      catch (error) { rt.warn?.('ds-bot: the note about missing node steps was not written: %s', error?.message ?? error) }
    })
  } catch { return false }
}
