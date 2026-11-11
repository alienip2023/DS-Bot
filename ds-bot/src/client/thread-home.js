// Bot mode's view must hold a team conversation; an outside Session wears the
// Bot skin without one. At a cold start the Thread cache is empty, so a Session
// neither the roster nor the cache recognizes is put to the Host before it is
// treated as an outside one — and a question that could not be asked is not an
// answer, so the view stays rather than bouncing on a guess.
export function threadHomeGuard({ roster, mainView, threadBotOfSession, threadOwnerOf, openSession }) {
  return async function homeToMainBot() {
    const snapshot = roster.getSnapshot()
    if (!snapshot.ready || !snapshot.mainBotId) return
    const main = mainView()
    // A Thread page belongs to a Bot: it is a team conversation, never an outside
    // Session the Bot surface would be wrong for.
    if (threadBotOfSession(main) !== undefined) return
    if (main === undefined) return
    if (snapshot.byId[main] !== undefined || snapshot.roomsById[main] !== undefined) return
    const owner = await Promise.resolve(threadOwnerOf(main)).catch(() => undefined)
    // null is the Host's answer that nothing owns it; a Thread, or no answer at
    // all, is a reason to stay.
    if (owner !== null) return
    // The user may have moved on while the question was in flight.
    if (mainView() !== main) return
    openSession(snapshot.mainBotId)
  }
}
