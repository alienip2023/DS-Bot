// DS-3: the optional approval binding on the wire. Optional wiring, never enforcement:
// a missing binding takes the legacy path; a given one is only a stale-card guard.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { adapters } from '../src/host/im/platforms/index.js'
import { threadWorld, makeBot } from './thread-t2-world.js'

// member-status.js needs React; bundle it with stubs as member-status.test.js does. A missing
// export fails test 9 only (the bundle itself is built lazily inside the test).
async function loadMemberStatus() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/member-status.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => {
      const react = { createContext: initial => ({ value: initial }), useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn, useId: () => 'id', useSyncExternalStore: (_s, get) => get(), createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, Fragment: 'fragment' }
      const platform = { react, 'react-dom': {}, '@deepseek-ai/dsh-client-ui-primitives': {} }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  })
  return module.exports
}

function bench(callImpl) {
  const sent = []
  const call = callImpl ?? (async (name, body) => { sent.push([name, body]); return { ok: name } })
  const wrapped = async (name, body) => { sent.push([name, body]); return call(name, body) }
  const after = promise => promise.then(value => value)
  const ui = createSource({ settings: null, menu: 'open', palette: null, newChat: null })
  const actions = teamActions({ call: callImpl ? wrapped : call, after, partFor: id => id, roster: createSource({}), ui })
  return { actions, sent }
}

test('7 request body carries binding when given', async () => {
  const { actions, sent } = bench()
  await actions.answerApproval('i', 'allow', { sessionId: 's', fingerprint: 'f' })
  assert.deepEqual(sent, [['approval-answer', { id: 'i', choice: 'allow', binding: { sessionId: 's', fingerprint: 'f' } }]])
})

test('8 request body is exactly {id, choice} when binding is absent', async () => {
  const { actions, sent } = bench()
  await actions.answerApproval('i', 'reject')
  assert.deepEqual(sent, [['approval-answer', { id: 'i', choice: 'reject' }]])
  assert.equal(Object.hasOwn(sent[0][1], 'binding'), false)
})

async function openApproval(w, bot) {
  const request = w.ctx.listeners.get('approval/request')[0]({ agent: { session: { id: w.rt.chatOf(bot.id) } }, toolName: 'shell', callId: 'c1', reason: 'r', signal: new AbortController().signal }, () => new Promise(() => {}))
  const state = await w.call('state')
  const row = state.value.work.approvals.at(-1)
  assert.ok(row?.fingerprint, 'the view row carries the fingerprint')
  return { request, row }
}

test('8b host resolution: missing and null binding take the legacy path', async () => {
  for (const extra of [{}, { binding: null }]) {
    const w = threadWorld()
    const bot = await makeBot(w)
    const { request, row } = await openApproval(w, bot)
    const res = await w.call('approval-answer', { id: row.id, choice: 'allow', ...extra })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(await request, 'allowed-once')
  }
})

test('8c host resolution: wrong binding is ok:false bot/stale and the row stays', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const { row } = await openApproval(w, bot)
  const res = await w.call('approval-answer', { id: row.id, choice: 'allow', binding: { sessionId: 'x', fingerprint: row.fingerprint } })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'bot/stale')
  assert.equal(w.rt.approvalsView().length, 1)
  assert.equal(w.rt.approvalsView()[0].answerable, true)
  const good = await w.call('approval-answer', { id: row.id, choice: 'reject', binding: { sessionId: row.sessionId, fingerprint: row.fingerprint } })
  assert.equal(good.ok, true)
})

test('9 approvalBinding(row) needs both non-empty string fields and reads only the row', async () => {
  const { approvalBinding } = await loadMemberStatus()
  assert.deepEqual(JSON.parse(JSON.stringify(approvalBinding({ id: 'i', sessionId: 's', fingerprint: 'f', extra: 1 }))), { sessionId: 's', fingerprint: 'f' })
  for (const row of [undefined, null, {}, { sessionId: 's' }, { fingerprint: 'f' }, { sessionId: '', fingerprint: 'f' }, { sessionId: 's', fingerprint: '' }, { sessionId: 1, fingerprint: 'f' }, { sessionId: 's', fingerprint: {} }])
    assert.equal(approvalBinding(row), undefined, JSON.stringify(row))
})

test('10 client: a host stale reaches the caller as a rejection', async () => {
  const { actions } = bench(async () => { throw Object.assign(new Error('x'), { code: 'bot/stale' }) })
  await assert.rejects(actions.answerApproval('i', 'allow', { sessionId: 's', fingerprint: 'f' }), { code: 'bot/stale' })
})

// The IM start() helper is copied minimally from im.test.js (not imported from a test file).
test('11 IM answer path still calls rt.answerApproval without a binding', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-wire-'))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const ctx = fakeContext({ services: {} })
  const prompts = []
  const agents = new Map()
  const agentOf = id => { if (!agents.has(id)) agents.set(id, { id, session: { id, requestHeader: () => undefined }, followup() {}, cancel() {}, inbox: { nextStep: [], nextTurn: [], remove: () => false }, async whenIdle() {} }); return agents.get(id) }
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: { prompt: async (request) => { prompts.push(request); return { ok: true } }, resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessions: { flush: async () => {} },
  })
  const sent = []
  const fake = {
    id: 'fake', handlers: null,
    async check() { return { account: { id: 'bot1', name: '@fakebot' } } },
    connect(fields, env, handlers) {
      fake.handlers = handlers
      handlers.onStatus({ state: 'ready', account: { id: 'bot1', name: '@fakebot' } })
      return { send: async (chat, body) => { sent.push({ chat, ...body }); return { messageId: sent.length } }, edit: async () => {}, typing: async () => {}, stop: () => {} }
    },
  }
  const real = adapters.telegram
  adapters.telegram = fake
  const rt = createRuntime(ctx, { home })
  t.after(async () => { adapters.telegram = real; await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const conn = await rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'tok-1234' } })
  rt.state.im.connections[conn.id].paired.push({ id: 'u1', name: 'U1', at: 1 })
  await rt.save()
  const chat = { key: 'dm-u1', kind: 'direct', title: 'U1' }
  await fake.handlers.onMessage({ chat, sender: { id: 'u1', name: 'User u1' }, text: 'hi' })
  const emitEvent = (type, data) => { for (const listener of ctx.listeners.get('session/event') ?? []) if (listener.length >= 2) listener({ id: 'a' }, { type, data, time: Date.now() }) }
  emitEvent('turn/start', { turn: prompts.length })
  emitEvent('user/message', { source: { kind: 'user', rpcId: prompts.at(-1)?.requestId }, content: [{ type: 'text', text: 'from the chat' }] })
  sent.length = 0
  const racing = Promise.all((ctx.listeners.get('approval/request') ?? []).map(listener => listener(
    { agent: { id: 'a' }, toolName: 'bash', reason: 'run it', signal: new AbortController().signal }, () => new Promise(() => {}))))
  await delay(30)
  const card = sent.at(-1)
  const id = card.buttons[0].data.split(':')[1]
  const calls = []
  const original = rt.answerApproval
  rt.answerApproval = function (...args) { calls.push(args); return original.apply(this, args) }
  await fake.handlers.onAction({ chat, sender: { id: 'u1', name: 'User u1' }, data: `a:${id}:allow`, messageId: 1 })
  assert.equal((await racing)[0], 'allowed-once')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [id, 'allow'])
  assert.equal(calls[0].length, 2)
})
