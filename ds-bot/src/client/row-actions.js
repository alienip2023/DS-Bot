// Pure helper: bot-row click dispatch, extracted for testability.
// No React imports — safe to import in Node.js tests.
//
// A joined (remote) Bot opens the main conversation page through the core's own
// openSession path once Bot Home is on AND the Bot already has a local mirror
// session (bot.sessionId). Otherwise the legacy dialog stays as the fallback.

export function botRowClick(joined, id, actions) {
  if (joined) {
    if (actions.botHomeEnabled?.() && actions.botHasHome?.(id)) { actions.openSession(id); return }
    actions.openJoinedChat(id)
    return
  }
  actions.openSession(id)
}
