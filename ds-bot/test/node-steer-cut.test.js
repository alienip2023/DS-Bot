// A steer that cuts a model call must not strand the hub exchange the cut turn had taken: the turn that follows answers
// every message either turn took (a hub exchange is settled by the turn that answers it, not by the one that began it).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as toolExecutorNative from '@deepseek-ai/dsh-tool-executor-native'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as toolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import ToolRuntime, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { install as installSteer } from '../src/host/steer.js'
import { turnOf } from '../src/host/resume.js'
import { fakeContext } from './fake-ctx.js'
import { SOURCE_KIND, STEER_CUT } from '../src/host/constants.js'

// A user steer in a private Bot chat detaches a running shell call into a
// promoted job and cuts a running model call, so the steer is claimed at once.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

const SHELL_SCHEMA = { oneOf: [
  { properties: { kind: { const: 'foreground' }, exitCode: {} } },
  { properties: { kind: { const: 'promoted' }, cwd: {}, jobId: {}, timeoutMs: {}, output: {} } },
  { properties: { kind: { const: 'background' }, jobId: {} } },
] }

const shellDef = (name = 'pwsh') => {
  const calls = []
  return {
    calls,
    name,
    description: 'shell',
    output: {
      schema: SHELL_SCHEMA,
      render: (args, value) => [{ type: 'text', text: `exit ${value?.exitCode ?? '?'} out:${value?.stdout?.text ?? ''}` }],
    },
    execute: (args) => new Promise((res, rej) => { calls.push({ args, res, rej }) }),
  }
}

const jobsService = (read) => ({ read })

const start = async ({ services = {}, def = shellDef() } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-steer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const agentMap = new Map()
  const deliveries = []
  const inboxOf = () => {
    const nextStep = []
    const nextTurn = []
    return { nextStep, nextTurn,
      prepend: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).unshift(m),
      append: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).push(m),
      remove: mid => { for (const l of [nextStep, nextTurn]) { const at = l.findIndex(m => m.id === mid); if (at !== -1) { l.splice(at, 1); return true } } return false },
    }
  }
  const calls = []
  const agentOf = (id, over = {}) => {
    const inbox = inboxOf()
    const agentListeners = new Map()
    const agent = {
      id,
      session: { id, header: { cwd: '/team' } },
      ctx: {
        tools: { register: t => (calls.push(['register', t]), () => {}), restrict: () => () => {} },
        on: (event, fn) => {
          calls.push(['on', event, fn])
          const list = agentListeners.get(event) ?? []
          list.push(fn)
          agentListeners.set(event, list)
          return () => {
            const at = list.indexOf(fn)
            if (at !== -1) list.splice(at, 1)
          }
        },
        effect: execute => execute?.(),
      },
      agentListeners,
      status: 'running',
      followup: msg => calls.push(['followup', msg]),
      inject: msg => calls.push(['inject', msg]),
      send: (msg, target) => inbox[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(msg),
      cancel: (cause, options) => calls.push(['cancel', cause, options]),
      inbox,
      ...over,
    }
    agentMap.set(id, agent)
    return agent
  }
  const agentById = agentOf('dm-a')
  ctx.tools.register({ ...def })
  ctx.tools.schemas = () => [{ name: 'pwsh' }, { name: 'bash' }, { name: 'ask_user_question' }]
  ctx.tools.get = (name) => (name === def.name ? def : undefined)
  ctx.tools.executable = (name) => (name === def.name ? def : undefined)
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => ({ id: 'w1', path: '/team' }), list: () => [{ id: 'w1', path: '/team' }], resolveByPath: async () => undefined, create: async p => ({ id: 'w1', path: p }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'dm-a' }), resolveAgent: async () => ({ agent: agentById }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const origGet = ctx.get
  let apiRoute
  ctx.connection.fetch.register = (route) => { apiRoute = route; return () => {} }
  Object.assign(ctx, { get: name => (name === 'agents' ? agentMap : origGet(name)) })
  const rt = createRuntime(ctx, { home })
  await rt.load?.()
  const call = async (endpoint, payload) => {
    const response = await apiRoute.fetch({ json: async () => ({ endpoint, payload }) })
    return response.json()
  }
  const origDeliver = rt.deliver
  rt.deliver = (...args) => { deliveries.push(args); return origDeliver ? origDeliver(...args) : Promise.resolve() }
  const emit = async (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) await listener({ id }, { type, data })
    }
    await new Promise(r => setTimeout(r, 0))
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  const shadowOf = (target = agentById) => {
    const handler = (target.agentListeners?.get('tools/execute') ?? []).at(-1)
    if (handler === undefined) return undefined
    return {
      calls: def.calls,
      async execute(args, exec) {
        const dispatchExec = { ...exec, arguments: args }
        const res = await handler(dispatchExec, async () => ({ isError: false, value: await def.execute(args, dispatchExec) }))
        if (res?.isError) {
          const err = new Error(res.error?.message ?? 'tool error')
          if (res.error?.code) err.code = res.error.code
          throw err
        }
        return res?.value
      },
    }
  }
  return { ctx, emit, stop, rt, agent: agentById, agentMap, calls, deliveries, shadowOf, call }
}


test('a steer cut in the model phase: both the first hub exchange and the steer are settled by the turn that answers', async () => {
  const { emit, stop, rt } = await start()
  const settled = []
  rt.settleJoinedTurn = (id, text, error) => { settled.push([id, text, error?.code]); return true }
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', { content: [{ type: 'text', text: 'A' }], source: { kind: 'user', rpcId: 'A' } })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half' }] } })
  rt.markSteerCut(dm)                       // what steer.js maybeCut does before agent.cancel
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(settled, [], 'the cut turn answers nobody: its work carries over')
  await emit(dm, 'turn/start', { turn: 2 })
  await emit(dm, 'user/message', { content: [{ type: 'text', text: 'B' }], source: { kind: 'user', rpcId: 'B' } })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } })
  await emit(dm, 'turn/end', { reason: { kind: 'completed' } })
  assert.deepEqual(settled.map(([id]) => id).sort(), ['A', 'B'], 'both exchanges get the answer')
  assert.ok(settled.every(([, text]) => text.includes('all done')))
  await stop()
})
