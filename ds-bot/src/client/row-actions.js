// Pure helper: bot-row click dispatch, extracted for testability.
// No React imports — safe to import in Node.js tests.
//
// A joined (remote) Bot's page is its local mirror session, opened through the core's own
// openSession; actions.openJoinedHome makes sure that session exists first and reports a
// failure where the user can see it. The old dialog (openJoinedChat) is no longer a path.

// A row whose Bot lives on another machine: a joined row (mirror Session here). It opens
// through openJoinedHome because it has no local Session of its own.
export function remoteHomeOf(bot) {
  if (bot === null || typeof bot !== 'object') return false
  return bot.origin === 'joined' && bot.worker?.home === 'remote'
}

export function botRowClick(joined, id, actions) {
  if (joined) { actions.openJoinedHome(id); return }
  actions.openSession(id)
}
