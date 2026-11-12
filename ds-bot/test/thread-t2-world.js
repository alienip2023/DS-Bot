// A real runtime (every module installed in index.js order) over an in-memory Session
// host, for the P1-T2 tests. The route handler is the real one from channel.js, and
// `session/event` is dispatched with both arguments like the core does, so the serial
// gate and turns.js see the same events the host would.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

export function threadWorld({ home: givenHome, services } = {}) {
  const routes = []
  const prompts = []
  const followups = []
  const steers = []
  const flushes = []
  const titles = []
  const pageCalls = []
  const archivedSessions = []
  const agents = new Map()
  const createdOptions = []
  const selections = []
  let nextSession = 1
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId, seq: 0, log: [] },
        status: 'idle',
        followup(message) { followups.push({ sessionId, message }) },
        steer(message) { steers.push({ sessionId, message }) },
      })
    }
    return agents.get(sessionId)
  }
  const ctx = fakeContext({ services: services ?? {} })
  ctx.sessionController = {
    async create(options) { const sessionId = `session-${nextSession++}`; createdOptions.push({ sessionId, options }); return { sessionId } },
    async resolveAgent(sessionId) { return { agent: agentOf(sessionId) } },
    async selectModel(request) {
      selections.push(request)
      return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } }
    },
    async prompt(request, signal) { prompts.push({ request, signal }); return { accepted: true } },
    async page(request) { pageCalls.push(request); return { records: [], hasMore: false } },
    async list() { return { items: [] } },
    async cancel() { return { accepted: true } },
  }
  ctx.sessions = { flush: async (session) => { flushes.push(session?.id) } }
  ctx.sessionTitle = { rename: async (session, title) => { titles.push({ sessionId: session?.id, title }) } }
  const workspace = { id: 'ws-1', path: join(tmpdir(), 'ds-bot-t2-team') }
  ctx.workspaceRegistry = {
    get: id => (id === workspace.id ? workspace : undefined),
    resolveByPath: async () => undefined,
    create: async path => ({ id: workspace.id, path }),
    archiveSession: async (sessionId) => { archivedSessions.push(sessionId) },
    unarchiveSession: async () => {},
  }
  ctx.connection.fetch.register = (route) => { routes.push(route); return () => {} }
  const baseEmit = ctx.emit
  ctx.emit = (name, ...args) => {
    if (name !== 'session/event') return baseEmit(name, ...args)
    for (const listener of ctx.listeners.get(name) ?? []) listener(...args)
  }
  const home = givenHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-t2-'))
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload = {}) => {
    const route = routes.find(r => r.path === ROUTE)
    if (route === undefined) throw new Error('the api route is registered')
    const response = await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })
    return JSON.parse(await response.text())
  }
  const sessionEvent = (sessionId, event) => ctx.emit('session/event', { id: sessionId }, event)
  return { home, ctx, rt, call, sessionEvent, prompts, followups, steers, flushes, titles, pageCalls, archivedSessions, agents, agentOf, createdOptions, selections }
}

/** A local Bot with a working model pick (no model call is made). */
export async function makeBot(w, name = 'Alpha') {
  await w.rt.load()
  return w.rt.createBot({ name, pickModel: true })
}
