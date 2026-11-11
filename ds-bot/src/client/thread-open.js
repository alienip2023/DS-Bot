import { t } from './i18n.js'

export const threadOpenFailure = () => new Error(t('Could not open this Thread’s conversation. Try again in a moment.'))

// A Session reaches DSH's list with its first message, and a Thread's Session is made blank,
// so a Thread row created a moment ago has no list entry for the core's opener to find. The
// Host did make it: put the record the core's own create writes for a new Session into the
// list, then read the list once more before calling the open a failure. A failure is shown —
// a click that changes nothing reads as a broken row.
export function threadSessionOpener({ sessions, open, report }) {
  const listed = sessionId => sessions.list.getSnapshot().byId?.[sessionId] !== undefined
  const admit = (sessionId) => {
    const add = sessions.handleSessionAdded
    if (typeof add !== 'function') return
    add.call(sessions, { agentAvailable: true, sessionId, updatedAt: Date.now(), running: false, blank: true })
  }
  const refresh = () => Promise.resolve(sessions.refresh?.()).then(() => true, () => false)
  return async function openThreadSession(sessionId) {
    if (!listed(sessionId)) admit(sessionId)
    if (!listed(sessionId)) await refresh()
    if (!listed(sessionId)) {
      report(threadOpenFailure())
      return false
    }
    open(sessionId)
    return true
  }
}
