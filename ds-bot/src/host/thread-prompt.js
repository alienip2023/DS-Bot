// thread-prompt.js — put the serial gate in front of the core's prompt entry.
//
// channel.js, executor.js and delivery.js already hand their turns to `rt.sendThreadTurn`;
// this wrapper covers the one entry they cannot: a prompt made directly on the session
// controller (the DSH conversation composer and our own follow-up paths). It is installed
// outermost, after joinedPrompt, so a joined mirror still takes its own path first.
//
// Two ways a prompt is already admitted:
//   · the request object came through `createSendUser`, which wrapped the whole turn in
//     `sendThreadTurn` and then marked the request — gating it again would deadlock the
//     turn behind itself;
//   · the Session is not a Thread of any Bot (a plain DSH Session, a room) — not ours.
import { wrapControllerMethod } from './controller-wrap.js'
import { joinedBotOfSession, promptText } from './joined-prompt.js'

/** Abort listener bookkeeping lives with the queue entries; only the preview is read here. */
async function previewOf(request) {
  try {
    return (await promptText(request?.content)).slice(0, 120)
  } catch {
    // An attachment or an unreadable payload is the prompt's own error to raise.
    return ''
  }
}

/**
 * @param {object} rt
 */
export function install(rt) {
  const { ctx } = rt
  const controller = ctx?.sessionController
  if (typeof controller?.prompt !== 'function') return
  // Requests that already went through the gate (createSendUser builds them) must pass
  // straight to the Session; a WeakSet keeps them without holding the request alive.
  const admitted = new WeakSet()
  rt.markThreadPromptAdmitted = (request) => {
    if (request !== null && typeof request === 'object') admitted.add(request)
  }

  wrapControllerMethod(ctx, controller, 'prompt', original => async function (request, ...rest) {
    if (request === undefined || admitted.has(request)) return original.call(this, request, ...rest)
    const full = rt.bySessionIdFull?.(request?.sessionId)
    if (full === undefined) return original.call(this, request, ...rest)
    // A joined Bot answers through its node turn; joinedPrompt owns that path and its
    // accepted-without-done semantics must not wait behind the local gate.
    if (joinedBotOfSession(rt, request.sessionId) !== undefined) return original.call(this, request, ...rest)
    const thread = rt.threadOf?.(full.threadId)
    if (thread === undefined) return original.call(this, request, ...rest)
    const preview = await previewOf(request)
    return rt.sendThreadTurn({
      botId: full.botId,
      threadId: full.threadId,
      sessionId: request.sessionId,
      requestId: request?.requestId,
      kind: 'send',
      preview,
      // A prompt resolves as soon as the Session accepts it, so 'run' would not queue at
      // all; the turn's own end releases the Bot.
      releaseOn: 'turn-end',
      signal: rest[0],
      run: () => original.call(this, request, ...rest),
    })
  }, 'ds-bot: thread prompt gate')

  // Stop clears what that Session has waiting too, before the turn itself is cancelled.
  // The core's cancel throws when no agent runs; a message we just dropped is still a
  // successful stop from the user's side.
  wrapControllerMethod(ctx, controller, 'cancel', original => async function (request, ...rest) {
    const dropped = rt.dropThreadQueueSession?.(request?.sessionId) ?? 0
    try {
      return await original.call(this, request, ...rest)
    } catch (error) {
      if (dropped > 0 && (error?.code === 'session/not-found' || /session\/not-found/.test(String(error?.message ?? '')))) {
        return { accepted: true }
      }
      throw error
    }
  }, 'ds-bot: thread prompt cancel')

  // A disposed Session is never going to send its turn/end; let its slot and its queued
  // messages go. A page closing is not a disposal — its turn keeps running.
  ctx.on('session/disposed', (session) => {
    rt.dropThreadQueueSession?.(session?.id, { release: true })
  })
}
