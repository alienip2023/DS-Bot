// Shared fixture of the joined-prompt tests: a real install(rt) on a controller stand-in with
// real Session events (test/joined-prompt.test.js, test/joined-stop-real.test.js).
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import { install } from '../src/host/joined-prompt.js'
import { createTurnTracker } from '../src/host/turn-tracker.js'

const { Session } = await import('@deepseek-ai/dsh-session')

export function makeWorld({ sessionId = 'mirror-1', bot: botOverrides = {}, sendResult = true, sendThrows = false, noRegistry = false, failAppendOn, timeoutMs, botHomeEnabled, tracker = false, cancelImpl, listItems: listItemsOpt, otherBots = [] } = {}) {
  const emitter = new EventEmitter()
  const frames = []
  const sessions = new Map()
  const created = []
  const bySession = new Map()
  const originalCalls = []
  const cancelCalls = []
  const emitted = []
  const listeners = []
  const listItems = listItemsOpt ?? [
    { sessionId: 'mirror-1', running: false, updatedAt: 1, agentAvailable: false },
    { sessionId: 'ordinary-1', running: false, updatedAt: 2, agentAvailable: true },
    { sessionId: 'ordinary-2', running: true, updatedAt: 3, agentAvailable: true },
  ]
  const listResult = { items: listItems }
  const listCalls = []
  const warnings = []
  let seq = 0
  const registry = {
    send: (nodeId, type, payload) => {
      if (sendThrows) throw new Error('socket closed')
      if (sendResult !== true) return false
      frames.push({ nodeId, type, payload })
      return true
    },
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
  }
  const bot = {
    id: 'joined:n1:rb1', name: 'Joined', origin: 'joined', type: 'remote-worker',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true },
    ...(sessionId === null ? {} : { sessionId }),
    ...botOverrides,
  }
  const sessionOf = (sid) => {
    if (!sessions.has(sid)) {
      const created = new Session(sid)
      if (failAppendOn !== undefined) {
        const append = created.append.bind(created)
        created.append = (type, ...rest) => { if (type === failAppendOn) throw new Error('disk full'); return append(type, ...rest) }
      }
      sessions.set(sid, created)
    }
    return sessions.get(sid)
  }
  // more joined Bots on the same node (each with its own mirror Session)
  const bots = [bot, ...otherBots.map((over, index) => ({
    id: `joined:n1:rb${index + 2}`, name: `Joined ${index + 2}`, origin: 'joined', type: 'remote-worker',
    worker: { nodeId: 'n1', remoteBotId: `rb${index + 2}`, home: 'remote', online: true },
    sessionId: `mirror-${index + 2}`, ...over,
  }))]
  for (const each of bots) if (each.sessionId) bySession.set(each.sessionId, each)
  const originalResult = { accepted: true, from: 'original' }
  const disposers = []
  const rt = {
    ...(botHomeEnabled === undefined ? {} : { botHomeEnabled }),
    ctx: {
      get: key => (key === 'remote-agent:registry' && !noRegistry ? registry : undefined),
      sessionController: {
        prompt: async (...args) => { originalCalls.push(args); return originalResult },
        // the core's cancel throws session/not-found for a Session with no live Agent (a mirror Session)
        cancel: async (...args) => { cancelCalls.push(args); return cancelImpl ? cancelImpl(...args) : { accepted: true, from: 'original-cancel' } },
        list: async (...args) => { listCalls.push(args); return listResult },
      },
      emit: (...args) => { emitted.push(args) },
      on: (name, fn) => { listeners.push({ name, fn }); return () => {} },
      effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    },
    state: { revision: 1, bots: Object.fromEntries(bots.map(each => [each.id, each])) },
    botOf: id => bots.find(each => each.id === id),
    bySessionId: sid => bySession.get(sid),
    updateBySessionId: (botId, oldSid, newSid) => { if (oldSid) bySession.delete(oldSid); if (newSid) bySession.set(newSid, bots.find(each => each.id === botId)) },
    chatOf: botId => bots.find(each => each.id === botId)?.sessionId ?? botId,
    createSession: async () => { const sid = `mirror-new-${created.length}`; created.push(sid); sessionOf(sid); return sid },
    resolveAgent: async sid => ({ session: sessionOf(sid) }),
    load: async () => {},
    save: async () => {},
    warn: (...args) => { warnings.push(args) },
    ...(tracker ? { turnTracker: createTurnTracker() } : {}),
    ...(timeoutMs === undefined ? {} : { joinedTurnTimeoutMs: timeoutMs }),
  }
  const originals = { ...rt.ctx.sessionController }
  install(rt)
  const reply = (index, patch = {}) => emitter.emit('botTurnResult', { exchangeId: frames[index].payload.exchangeId, ok: true, text: 'node says hi', seq: seq++, ...patch })
  const idle = () => Promise.all([...(rt.joinedPromptTasks ?? [])])
  const prompt = (request, signal = new AbortController().signal) => rt.ctx.sessionController.prompt(request, signal)
  const cancel = (sessionId = 'mirror-1') => rt.ctx.sessionController.cancel({ sessionId })
  const added = summary => { for (const { name, fn } of listeners) if (name === 'api-session/added') fn(summary) }
  const statuses = () => emitted.filter(args => args[0] === 'api-session/status').map(args => [args[1], args[2]])
  return { rt, bot, bots, frames, created, originalCalls, originalResult, cancelCalls, warnings, reply, idle, prompt, cancel, sessionOf, emitter, disposers, emitted, statuses, listeners, added, listResult, listItems, listCalls, originals, controller: rt.ctx.sessionController }
}

export const textRequest = (text, requestId = 'req-1', sessionId = 'mirror-1') => ({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] })
export const types = session => session.log.map(event => event.type)
