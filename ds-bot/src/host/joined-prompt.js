// joined-prompt.js — Bot Home takeover of the page's input box (S2-4 contract).
//
// A joined (remote) Bot's page is its local mirror Session, and the page's composer sends
// through the core's ctx.sessionController.prompt, which would start a LOCAL model turn on
// that Session. This wrapper stands in front of prompt: a prompt aimed at a joined Bot's
// mirror Session is not passed on; its text goes to the node instead, the user's message is
// on the page at once and the answer — or a visible failure — is written when the node is
// done. Every other Session (ordinary Bots, group chats, agents) goes to the original
// prompt untouched.
//
// Shape (dsh-api-session-controller lib/index.js): prompt(request, signal) at :4413 with
// request { requestId, sessionId, mode?, content: Part[], clientTimeZone? } — Part is
// {type:'text',text} | {type:'image',…} | {type:'file',receiptId}; the acknowledgement is
// { accepted: true } (:899, :937); a repeated requestId is acknowledged, not re-run (:899);
// refusals are structured RemoteErrors (isDSHRemoteError + code), a bare Error becomes
// 'gateway/internal'. The composer's toast (dsh-client-ui-conversation lib/client.js:21754)
// is `${message} (${code})` except for the two attachment-invalid codes.
import { joinedShadow } from './roster-join.js'
import { ensureMirrorSession, mirrorStateOf, hasPromptRequest } from './mirror.js'
import { startPageTurn, startSideTurn, stopPageTurn, failureText, flushLateReplies } from './executor.js'
import { JOINED_TURN_TIMEOUT_MS } from './joined-turn.js'
import { dropJoinedMirrorQueues, waitForJoinedMirror, mirrorTurnOpen } from './joined-mirror-writer.js'
import { installRunning } from './joined-running.js'
import { wrapControllerMethod } from './controller-wrap.js'
import { sendBotAction } from './node-cards.js'
import { nodeCan } from './node-compat.js'
import { stopOnNode } from './joined-turn.js'
import { collectPrompt, stashAttachments } from './joined-attachments.js'
import { writeNodeReport } from './executor.js'
import { STOP_NOTE_MARK } from './mirror.js'

const BUSY = '副机 Bot 正在回复上一条，请稍候再发'
const NO_ATTACHMENTS = '副机 Bot 暂不支持附件，请改为文字发送'

/**
 * The joined Bot whose Session this is. The Session resolves through the full index to the
 * Thread it runs in; that Thread must itself be the Session, and its Bot must be a joined
 * shadow living on a remote node (docs/thread-model.md §10 A2). A runtime without the
 * thread index (an older host, a test double) falls back to the Bot's current mirror
 * Session, so the prompt path keeps working there.
 */
export function joinedBotOfSession(rt, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (typeof rt.bySessionIdFull === 'function' && typeof rt.threadOf === 'function') {
    const owner = rt.bySessionIdFull(sessionId)
    const bot = owner === undefined ? undefined : rt.botOf?.(owner.botId)
    const thread = owner === undefined ? undefined : rt.threadOf(owner.threadId)
    if (thread !== undefined) {
      return joinedShadow(bot) && bot.worker?.home === 'remote' && thread.sessionId === sessionId ? bot : undefined
    }
    // A Bot created after this file was loaded has no Thread row yet (T2 creates one as the
    // Bot is created). Its own Session is still its Main thread's Session, so it keeps
    // routing as before instead of losing its page until the next load.
    return joinedShadow(bot) && bot.worker?.home === 'remote' && bot.sessionId === sessionId ? bot : undefined
  }
  const bot = rt.bySessionId?.(sessionId)
  return joinedShadow(bot) && bot.worker?.home === 'remote' && bot.sessionId === sessionId ? bot : undefined
}

// A structured refusal the client shows. The core's RemoteError is used where it can be
// loaded; otherwise an Error with the same identity fields (isDSHRemoteError + code).
export async function remoteError(code, message, details) {
  try {
    const { RemoteError } = await import('@deepseek-ai/dsh-typert-protocol')
    if (typeof RemoteError === 'function') return new RemoteError(code, message, details)
  } catch {}
  return Object.assign(new Error(message), { name: 'RemoteError', code, details, isDSHRemoteError: true })
}

/** The text of a prompt's parts; an image or a file part is refused in v1. */
export async function promptText(content) {
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  if (parts.some(part => part?.type !== 'text')) {
    // Not 'session/attachment-invalid': the composer renders that code through
    // attachmentErrorText(), which only knows the core's image reasons and turns any other
    // one into "image send failed: <constant>". Our own code takes the generic toast
    // `${message} (${code})`, so the user reads NO_ATTACHMENTS.
    throw await remoteError('session/joined-attachment-unsupported', NO_ATTACHMENTS, { reason: 'JOINED_ATTACHMENT_UNSUPPORTED' })
  }
  return parts.map(part => String(part.text ?? '')).join('\n')
}

/** collectPrompt, with its refusal in the shape the page reads (a RemoteError with a code). */
async function collectPromptOrReject(rt, bot, content, ids) {
  try {
    return await collectPrompt(rt, bot, content, ids)
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('session/joined-attachment')) {
      throw await remoteError(error.code, error.message, { reason: 'JOINED_ATTACHMENT_UNSUPPORTED' })
    }
    throw error
  }
}

export function install(rt) {
  const { ctx } = rt
  // The Bot-to-Bot writer closes turns in joined-mirror-writer.js; when a late node answer is
  // waiting behind that turn it re-arms itself through this hook (the writer must not import
  // the executor, which already imports the writer).
  rt.flushLateReplies = botId => flushLateReplies(rt, botId)
  // Late-reply listeners (executor.js armLateReply) end with the plugin.
  // Unloading also drops the replies still waiting for an open page turn to end, and nothing
  // new is armed afterwards: a page turn that ends later writes no late reply.
  ctx?.effect?.(() => () => {
    rt.joinedLateClosed = true
    rt.joinedLateQueue?.clear()
    // Stop active page waits only after deferred writes have been dropped.
    dropJoinedMirrorQueues(rt)
    for (const dispose of rt.joinedLate ?? []) dispose()
    rt.joinedLate?.clear()
    delete rt.flushLateReplies
  }, 'ds-bot: joined late reply listeners')
  const controller = ctx?.sessionController
  // The phone's Stop (turns.js stopChat) ends a joined Bot's page turn through the same call.
  // Stop ends the wait on this host AND tells the node, as for a local Bot the work really ends. A node that
  // cannot be reached or does not answer is said so on the page, not left looking stopped.
  const stopReasons = { 'bridge-down': '节点不在线', 'no-answer': '节点没有回应（它的 AC 可能版本较旧）', 'no-remote-identity': '没有节点身份' }
  const tellNodeToStop = (botId) => {
    const bot = rt.botOf?.(botId)
    if (!joinedShadow(bot) || bot.worker?.home !== 'remote') return
    void stopOnNode(rt, bot).then(async (result) => {
      if (result.ok) return
      const session = await ensureMirrorSession(rt, bot)
      writeNodeReport({ rt, bot, session, state: mirrorStateOf(rt, bot.id, session), mark: STOP_NOTE_MARK, text: `没能让节点停下：${stopReasons[result.error] ?? result.error ?? '未知原因'}。它可能仍在运行。` })
    }).catch(error => rt.warn?.('ds-bot: telling the node to stop %s failed: %s', botId, error?.message ?? error))
  }
  rt.tellNodeToStop = tellNodeToStop
  rt.stopJoinedTurn = (botId, { notifyNode = true } = {}) => {
    const stopped = stopPageTurn(rt, botId)
    if (notifyNode) tellNodeToStop(botId)
    return stopped
  }
  installCancel(rt, controller)
  installRunning(rt, controller, joinedBotOfSession)
  if (typeof controller?.prompt !== 'function') return
  rt.joinedPromptTasks = new Set()

  wrapControllerMethod(ctx, controller, 'prompt', original => async function (request, ...rest) {
    const bot = joinedBotOfSession(rt, request?.sessionId)
    if (bot === undefined) return original.call(this, request, ...rest)

    // The words and, for a node Bot, the images / files of the message (refused with the reason when they cannot go).
    const prompt = await collectPromptOrReject(rt, bot, request.content, { sessionId: request.sessionId, requestId: request.requestId })
    const text = prompt.text
    stashAttachments(request.requestId, prompt.collected)
    const session = await ensureMirrorSession(rt, bot)
    if (hasPromptRequest(session, request.requestId)) return { accepted: true }

    const timeoutMs = rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS
    // isBusy: a page turn is already in-flight on this Bot's mirror Session.
    // A Bot-to-Bot exchange is NOT considered busy here — waitForJoinedMirror
    // below blocks until the exchange turn is closed, so the page starts after.
    const isBusy = () => rt.joinedInFlight?.has(bot.id) === true

    // mode: 'steer' means "join the turn in flight": the message goes to the node now, as a bot/turn
    // carrying mode 'steer', and the node's Bot takes it at its next step.
    // mode: 'queue' (default) means "wait until the current turn ends, then run".
    // Both are accepted immediately (accepted: true) — the user is never blocked.
    const mode = request.mode === 'steer' ? 'steer' : 'queue'

    const hold = () => {
      if (!rt.joinedUserQueue) rt.joinedUserQueue = new Map()
      const q = rt.joinedUserQueue.get(bot.id) ?? []
      q.push({ text, requestId: request.requestId, session, state: mirrorStateOf(rt, bot.id, session) })
      rt.joinedUserQueue.set(bot.id, q)
    }
    const steerNow = () => startSideTurn({ rt, bot, text, requestId: request.requestId, session, state: mirrorStateOf(rt, bot.id, session), tracker: rt.turnTracker, timeoutMs, mode: 'steer' })
    if (isBusy() && mode === 'steer' && rt.state?.prefs?.steerAsk === true) {
      // Opt-in: ask where it goes (never blocks; unanswered, it steers). Only the composer reaches this.
      const asked = rt.askSteer?.({
        sessionId: request.sessionId, text,
        apply: async (choice) => {
          if (choice === 'queue') return hold()
          if (choice === 'independent' || choice === 'related') return sendBotAction(rt, bot, 'task-start', { text, relation: choice })
          try { steerNow() } catch (error) { if (error?.code === 'E_BUSY') hold(); else throw error }
        },
      })
      if (asked === true) return { accepted: true }
    }
    if (isBusy()) {
      // Steer: the message goes to the node now and joins the turn there (the node's Bot takes it at
      // its next step, in the same Session with its whole context). Queue: it waits here until the
      // turn in flight ends — queue means wait, on a node as on this host.
      // A node without bot-turn-mode would queue a steer on its side anyway: hold it here, honestly as a queue.
      if (mode === 'steer' && rt.joinedConcurrent !== false && nodeCan(rt, bot, 'steer')) {
        try {
          startSideTurn({ rt, bot, text, requestId: request.requestId, session, state: mirrorStateOf(rt, bot.id, session), tracker: rt.turnTracker, timeoutMs, mode: 'steer' })
          return { accepted: true }
        } catch (error) {
          if (error?.code !== 'E_BUSY') throw await remoteError('session/agent-unavailable', `无法送达节点：${failureText(error)}`, { reason: `JOINED_NODE_${error?.code ?? 'ERROR'}` })
        }
      }
      if (!rt.joinedUserQueue) rt.joinedUserQueue = new Map()
      const q = rt.joinedUserQueue.get(bot.id) ?? []
      q.push({ text, requestId: request.requestId, session, state: mirrorStateOf(rt, bot.id, session) })
      rt.joinedUserQueue.set(bot.id, q)
      return { accepted: true }
    }

    try {
      await waitForJoinedMirror(rt, bot.id, timeoutMs)
      startPageTurn({
        rt, bot, text, requestId: request.requestId, session,
        state: mirrorStateOf(rt, bot.id, session),
        tracker: rt.turnTracker,
        timeoutMs,
      })
    } catch (error) {
      if (error?.code === 'E_BUSY') {
        if (!rt.joinedUserQueue) rt.joinedUserQueue = new Map()
        const q = rt.joinedUserQueue.get(bot.id) ?? []
        q.push({ text, requestId: request.requestId, session, state: mirrorStateOf(rt, bot.id, session) })
        rt.joinedUserQueue.set(bot.id, q)
        return { accepted: true }
      }
      throw await remoteError('session/agent-unavailable', `无法送达节点：${failureText(error)}`, { reason: `JOINED_NODE_${error?.code ?? 'ERROR'}` })
    }
    return { accepted: true }
  }, 'ds-bot: joined Bot prompt takeover')
}

// The page's Stop button: client.js (dsh-api-session-controller) cancel() → remote.session.cancel
// → ctx.sessionController.cancel(request) (index.js :4448) → commands.cancel (:1026), which
// looks the Session up in ctx.agents and throws 'session/not-found' for a mirror Session (no
// local Agent lives there). For a joined Bot's mirror Session the Stop ends the page turn
// instead: the wait for the node stops, the in-flight slot is released and the turn closes as
// aborted (startPageTurn's abort). Idempotent — a Stop with nothing in flight is acknowledged.
// The node is told to stop too (bot/stop). Every other Session goes to the original cancel untouched.
function installCancel(rt, controller) {
  wrapControllerMethod(rt.ctx, controller, 'cancel', original => async function (request, ...rest) {
    const bot = joinedBotOfSession(rt, request?.sessionId)
    if (bot === undefined) return original.call(this, request, ...rest)
    rt.stopJoinedTurn(bot.id)
    return { accepted: true }
  }, 'ds-bot: joined Bot cancel takeover')
}
