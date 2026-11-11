// thread-target.js — pure decisions for the sidebar's Thread list.
//
// Kept free of React and of the api module so the rules can be tested in Node: which
// Threads the list shows and in what order, whether another one may be created, and
// where a Thread row opens.

/** Main first, then creation order; the sort is stable for Threads of one stamp. */
export function sortThreads(threads) {
  return [...threads].sort((a, b) => {
    const main = (b?.isMain === true ? 1 : 0) - (a?.isMain === true ? 1 : 0)
    if (main !== 0) return main
    return (a?.createdAt ?? 0) - (b?.createdAt ?? 0)
  })
}

/** Archived Threads still count toward the limit, they are just not drawn. */
export function canCreateThread(threads, max = 10) {
  return threads.length < max
}

/**
 * Where a Thread row goes: Main is the Bot page (`openSession(botId)`); a Thread with
 * a Session of its own is the plain DSH Session page; a Main whose Bot has no chat yet
 * falls back to the Bot page too.
 */
export function threadTargetOf(thread, botId) {
  if (thread === undefined || thread === null) return { kind: 'bot', id: botId }
  if (thread.isMain === true) return { kind: 'bot', id: botId }
  if (typeof thread.sessionId !== 'string' || thread.sessionId === '') return { kind: 'bot', id: botId }
  return { kind: 'session', id: thread.sessionId }
}
