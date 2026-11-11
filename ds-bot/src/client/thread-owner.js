// thread-owner.js — "does this Session belong to a Bot's Thread?", asked to the Host.
//
// The sidebar only learns a Bot's Threads when its row is expanded, so after a page
// reload or an app restart the cache is empty: a Thread page would look exactly like
// an empty outside Session, and the landing check would send it home to the Main Bot.
// The Host knows every Thread Session from its state, so the answer survives a reload.
import { call } from './api.js'

/**
 * A resolver over the read-only `thread-owner` endpoint. It answers:
 *  - `{ botId, threadId }` when the Session is one of a Bot's Threads (and remembers it),
 *  - `null` when the Host is sure no Thread owns it,
 *  - `undefined` when the question could not be asked — the caller must not send the
 *    view home on a guess.
 */
export function threadOwnerResolver({ request = call, remember = () => {} } = {}) {
  return async function threadOwnerOfSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    let result
    try {
      result = await request('thread-owner', { sessionId })
    } catch {
      return undefined
    }
    const botId = result?.botId
    if (typeof botId !== 'string' || botId === '') return null
    remember(sessionId, botId, result?.threadId)
    return { botId, threadId: typeof result.threadId === 'string' ? result.threadId : null }
  }
}
