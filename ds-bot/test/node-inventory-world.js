// Shared world for the M2 node-inventory tests: a real runtime, real store and a real
// channel route; only the registry is a small EventEmitter standing in for the plugin
// service, because that service is provided by dsh-remote-agent at run time.
import EventEmitter from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

export const NODE = 'n1'
export const nodeId = (name) => name

export function seedTeam(overrides = {}) {
  const bots = {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    ...(overrides.bots ?? {}),
  }
  return {
    version: 2,
    mainBotIds: ['a'],
    bots,
    threads: {},
    rooms: {},
    agents: {},
    sections: [],
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    works: {},
    requests: {},
    prefs: { nodeInventory: true },
    nodeInventory: { lastError: null, appliedAt: 0 },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'bots')),
  }
}

export async function startWorld(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-node-inventory-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      // A node row has no local Session: asking for one must fail like the core does.
      create: async () => ({ sessionId: 'unused' }),
      resolveAgent: async (sessionId) => { throw new Error(`session "${sessionId}" not found`) },
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  const registry = new EventEmitter()
  registry.nodes = new Map()
  const frames = []
  registry.send = (nodeName, type, payload) => { frames.push({ nodeId: nodeName, type, payload }); return true }
  const get = ctx.get.bind(ctx)
  ctx.get = key => (key === 'remote-agent:registry' ? registry : get(key))
  await rt.load()
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async () => {
    for (const id of Object.keys(rt.state?.works ?? {})) rt.dropWork(id)
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, registry, frames, call, stop, home }
}

export const settle = async (times = 8) => { for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve)) }

export function inventory(over = {}) {
  return { nodeId: NODE, hostname: 'box-1', enabled: true, bots: [], at: 1000, ...over }
}

export const NODE_BOT = `node:${NODE}:b1`
