// Pure helper: bot-row click dispatch, extracted for testability.
// No React imports — safe to import in Node.js tests.
//
// A joined (remote) Bot's page is its local mirror session, opened through the core's own
// openSession; actions.openJoinedHome makes sure that session exists first and reports a
// failure where the user can see it. The old dialog (openJoinedChat) is no longer a path.

export function botRowClick(joined, id, actions) {
  if (joined) { actions.openJoinedHome(id); return }
  actions.openSession(id)
}
