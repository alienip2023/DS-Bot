// A node's side of M4 S4: a fake memory link and a fake hub, and a runtime whose Bot
// keeps its memory in the federation backend. The link stands in for ra's
// `remote-agent:memory-link` service; the hub applies what the node sends and answers
// the way the real hub does (one answer per requestId, replayed on a retry).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

export const CAP = 'memory-sync/1'

export const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b1: { id: 'b1', sessionId: 'b1', name: 'One', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2, managedBy: 'hub', memoryConfig: { backend: 'federation' } },
    b2: { id: 'b2', sessionId: 'b2', name: 'Two', role: '代码', model: 'deepseek/v4', instructions: '', createdAt: 3, managedBy: 'hub', memoryConfig: { backend: 'federation' } },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

export function fakeHub() {
  const answers = new Map()
  const hub = {
    entries: new Map(),
    applied: [],
    received: [],
    reads: [],
    silent: false,
    fail: undefined,
    receive(type, payload, reply) {
      hub.received.push({ type, payload })
      if (type === 'mem/hello' || type === 'mem/ack') return
      let answer = answers.get(payload.requestId)
      if (answer === undefined) {
        answer = type === 'mem/write' ? hub.write(payload) : hub.read(payload)
        answers.set(payload.requestId, answer)
      }
      if (hub.silent) return
      const result = hub.fail !== undefined ? { requestId: payload.requestId, ok: false, error: hub.fail } : answer
      queueMicrotask(() => reply(result))
    },
    write(payload) {
      if (hub.applied.some(item => item.requestId === payload.requestId)) {
        return { requestId: payload.requestId, ok: true, seq: hub.applied.length, changed: false }
      }
      const scope = `${payload.scope}:${payload.remoteBotId}`
      const list = hub.entries.get(scope) ?? []
      let changed = false
      if (payload.op === 'add') {
        if (!list.some(entry => entry.text === payload.text)) { list.push({ id: `id-${list.length + 1}`, text: payload.text }); changed = true }
      } else if (payload.op === 'replace') {
        const at = list.findIndex(entry => entry.text.includes(payload.replace))
        if (at !== -1) { list[at] = { ...list[at], text: payload.text }; changed = true }
      } else if (payload.op === 'forget') {
        const at = list.findIndex(entry => entry.text.includes(payload.replace))
        if (at !== -1) { list.splice(at, 1); changed = true }
      }
      hub.entries.set(scope, list)
      if (changed) hub.applied.push({ requestId: payload.requestId, op: payload.op, scope: payload.scope, remoteBotId: payload.remoteBotId, text: payload.text })
      return { requestId: payload.requestId, ok: true, seq: hub.applied.length, changed, ...(payload.op === 'add' && changed ? { id: `id-${payload.requestId.slice(0, 4)}` } : {}) }
    },
    read(payload) {
      const scope = `${payload.scope}:${payload.remoteBotId}`
      const list = payload.scope === 'node' || payload.scope === 'team' ? (hub.entries.get(scope) ?? hub.entries.get(payload.scope === 'team' ? 'team:team' : scope) ?? []) : (hub.entries.get(scope) ?? [])
      hub.reads.push(payload)
      const entries = payload.query === undefined ? list : list.filter(entry => entry.text.toLowerCase().includes(String(payload.query).toLowerCase()))
      return { requestId: payload.requestId, ok: true, seq: hub.applied.length, entries }
    },
  }
  return hub
}

export function fakeLink({ online = false, hub = fakeHub(), caps = [CAP] } = {}) {
  const handlers = new Map()
  let up = online
  let applied = () => 0
  const link = {
    sent: [],
    get isOnline() { return up },
    get appliedSeq() { return applied() },
    on(type, fn) {
      let set = handlers.get(type)
      if (set === undefined) { set = new Set(); handlers.set(type, set) }
      set.add(fn)
      return () => { set.delete(fn) }
    },
    send(type, payload) {
      link.sent.push({ type, payload })
      if (!up) return false
      if (!link.hubSupportsMemory()) return false
      try { hub.receive(type, payload, answer => deliver(answer.type ?? guess(type), answer)) } catch { return false }
      return true
    },
    online() { up = true; return link.send('mem/hello', { appliedSeq: applied() }) },
    offline() { up = false },
    setAppliedSeq(fn) { if (typeof fn === 'function') applied = fn },
    announce() { return link.online() },
    hubSupportsMemory: () => caps.includes(CAP),
    deliver,
    goUp() { up = true },
    goDown() { up = false },
    get hub() { return hub },
  }
  function guess(type) {
    return type === 'mem/write' ? 'mem/write-result' : type === 'mem/read' ? 'mem/read-result' : type
  }
  function deliver(type, payload) {
    for (const fn of [...(handlers.get(type) ?? [])]) fn(payload)
  }
  return link
}

export function snapshot(seq, { team = '', node = '', bots = {}, truncated = false } = {}) {
  return { seq, team, node, bots, ...(truncated ? { truncated: true } : {}) }
}

export function startNode({ home = mkdtempSync(join(tmpdir(), 'ds-bot-m4node-')), link = fakeLink(), nodeId = 'n1', state = TEAM, warnings = [], config = {} } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const services = {
    'remote-agent:memory-link': link,
    'remote-agent:node-policy': { nodeId, roots: [] },
  }
  const ctx = fakeContext({ services })
  ctx.logger.warn = (...args) => warnings.push(args.map(value => String(value)).join(' '))
  const rt = createRuntime(ctx, { home, ...config })
  let loaded
  const load = () => (loaded ??= rt.load())
  const tool = (name, args, sessionId = 'b1') => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const section = (sessionId = 'b1') => ctx.sections.get('bot-memory').text({ agent: { id: sessionId } })
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, home, link, warnings, load, tool, section, stop }
}

export const settle = () => new Promise(resolve => setTimeout(resolve, 20))
