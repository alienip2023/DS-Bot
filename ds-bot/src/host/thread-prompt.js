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

async function textOf(content) {
  try {
    // Only text parts can be replayed after a restart.
    return await promptText(Array.isArray(content) ? content.filter(part => part?.type === 'text') : content)
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
    // A steer goes into the turn that is running on this very Session: the core takes it at the
    // next step (the gate is for messages that wait for a turn to end, not for ones that join it).
    if (request.mode === 'steer' && rt.threadQueueLive?.(full.botId)?.running?.sessionId === request.sessionId) {
      const self = this
      // Opt-in (prefs.steerAsk): the user is asked where the message goes; it never blocks.
      if (rt.state?.prefs?.steerAsk === true) {
        const asked = rt.askSteer?.({
          sessionId: request.sessionId, text: await textOf(request.content),
          apply: async (choice) => {
            if (choice === 'independent' || choice === 'related') {
              const message = await textOf(request.content)
              return rt.startTask(request.sessionId, { title: message.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Task', brief: message, relation: choice })
            }
            const next = choice === 'queue' ? { ...request, mode: 'queue' } : request
            return choice === 'queue' ? self.prompt(next, ...rest) : original.call(self, next, ...rest)
          },
        })
        if (asked === true) return { accepted: true }
      }
      return original.call(this, request, ...rest)
    }
    const text = await textOf(request.content)
    return rt.sendThreadTurn({
      botId: full.botId,
      threadId: full.threadId,
      sessionId: request.sessionId,
      requestId: request?.requestId,
      kind: 'send',
      preview: text.slice(0, 120),
      text,
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
