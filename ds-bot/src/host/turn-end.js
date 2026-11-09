// turn-end.js — the one place that builds the `reason` of a turn/end event ds-bot writes into a
// mirror Session.
//
// The shapes are the core's (dsh-session TurnEndReasonMap, packages/core/session/src/types.ts:196-234):
//   completed    { kind: 'completed' }
//   aborted      { kind: 'aborted', reason: TurnEndCancelCause }      <- `reason` is REQUIRED; cause kind is
//                  user | parent | disposed | legacy | hook (hook carries `reason: string`)
//   error        { kind: 'error', error: { message, code } }          <- LlmFailure; `code` is a required string
//   interrupted  { kind: 'interrupted' }                             <- "a crash-orphaned turn closed after the fact"
// Readers depend on them: ui-chat endFailure() reads `reason.reason.kind` for aborted
// (conversation-nodes/turn-error.ts:35-44) and throws on a bare `{kind:'aborted'}`, which stops the whole
// chat rebuild; the SDK's validatedTurnEndReason (sdk/client/src/api.ts:305) rejects it too; resume.js and
// steer.js read `reason.reason.kind` as well.
//
// Which cause for what:
//   user stopped waiting for the node         -> aborted / user        (the core's own cause for the Stop button)
//   dangling turn closed before a new one     -> interrupted           (the core's marker for a turn that never ended)
//   node result already written (duplicate)   -> aborted / hook with DUPLICATE_RESULT as its reason string
//                                                (a plugin closing a turn without a failure; nothing is shown)
//   failure                                   -> error with a code; 'UNKNOWN' is the core's own fallback code
//   `disposed` is never used: resume.js reads aborted/disposed as "DSH shut down mid-turn, pick it up again".

/** The `reason` string of the hook-cause that closes a turn whose node result was already written. */
export const DUPLICATE_RESULT = 'ds-bot/duplicate-node-result'

export const turnEnd = Object.freeze({
  completed: () => ({ kind: 'completed' }),
  stopped: () => ({ kind: 'aborted', reason: { kind: 'user' } }),
  duplicateResult: () => ({ kind: 'aborted', reason: { kind: 'hook', reason: DUPLICATE_RESULT } }),
  interrupted: () => ({ kind: 'interrupted' }),
  error: (message, code) => ({
    kind: 'error',
    error: { message: String(message ?? 'unknown'), code: typeof code === 'string' && code !== '' ? code : 'UNKNOWN' },
  }),
})
