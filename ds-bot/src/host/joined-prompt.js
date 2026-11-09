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
import { startPageTurn, stopPageTurn, failureText } from './executor.js'
import { JOINED_TURN_TIMEOUT_MS } from './joined-turn.js'
import { installRunning } from './joined-running.js'

const BUSY = '副机 Bot 正在回复上一条，请稍候再发'
const NO_ATTACHMENTS = '副机 Bot 暂不支持附件，请改为文字发送'

/**
 * The joined Bot whose mirror Session this is. All four must hold, else undefined and the
 * prompt passes through: bySessionId hits a Bot, it is a joined shadow living on a remote
 * node, and the Session is its current mirror Session.
 */
export function joinedBotOfSession(rt, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
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
  // Late-reply listeners (executor.js armLateReply) end with the plugin.
  // Unloading also drops the replies still waiting for an open page turn to end, and nothing
  // new is armed afterwards: a page turn that ends later writes no late reply.
  ctx?.effect?.(() => () => {
    rt.joinedLateClosed = true
    for (const dispose of rt.joinedLate ?? []) dispose()
    rt.joinedLate?.clear()
    rt.joinedLateQueue?.clear()
  }, 'ds-bot: joined late reply listeners')
  const controller = ctx?.sessionController
  // The phone's Stop (turns.js stopChat) ends a joined Bot's page turn through the same call.
  rt.stopJoinedTurn = botId => stopPageTurn(rt, botId)
  installCancel(rt, controller)
  installRunning(rt, controller, joinedBotOfSession)
  const original = controller?.prompt
  if (typeof original !== 'function') return
  rt.joinedPromptTasks = new Set()

  const intercepted = async function (request, ...rest) {
    const bot = joinedBotOfSession(rt, request?.sessionId)
    if (bot === undefined) return original.call(this, request, ...rest)

    const text = await promptText(request.content)
    const session = await ensureMirrorSession(rt, bot)
    // The client retries a prompt it did not hear back on: the same requestId is answered
    // with the same acknowledgement and never sent to the node twice.
    if (hasPromptRequest(session, request.requestId)) return { accepted: true }

    let turn
    try {
      turn = startPageTurn({
        rt, bot, text, requestId: request.requestId, session, state: mirrorStateOf(rt, bot.id),
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
  }

  ctx.effect(() => {
    controller.prompt = intercepted
    return () => { if (controller.prompt === intercepted) controller.prompt = original }
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
  const original = controller?.cancel
  if (typeof original !== 'function') return
  const intercepted = async function (request, ...rest) {
    const bot = joinedBotOfSession(rt, request?.sessionId)
    if (bot === undefined) return original.call(this, request, ...rest)
    stopPageTurn(rt, bot.id)
    return { accepted: true }
  }
  rt.ctx.effect(() => {
    controller.cancel = intercepted
    return () => { if (controller.cancel === intercepted) controller.cancel = original }
  }, 'ds-bot: joined Bot cancel takeover')
}
