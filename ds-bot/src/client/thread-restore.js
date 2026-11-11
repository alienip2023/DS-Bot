// DSH restores the main view from its own saved Session id, and a Session reaches
// its list only with the first message. A Thread's Session is made blank, so a
// Thread page the user left is not in the list when the core restores: the core
// falls back to a workspace Session, and the Bot surface then sends that page
// home. This module keeps the Thread page the user actually left under its own
// key (never the core's), admits the blank Session before the list is first read,
// and — if the core restored something else anyway — puts the Thread page back
// only when the Host still says the Thread owns it.
const PAGE_KEY = 'dsh.threads.page'
const text = value => (typeof value === 'string' && value !== '' ? value : undefined)

export function rememberThreadPage(page, storage = globalThis.localStorage) {
  const botId = text(page?.botId)
  const sessionId = text(page?.sessionId)
  if (botId === undefined || sessionId === undefined) return false
  const threadId = text(page?.threadId)
  try {
    storage?.setItem(PAGE_KEY, JSON.stringify(threadId === undefined ? { botId, sessionId } : { botId, threadId, sessionId }))
    return true
  } catch {
    return false
  }
}

export function forgetThreadPage(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(PAGE_KEY)
  } catch {
    // A storage that refuses the write cannot be asked to forget either.
  }
}

export function readThreadPage(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(PAGE_KEY) ?? 'null')
    const botId = text(saved?.botId)
    const sessionId = text(saved?.sessionId)
    if (botId === undefined || sessionId === undefined) return undefined
    const threadId = text(saved?.threadId)
    return threadId === undefined ? { botId, sessionId } : { botId, threadId, sessionId }
  } catch {
    return undefined
  }
}

// The record the core's own create writes for a new Session: with it in the list,
// the initial restore finds the saved Thread Session and opens it directly.
export function admitThreadPage(sessions, storage = globalThis.localStorage) {
  const page = readThreadPage(storage)
  if (page === undefined) return undefined
  const add = sessions?.handleSessionAdded
  if (typeof add !== 'function') return page
  add.call(sessions, { agentAvailable: true, sessionId: page.sessionId, updatedAt: Date.now(), running: false, blank: true })
  return page
}

// After the initial restore: `null` from the Host means the Thread is gone (a
// deleted Thread must not leave a phantom blank page), an answer with a Bot means
// the saved page is still the user's page, and no answer at all is not a reason
// to move a view the user may be reading.
export async function restoreThreadPage({ page, open, ownerOf, forget }) {
  if (page === undefined) return 'none'
  const owner = await Promise.resolve(ownerOf(page.sessionId)).catch(() => undefined)
  if (owner === null) {
    forget?.()
    return 'gone'
  }
  if (owner === undefined) return 'unknown'
  open?.(page.sessionId)
  return 'opened'
}
