// s50 / merge plan I10 (R-mneme): upstream v0.3.2 moves the memory review into memory-review.js. This fork
// decides per Bot which memory backend keeps its memory (memoryConfig.backend: auto|mneme|file|none); the
// review of a chat or a group, and the file-memory tools, belong to the `file` backend ONLY. A Bot on dsh-mneme
// or with memory off must neither be reviewed (a model call that writes MEMORY.md files) nor get the tools.
// Real runtime, real idle event, real review pipeline; written before the merge and kept green after it.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: '代码', instructions: '', createdAt: 3 },
    b4: { id: 'b4', sessionId: 'b4', name: 'Temp', role: '临时', instructions: '', createdAt: 4 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b3: 'g3' },
      seq: 3,
      log: [
        { who: 'User', text: 'Keep everything you send me under one page', seq: 1 },
        { who: 'Coder', botId: 'b3', kind: 'lookup', text: 'page', seq: 2 },
        { who: 'Coder', botId: 'b3', text: 'Will do.', seq: 3 },
      ],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const ownChat = [
  { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please remember this' }] } } },
  { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Saved.' }] } } } },
]

// The model answers each call with the next of `replies`. `history` holds the events
// of a Session, oldest first; each own chat has one user message, at seq 10, unless
// it says otherwise. `requireSession` turns down a request without a Session, as
// some routes do.
let rt
function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-')), replies = [], config = {}, history = {}, reasoning = { efforts: [{ id: 'off' }, { id: 'high' }] }, models = ['v4'], defaultModel, requireSession = false } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const services = defaultModel === undefined ? {} : { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: defaultModel }) } }
  const ctx = fakeContext({ services })
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => models.map(id => ({ id })),
      resolveModelInfo: async () => ({ reasoning }),
      async* stream(request) {
        requests.push(request)
        if (requireSession && request.sessionId === undefined) throw new Error('400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}')
        const reply = await replies.shift()
        if (reply instanceof Error) throw reply
        const out = typeof reply === 'object' && reply !== null ? reply : { text: reply ?? '' }
        yield { type: 'text-delta', index: 0, text: out.text ?? '' }
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop', ...(out.failure ? { failure: { message: out.failure } } : {}) } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (history[sessionId] ?? ownChat).at(-1).event.seq + 1 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? ownChat).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home, ...config })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const section = sessionId => ctx.sections.get('bot-memory').text({ agent: { id: sessionId } })
  const read = (...path) => readFileSync(join(home, 'memory', ...path), 'utf8')
  const journal = () => read('journal.jsonl').trim().split('\n').map(line => JSON.parse(line))
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, call, tool, section, read, journal, requests, warnings, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function reviewed(call) {
  for (let tries = 0; tries < 200; tries += 1) {
    await settle()
    if ((await call('state', {})).value.memoryReviews === 0) return
  }
  throw new Error('the memory review did not finish')
}


const REVIEW = JSON.stringify({ changes: [{ op: 'add', text: 'The user likes tea' }] })
const settle2 = () => new Promise(resolve => setTimeout(resolve, 60))

function world(backends, { config = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-merge-mem-'))
  const bots = Object.fromEntries(Object.entries(TEAM.bots).map(([id, bot]) => [id, backends[id] === undefined ? bot : { ...bot, memoryConfig: { backend: backends[id] } }]))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, bots }))
  return { home, ...start({ home, replies: [REVIEW, REVIEW, REVIEW, REVIEW], config: { memoryReviewDelayMs: 0, ...config } }) }
}

test('M-mem-control: a Bot on the file backend IS reviewed when its turn ends (the guard is not a global switch-off)', async (t) => {
  const w = world({ b2: 'file' })
  t.after(() => w.stop())
  await w.call('state', {})
  w.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(w.call)
  assert.equal(w.requests.length, 1)
  assert.match(readFileSync(join(w.home, 'memory', 'bots', 'b2', 'MEMORY.md'), 'utf8'), /The user likes tea/)
})

for (const backend of ['mneme', 'none']) {
  test(`M-mem-chat-${backend}: a Bot on the ${backend} backend is never reviewed — no model call, no MEMORY.md`, async (t) => {
    const w = world({ b2: backend })
    t.after(() => w.stop())
    await w.call('state', {})
    w.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
    await reviewed(w.call)
    await settle2()
    assert.equal(w.requests.length, 0, 'no review request was made')
    assert.equal(existsSync(join(w.home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
    assert.equal(existsSync(join(w.home, 'memory', 'journal.jsonl')), false)
  })
}

test('M-mem-host-default-mneme: a Bot with no choice follows the host default — dsh-mneme — and is not reviewed', async (t) => {
  const w = world({}, { config: { memoryBackend: 'mneme' } })
  t.after(() => w.stop())
  await w.call('state', {})
  w.ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(w.call)
  await settle2()
  assert.equal(w.requests.length, 0)
})

test('M-mem-group-keeper: a group is reviewed by what its KEEPER (the admin) keeps memory in', async () => {
  // Group r1 is administered by b3 (Coder). b3 on `none` / `mneme`: no group review. b3 on `file`: reviewed.
  for (const [backend, expected] of [['none', 0], ['mneme', 0], ['file', 1]]) {
    const w = world({ b3: backend })
    try {
      await w.call('state', {})
      w.ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
      await reviewed(w.call)
      await settle2()
      assert.equal(w.requests.length, expected, `keeper on ${backend}`)
      assert.equal(existsSync(join(w.home, 'memory', 'groups', 'r1', 'MEMORY.md')), expected === 1, `group memory file with keeper on ${backend}`)
    } finally { await w.stop() }
  }
})

test('M-mem-tools: the file-memory tools and the prompt section stay with the file backend', async (t) => {
  const w = world({ b2: 'file', b3: 'none' }, { config: { memoryBackend: 'mneme' } })
  t.after(() => w.stop())
  await w.call('state', {})
  assert.match(w.section('b2'), /^# Your memory/)
  assert.match(await w.tool('remember', { text: 'User prefers tea' }, 'b2'), /^Saved to your memory/)
  assert.equal(w.section('b3'), '')
  await assert.rejects(w.tool('remember', { text: 'x' }, 'b3'), /Memory is turned off for this Bot/)
  assert.equal(w.section('b4'), '')
  await assert.rejects(w.tool('remember', { text: 'x' }, 'b4'), /keeps its memory in dsh-mneme/)
})

// What the pre-step puts in front of a Session's step: the group memory snapshot, the memory update and the
// automatic recall are all ds-bot FILE memory. A Bot that moved to dsh-mneme / none gets none of them.
const textOf = message => (message?.content ?? []).map(block => block.text).join('')
async function frontOf(ctx, sessionId) {
  const step = ctx.listeners.get('agent/pre-step').find(listener => /isGroupMemory|memoryUpdate/.test(String(listener)))
  const agent = { id: sessionId, session: { deriveMessages: () => [] } }
  const decision = await step({ agent, messages: [], step: 1, signal: AbortSignal.timeout(10_000) }, async () => ({ kind: 'enter', messages: [] }))
  return decision.messages
}

for (const backend of ['none', 'mneme']) {
  test(`M-mem-prestep-${backend}: the pre-step puts no ds-bot memory in front of a Bot that moved to ${backend} — decided at use time`, async (t) => {
    const w = world({ b3: 'file' })
    t.after(() => w.stop())
    await w.call('state', {})
    await w.tool('remember', { text: 'Ship on Friday' }, 'g3')
    assert.match(textOf((await frontOf(w.ctx, 'g3'))[0]), /Group memory/, 'on the file backend the snapshot is there')
    assert.equal((await w.call('update-bot', { id: 'b3', memoryConfig: { backend } })).ok, true)
    assert.deepEqual(await frontOf(w.ctx, 'g3'), [], 'moved off the file backend: nothing is put in front of the step')
    assert.equal(w.section('b3'), '', 'and nothing in the prompt section either')
  })
}
