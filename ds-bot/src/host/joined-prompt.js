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
import { startPageTurn, stopPageTurn, failureText, flushLateReplies } from './executor.js'
import { JOINED_TURN_TIMEOUT_MS } from './joined-turn.js'
import { dropJoinedMirrorQueues, waitForJoinedMirror } from './joined-mirror-writer.js'
import { installRunning } from './joined-running.js'
import { wrapControllerMethod } from './controller-wrap.js'

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
    for (const dispose of rt.joinedLate ?? []) dispose()
    rt.joinedLate?.clear()
    rt.joinedLateQueue?.clear()
    // Buffered Bot-to-Bot page writes cannot be written after unload; warn and drop, never a half turn.
    dropJoinedMirrorQueues(rt)
    delete rt.flushLateReplies
  }, 'ds-bot: joined late reply listeners')
  const controller = ctx?.sessionController
  // The phone's Stop (turns.js stopChat) ends a joined Bot's page turn through the same call.
  rt.stopJoinedTurn = botId => stopPageTurn(rt, botId)
  installCancel(rt, controller)
  installRunning(rt, controller, joinedBotOfSession)
  if (typeof controller?.prompt !== 'function') return
  rt.joinedPromptTasks = new Set()

  wrapControllerMethod(ctx, controller, 'prompt', original => async function (request, ...rest) {
    const bot = joinedBotOfSession(rt, request?.sessionId)
    if (bot === undefined) return original.call(this, request, ...rest)

    const text = await promptText(request.content)
    const session = await ensureMirrorSession(rt, bot)
    // The client retries a prompt it did not hear back on: the same requestId is answered
    // with the same acknowledgement and never sent to the node twice.
    if (hasPromptRequest(session, request.requestId)) return { accepted: true }

    let turn
    try {
      // A Bot-to-Bot exchange may be writing this Session right now; it finishes first, so the
      // page turn never takes a turn someone else has open.
      await waitForJoinedMirror(rt, bot.id, rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS)
      turn = startPageTurn({
        rt, bot, text, requestId: request.requestId, session, state: mirrorStateOf(rt, bot.id, session),
        tracker: rt.turnTracker,
        timeoutMs: rt.joinedTurnTimeoutMs ?? JOINED_TURN_TIMEOUT_MS,
      })
    } catch (error) {
      if (error?.code === 'E_BUSY') throw await remoteError('session/agent-busy', BUSY, { reason: 'JOINED_TURN_IN_FLIGHT' })
      throw await remoteError('session/agent-unavailable', `无法送达节点：${failureText(error)}`, { reason: `JOINED_NODE_${error?.code ?? 'ERROR'}` })
    }
    // The user's message is on the page; the node's answer (or the failure) follows there.
    const task = turn.done
      .catch((error) => { rt.warn?.('ds-bot: joined Bot %s turn failed: %s', bot.id, error?.message ?? error) })
      .finally(() => { rt.joinedPromptTasks.delete(task) })
    rt.joinedPromptTasks.add(task)
    return { accepted: true }
  }, 'ds-bot: joined Bot prompt takeover')
}

// The page's Stop button: client.js (dsh-api-session-controller) cancel() → remote.session.cancel
// → ctx.sessionController.cancel(request) (index.js :4448) → commands.cancel (:1026), which
// looks the Session up in ctx.agents and throws 'session/not-found' for a mirror Session (no
// local Agent lives there). For a joined Bot's mirror Session the Stop ends the page turn
// instead: the wait for the node stops, the in-flight slot is released and the turn closes as
// aborted (startPageTurn's abort). Idempotent — a Stop with nothing in flight is acknowledged.
// Every other Session goes to the original cancel untouched. The node is not told to stop.
function installCancel(rt, controller) {
  wrapControllerMethod(rt.ctx, controller, 'cancel', original => async function (request, ...rest) {
    const bot = joinedBotOfSession(rt, request?.sessionId)
    if (bot === undefined) return original.call(this, request, ...rest)
    stopPageTurn(rt, bot.id)
    return { accepted: true }
  }, 'ds-bot: joined Bot cancel takeover')
}
