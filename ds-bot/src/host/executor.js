// executor.js — dispatch a text message to a bot (remote joined or local).
//
// send({ botId, text, rt, tracker?, timeoutMs? })
//   → { ok: true, turnId, text, nodeId?, remoteBotId? }
//   throws ExecutorError with code: E_NOT_FOUND | E_OFFLINE | E_TIMEOUT | E_REJECTED
//
// deliverTurn({ botId, text, rt, session, seenKeys, closedKeys, seenSteps, tracker?, timeoutMs? })
//   — full pipeline: send + mirrorTurn. nodeSeq comes from the bot/turn-result payload.
//   Contract: bot/turn-result does NOT currently carry a nodeSeq (validateBotTurnResult has no seq).
//   S2 must add `seq` to validateBotTurnResult and bot/turn-result frame; until then nodeSeq is null
//   (mirrorTurn skips idempotency when nodeSeq is null). This is a known S2 obligation.

import { randomUUID } from 'node:crypto'
import { joinedShadow } from './roster-join.js'
import { attachmentsOf, forgetAttachments, releaseBytes, sendChunks } from './joined-attachments.js'
import { listenBotTurnResult, JOINED_TURN_TIMEOUT_MS, JOINED_LATE_WINDOW_MS } from './joined-turn.js'

/**
 * Error codes thrown by send() / deliverTurn():
 *   E_NOT_FOUND — bot not registered or missing worker config
 *   E_OFFLINE   — remote node is not reachable or registry unavailable
 *   E_TIMEOUT   — no result within timeout (default JOINED_TURN_TIMEOUT_MS = 600s; config.joinedTurnTimeoutMs)
 *   E_ABORTED   — the page's Stop ended the wait (startPageTurn only; never thrown to a caller of send())
 *   E_REJECTED  — node explicitly rejected the turn (ok:false with error code)
 */
export class ExecutorError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.code = code
    this.name = 'ExecutorError'
  }
}

/**
 * Send text to a bot. When a tracker is supplied, the turn is started before dispatch
 * and finished (done/failed/timeout) on every exit path.
 *
 * @param {object} opts
 * @param {string} opts.botId
 * @param {string} opts.text
 * @param {object} opts.rt
 * @param {object} [opts.tracker]     - createTurnTracker() instance; optional
 * @param {number} [opts.timeoutMs]   - Override default timeout
 * @returns {{ ok: true, turnId: string, text: string, nodeId?: string, remoteBotId?: string }}
 * @throws {ExecutorError}
 */
export async function send({ botId, text, rt, tracker, timeoutMs: timeoutOverride }) {
  // E_INVALID: input validation (S2-1)
  if (!botId || typeof botId !== 'string')
    throw new ExecutorError('E_INVALID', 'botId is required and must be a non-empty string')
  if (text == null || typeof text !== 'string' || text === '')
    throw new ExecutorError('E_INVALID', 'text is required and must be a non-empty string')

  const bot = rt.botOf?.(botId)
  if (!bot) throw new ExecutorError('E_NOT_FOUND', `bot not found: ${botId}`)

  if (joinedShadow(bot)) {
    return await dispatchRemote({ bot, text, rt, tracker, timeoutOverride }).settle()
  }
  return await sendLocal({ bot, text, rt, tracker })
}

// Dispatch is synchronous (no await): the listener is registered, the frame is sent, and
// every refusal that can be known right away (offline, invalid worker, send failed) throws
// before anything is returned. `settle()` then waits for the node's answer and returns the
// send() result or throws an ExecutorError; `cancel()` drops the listener.
function dispatchRemote(args) {
  const prepared = prepareRemote(args)
  prepared.send().catch(() => {})   // a refusal cancels the listener, so settle() ends with E_OFFLINE: not also an unhandled one
  return prepared
}

// prepareRemote does everything dispatch does except put the frame on the wire: validate,
// register the result listener. Its refusals throw before anything is sent; `send()` is the
// one irreversible step (it throws E_OFFLINE when the node does not take the frame), and
// `cancel()` drops the listener of a prepared turn that is never sent.
function prepareRemote({ bot, text, rt, tracker, timeoutOverride, lateWindowMs = 0, onTimeout, mode, requestId }) {
  if (!bot.worker) {
    throw new ExecutorError('E_NOT_FOUND', 'joined shadow missing worker config')
  }
  const nodeId = bot.worker.nodeId
  const remoteBotId = bot.worker.remoteBotId
  if (typeof nodeId !== 'string' || nodeId === '' || typeof remoteBotId !== 'string' || remoteBotId === '') {
    throw new ExecutorError('E_INVALID', 'worker nodeId and remoteBotId must be non-empty strings')
  }

  let registry
  try { registry = rt.ctx?.get?.('remote-agent:registry') } catch {}
  if (!registry || typeof registry.send !== 'function') {
    throw new ExecutorError('E_OFFLINE', 'registry unavailable')
  }

  const turnId = randomUUID()
  // The node puts the page's message into its Bot's chat under this id; the copy of that message on the page goes
  // back to the page's own request id (conv-replica.js), so the composer retires its echo.
  if (typeof requestId === 'string' && requestId !== '') {
    const requests = (rt.joinedRequests ??= new Map())
    requests.set(turnId, requestId)
    if (requests.size > 500) requests.delete(requests.keys().next().value)
    rt.joinedRequestOf ??= id => rt.joinedRequests?.get(id)
  }
  const timeoutMs = Number.isFinite(timeoutOverride) ? timeoutOverride : (rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS)
  const { pending, completion, cancel, received } = listenBotTurnResult(registry, turnId, nodeId, timeoutMs, remoteBotId, { lateWindowMs, onTimeout })

  // A page's deadline is progress only; the generic sweep must not invent a failure later.
  tracker?.start(turnId, bot.id, lateWindowMs > 0 ? { timeoutMs: Infinity } : undefined)

  let sendCalled = false
  // The page's Stop: the wait ends without the failure bookkeeping a cancel() would do.
  let stopped = false
  const send = async () => {
    if (sendCalled) return
    sendCalled = true
    let sent = false
    // The images and files of this message go out first, as bot/attach chunks; the turn names them.
    let attachments
    try {
      const held = attachmentsOf(requestId)
      if (held !== undefined && held.items.length > 0) {
        attachments = await sendChunks(registry, { nodeId, remoteBotId, exchangeId: turnId, items: held.items })
        releaseBytes(requestId)
      }
    } catch (sendErr) {
      cancel()
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', `attachments not sent: ${sendErr?.message ?? sendErr}`)
    }
    try {
      sent = registry.send(nodeId, 'bot/turn', {
        nodeId,
        remoteBotId,
        exchangeId: turnId,
        // The words as the node reads them: a file mentioned by a path on this machine is its plain name now.
        text: attachmentsOf(requestId)?.sendText ?? text ?? '',
        ...(attachments === undefined ? {} : { attachments }),
        // How a busy node Bot takes it (AC 0.4.20+; an older node ignores it and queues).
        ...(mode === 'steer' || mode === 'queue' ? { mode } : {}),
      })
    } catch (sendErr) {
      cancel()
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', `registry.send threw: ${sendErr?.message ?? sendErr}`)
    }

    if (sent !== true) {
      cancel()
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', 'node offline or send failed')
    }
  }

  const settle = async () => {
    let result
    try {
      result = await (lateWindowMs > 0 ? completion : pending)
    } catch {
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', 'listener error')
    }
    if (stopped || (lateWindowMs > 0 && result?.error === 'stopped')) {
      tracker?.finish(turnId, { status: 'failed', error: 'E_ABORTED' })
      throw new ExecutorError('E_ABORTED', 'stopped waiting for the node')
    }

    if (result === undefined) {
      tracker?.finish(turnId, { status: 'timeout', error: 'E_TIMEOUT' })
      throw new ExecutorError('E_TIMEOUT', `no result within ${timeoutMs}ms`)
    }
    if (!result || result.error === 'bridge-down') {
      tracker?.finish(turnId, { status: 'failed', error: 'E_OFFLINE' })
      throw new ExecutorError('E_OFFLINE', result?.error ?? 'bridge-down')
    }
    if (result.error === 'bot-turn-timeout') {
      tracker?.finish(turnId, { status: 'timeout', error: 'E_TIMEOUT' })
      throw new ExecutorError('E_TIMEOUT', 'no answer within the waiting window')
    }
    if (result.ok === false) {
      tracker?.finish(turnId, { status: 'failed', error: 'E_REJECTED' })
      throw new ExecutorError('E_REJECTED', result.error ?? 'bot-turn-rejected')
    }
    // Validate seq field (S2-1 contract: seq must be a non-negative integer)
    if (typeof result.seq !== 'number' || !Number.isInteger(result.seq) || result.seq < 0) {
      tracker?.finish(turnId, { status: 'failed', error: 'E_REJECTED' })
      throw new ExecutorError('E_REJECTED', result.error ?? 'bot-turn-result-seq-missing')
    }

    tracker?.finish(turnId, { status: 'done' })
    return { ok: true, turnId, text: result.text ?? '', nodeId, remoteBotId, seq: result.seq }

  }
  // A prepared turn that is dropped before send(): drop the listener and close the tracker.
  const abandon = () => { cancel(); tracker?.finish(turnId, { status: 'failed', error: 'E_ABANDONED' }) }
  // The user stopped waiting: drop the listener, make a pending settle() throw E_ABORTED (and
  // leave the tracker alone), close the tracker entry as stopped. The frame is already out —
  // the node is not told here (Stop tells it separately).
  const stop = () => {
    stopped = true
    cancel()
    tracker?.finish(turnId, { status: 'failed', error: 'E_ABORTED' })
  }
  return { turnId, nodeId, remoteBotId, send, settle, cancel, abandon, stop, received }
}

async function sendLocal({ bot, text, rt, tracker }) {
  if (!rt.sendUser) throw new ExecutorError('E_NOT_FOUND', 'sendUser not available')
  const sessionId = rt.chatOf?.(bot.id) ?? bot.id
  const turnId = randomUUID()
  tracker?.start(turnId, bot.id)
  const run = async () => {
    try {
      await rt.sendUser({ sessionId, content: [{ type: 'text', text: text ?? '' }], requestId: turnId })
      tracker?.finish(turnId, { status: 'done' })
    } catch (err) {
      tracker?.finish(turnId, { status: 'failed', error: String(err?.code ?? err?.message ?? err) })
      throw err
    }
  }
  // One turn per Bot: a dispatch waits behind whatever that Bot is running (thread-model §4.5).
  if (typeof rt.sendThreadTurn === 'function') {
    const outcome = await rt.sendThreadTurn({
      botId: bot.id,
      sessionId,
      requestId: turnId,
      kind: 'send',
      preview: text ?? '',
      // A joined mirror and a peer shadow both hand off outside this host: the wait ends
      // when the hand-off is accepted, not when the far turn reports back.
      releaseOn: bot.origin === 'joined' || bot.origin === 'peer' ? 'run' : undefined,
      run,
    })
    if (outcome?.queued === true) return { ok: true, turnId, text: text ?? '', queued: true, position: outcome.position }
  } else {
    await run()
  }
  return { ok: true, turnId, text: text ?? '' }
}

const FAILURE_WORDS = {
  E_OFFLINE: '节点离线或不可达',
  E_TIMEOUT: '等了很久，节点也没有回复（它若之后才回复，不会再自动补到这里）',
  E_REJECTED: '节点拒绝了这条消息',
  E_NOT_FOUND: '找不到这个远程 Bot',
  E_INVALID: '消息或 Bot 配置无效',
  E_BUSY: '上一条消息还在处理',
  'bot-attach-incomplete': '附件没有完整送到节点，请重新发送',
  'bot-attach-invalid': '附件在传输中损坏了，请重新发送',
  'bot-attach-no-receiver': '节点上的 ds-bot 版本太旧，不支持附件，请把节点上的 ds-bot 升级到 fork.103 或更新',
  'bot-turn-attachments-invalid': '附件清单没有通过节点的校验，请重新发送',
  'bot-attach-unsupported': '节点存不下这个附件（它的 DeepSeek Harness 没有文件上传服务，或存储失败）',
}
// The reason the node's own core gave for refusing an attachment (details.reason of its prompt), in words.
const ATTACH_REJECTED_WORDS = {
  MODEL_DOES_NOT_SUPPORT_IMAGES: '节点上这个 Bot 当前的模型不支持图片',
  IMAGE_TOO_MANY_PIXELS: '图片像素太多，节点不收',
  IMAGE_DIMENSION_TOO_LARGE: '图片尺寸太大，节点不收',
  IMAGE_TOO_LARGE: '图片太大，节点不收',
  IMAGES_TOO_LARGE: '图片加起来太大，节点不收',
  TOO_MANY_IMAGES: '图片太多，节点不收',
  INVALID_IMAGE: '节点认不出这张图片',
  IMAGE_TYPE_MISMATCH: '图片内容和它的类型对不上',
  UNSUPPORTED_IMAGE_TYPE: '节点不支持这种图片格式',
  FILE_NOT_STAGED: '节点没有收到文件（上传已失效）',
}

/** The words the page shows after "⚠ 无法送达节点：" for a failed delivery. */
export function failureText(err) {
  const code = typeof err?.code === 'string' ? err.code : ''
  const detail = String(err?.message ?? err ?? '')
  // A node's refusal arrives as E_REJECTED with the node's own error name as its detail.
  const rejected = /^bot-attach-rejected:([A-Z_]+)$/.exec(detail)
  if (rejected !== null) return `${ATTACH_REJECTED_WORDS[rejected[1]] ?? `节点拒绝了附件（${rejected[1]}）`}（bot-attach-rejected）`
  const word = FAILURE_WORDS[detail] ?? FAILURE_WORDS[code]
  if (word === undefined) return detail || 'unknown'
  if (FAILURE_WORDS[detail] !== undefined) return `${word}（${detail}）`
  return detail !== '' && detail !== code ? `${word}（${code}: ${detail}）` : `${word}（${code}）`
}

// ── The page of a node Bot: what it sends ──
//
// The page is a copy of the node Bot's own chat (conv-replica.js, work model W4): nothing here writes it. What stays
// here is the control of what the page sends: one page message in flight per Bot (rt.joinedInFlight), a few
// steers next to it (rt.joinedSide), the queue behind them (rt.joinedUserQueue), and Stop.

/** Start the next queued page message of this Bot once nothing is in flight. */
export function flushQueuedMessages(rt, botId) {
  const queue = rt.joinedUserQueue?.get(botId)
  if (!queue || queue.length === 0 || rt.joinedInFlight?.has(botId)) return
  const item = queue.shift()
  if (queue.length === 0) rt.joinedUserQueue.delete(botId)
  try {
    const started = startPageTurn({ rt, bot: rt.botOf(botId), text: item.text, requestId: item.requestId, tracker: rt.turnTracker, timeoutMs: rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS })
    started.sent.catch(error => rt.warn?.('ds-bot: a queued message to %s did not reach the node: %s', botId, failureText(error)))
  } catch (error) {
    // Something took the slot in between: it keeps its place at the front, and the next release tries again.
    if (error?.code === 'E_BUSY') rt.joinedUserQueue.set(botId, [item, ...(rt.joinedUserQueue.get(botId) ?? [])])
    else rt.warn?.('ds-bot: a queued message to %s could not start: %s', botId, failureText(error))
  }
}

const lateWindowOf = rt => (Number.isFinite(rt.joinedLateWindowMs) ? Math.max(1, rt.joinedLateWindowMs) : JOINED_LATE_WINDOW_MS)

// Keep the completion of a page message observed even when its caller no longer awaits it.
function observe(rt, done, label, botId) {
  if (!rt.joinedPromptTasks) rt.joinedPromptTasks = new Set()
  const task = done
    .catch(error => { rt.warn?.('ds-bot: %s for joined Bot %s failed: %s', label, botId, error?.message ?? error) })
    .finally(() => { rt.joinedPromptTasks.delete(task) })
  rt.joinedPromptTasks.add(task)
}

/**
 * Send one page message to the node Bot (one per Bot at a time). Returns { turnId, sent, done }: `sent` settles when
 * the message left (it rejects with the ExecutorError that kept it from going, which the composer shows), `done` when
 * the node answered or the page stopped waiting. The node's chat — the message, the work, the answer — reaches the
 * page as its copy.
 */
export function startPageTurn({ rt, bot, text, requestId, tracker, timeoutMs }) {
  if (!rt.joinedInFlight) rt.joinedInFlight = new Map()
  if (rt.joinedInFlight.has(bot.id)) throw new ExecutorError('E_BUSY', 'a turn for this Bot is still in flight')
  const claim = { requestId, abort: undefined, startedAt: Date.now() }
  rt.joinedInFlight.set(bot.id, claim)
  const release = () => {
    // Only the claim this message took: a second release (Stop, then its own end) must not free a newer one.
    if (rt.joinedInFlight.get(bot.id) !== claim) return
    rt.joinedInFlight.delete(bot.id)
    rt.joinedRunning?.(bot, false)
    flushQueuedMessages(rt, bot.id)
  }
  let prepared
  try {
    // Past the soft deadline it keeps waiting for the node (no clock ends a page message; Stop does).
    prepared = prepareRemote({ bot, text, rt, requestId, tracker, timeoutOverride: timeoutMs, lateWindowMs: lateWindowOf(rt) })
  } catch (error) {
    release()
    forgetAttachments(requestId)   // nothing was sent: its bytes are not needed again
    throw error
  }
  rt.joinedRunning?.(bot, true)
  let over = false
  claim.abort = () => {
    if (over || prepared.received()) return false
    over = true
    prepared.stop()
    release()
    return true
  }
  if (!rt.joinedLate) rt.joinedLate = new Set()
  const dispose = () => claim.abort()
  rt.joinedLate.add(dispose)
  const groups = () => rt.groupSessionsOf?.(bot.id) ?? []
  const sent = prepared.send()
  const done = (async () => {
    try {
      await sent
      try {
        await prepared.settle()
      } catch (error) {
        if (error?.code === 'E_ABORTED') {
          for (const groupSessionId of groups()) rt.failRoomTurn?.(groupSessionId, { code: 'ABORTED', message: 'stopped' })
          return { ok: false, aborted: true, turnId: prepared.turnId }
        }
        throw error
      }
      // A group round waiting on this Bot hears that its turn produced output (no session/event fires for the page).
      for (const groupSessionId of groups()) rt.touchRoomTurn?.(groupSessionId)
      return { ok: true, turnId: prepared.turnId }
    } finally {
      over = true
      rt.joinedLate.delete(dispose)
      forgetAttachments(requestId)
      release()
    }
  })()
  observe(rt, done, 'page message', bot.id)
  return { turnId: prepared.turnId, sent, done }
}

/**
 * The page's Stop on a joined Bot: stop waiting for what the page sent, so the Bot's next message is not refused as
 * in flight (the node is told separately). Returns whether anything was stopped.
 */
export function stopPageTurn(rt, botId) {
  let stopped = rt.joinedInFlight?.get(botId)?.abort?.() === true
  for (const side of [...(rt.joinedSide?.get(botId) ?? [])]) if (side.abort() === true) stopped = true
  return stopped
}

// How many page messages may run on one node Bot at the same time. One more is queued on the hub
// (rt.joinedUserQueue) and starts when a slot frees.
export const JOINED_SIDE_LIMIT = 4

/** Is anything of this joined Bot running on its node for the page (the main message or a steer)? */
export function joinedBusy(rt, botId) {
  return rt.joinedInFlight?.has(botId) === true || (rt.joinedSide?.get(botId)?.size ?? 0) > 0
}

/**
 * A page message to a node Bot that is already busy (a steer): it goes to the node at once, next to the message in
 * flight; the node takes it at its next step. Returns { turnId, sent, done } as startPageTurn does.
 */
export function startSideTurn({ rt, bot, text, requestId, tracker, timeoutMs, mode = 'steer' }) {
  if (!rt.joinedSide) rt.joinedSide = new Map()
  const sides = rt.joinedSide.get(bot.id) ?? new Set()
  if (sides.size >= JOINED_SIDE_LIMIT) throw new ExecutorError('E_BUSY', 'too many concurrent turns for this Bot')
  let prepared
  try {
    prepared = prepareRemote({ bot, text, rt, requestId, tracker, timeoutOverride: timeoutMs, lateWindowMs: lateWindowOf(rt), mode })
  } catch (error) {
    forgetAttachments(requestId)
    throw error
  }
  const record = { requestId, abort: undefined }
  let over = false
  const release = () => {
    if (!sides.delete(record)) return
    if (sides.size === 0) rt.joinedSide.delete(bot.id)
    if (!joinedBusy(rt, bot.id)) rt.joinedRunning?.(bot, false)
    flushQueuedMessages(rt, bot.id)
  }
  sides.add(record)
  rt.joinedSide.set(bot.id, sides)
  rt.joinedRunning?.(bot, true)
  record.abort = () => {
    if (over || prepared.received()) return false
    over = true
    prepared.stop()
    release()
    return true
  }
  if (!rt.joinedLate) rt.joinedLate = new Set()
  const dispose = () => record.abort()
  rt.joinedLate.add(dispose)
  const sent = prepared.send()
  const done = (async () => {
    try {
      await sent
      try {
        await prepared.settle()
      } catch (error) {
        if (error?.code === 'E_ABORTED') return { ok: false, aborted: true, turnId: prepared.turnId }
        throw error
      }
      return { ok: true, turnId: prepared.turnId }
    } finally {
      over = true
      rt.joinedLate.delete(dispose)
      forgetAttachments(requestId)
      release()
    }
  })()
  observe(rt, done, 'steer', bot.id)
  return { turnId: prepared.turnId, sent, done }
}
