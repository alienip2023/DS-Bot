// Does the Host's own session list hold this session? Asked directly because the core's client
// list cannot say whether its last pull worked: `refresh()` resolves even when session.list fails
// (it only sets an internal list state, which the public list snapshot leaves out), and its
// `list` snapshot is {ids, byId, phase, projectionsBySession} — no state, no error.
//
// remote.session.list({}) is the same call the core makes; it answers { ok, value: { items } } or
// { ok: false, error }, and a transport failure may throw.
// Returns true or false, or undefined when the Host's list could not be read (so nothing can be said),
// or null when there is no way to ask (the service is not there).
export async function hostHasSession(remote, sessionId, note = () => {}) {
  if (typeof remote?.list !== 'function') return null
  try {
    const result = await remote.list({})
    if (result?.ok !== true || !Array.isArray(result.value?.items)) return undefined
    return result.value.items.some(item => item?.sessionId === sessionId)
  } catch (error) {
    note(error)
    return undefined
  }
}

/**
 * The three reads teamActions needs about the core's session list, wired to one context.
 * `refreshSessions` answers false when the core's refresh was REJECTED; a resolved refresh is
 * not a success signal (see above), so it answers true there and `hostHasSession` decides.
 */
export function sessionProbes(ctx, note = () => () => {}) {
  return {
    sessionListed: id => ctx.sessions.list.getSnapshot().byId?.[id] !== undefined,
    refreshSessions: () => Promise.resolve(ctx.sessions.refresh?.()).then(() => true, error => { note('refresh sessions')(error); return false }),
    hostHasSession: id => hostHasSession(ctx.get('remote.session'), id, note('read session list')),
  }
}
