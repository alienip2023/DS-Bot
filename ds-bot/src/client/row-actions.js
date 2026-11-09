// Pure helper: bot-row click dispatch, extracted for testability.
// No React imports — safe to import in Node.js tests.

export function botRowClick(joined, id, actions) {
  if (joined) { if (actions.botHomeEnabled?.()) { actions.openAgent(id); return } actions.openJoinedChat(id); return }
  actions.openSession(id)
}
