import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { install as installDelivery } from '../src/host/delivery.js'
import { install as installLedger } from '../src/host/ledger.js'
import { install as installParts } from '../src/host/parts.js'
import { replyToSender } from '../src/host/joined-turn.js'
import { handleNodeMessage } from '../src/host/bot-network.js'
import { fakeContext } from './fake-ctx.js'

const textOf = content => content.filter(block => block.type === 'text').map(block => block.text).join('')
const isReply = event => event.type === 'user/message' && textOf(event.data.content).startsWith('[Reply from ')

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await delay(10)
  assert.ok(predicate(), 'the reply turn completes within 5s')
}

async function world(t) {
  const core = new Context()
  const released = Promise.withResolvers()
  t.after(async () => { released.resolve(); await core.fiber.dispose() })
  await mountAgentLoopTestDependencies(core)
  const entered = Promise.withResolvers()
  const requests = []
  class MockModel extends LlmAdapter {
    async * stream(request) {
      requests.push(request)
      if (requests.length === 1) { entered.resolve(); await released.promise }
      request.signal.throwIfAborted()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Done.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  core.llm.registerAdapter(['mock'], new MockModel())
  const harness = await mountAgentLoopTestHarness(core)
  const agent = await harness.create(SessionId('sender'), { provider: 'mock', model: 'mock' })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-reply-wakes-'))
  const ctx = fakeContext({ services: { sessionProjections: core.get('sessionProjections') } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const pages = []
  ctx.sessions = { flush: async () => {} }
  ctx.sessionController = {
    resolveAgent: async () => ({ agent }),
    async page(request) {
      assert.equal(request.address.sessionId, agent.id)
      const records = agent.session.log
        .filter(event => request.throughSeq === undefined || event.seq <= request.throughSeq)
        .filter(event => request.beforeSeq === undefined || event.seq < request.beforeSeq)
        .map(event => ({ event }))
      pages.push(records)
      return { records, hasMore: false }
    },
  }
  const sender = { id: 'sender', name: 'Sender', sessionId: 'sender', createdAt: 1 }
  const node = {
    id: 'joined:n1:remote', name: 'Node Bot', origin: 'joined', type: 'remote-worker',
    worker: { nodeId: 'n1', remoteBotId: 'remote', online: true, home: 'remote' },
  }
  const rt = {
    ctx, home, config: {},
    state: { bots: { [sender.id]: sender, [node.id]: node }, exchanges: [], exchangeTurns: {}, closedCards: {} },
    botOf(id) { return this.state.bots[id] },
    chatOf(id) { return this.botOf(id)?.sessionId ?? id },
    roomOf: () => undefined,
    chatOwners: new Map([[agent.id, sender.id]]), groupOwners: new Map(), pastOwners: new Map(), roomOwners: new Map(),
    ensureCapabilities: async () => {}, hideBotUnusedTools: () => {}, save: async () => {},
    readOnly: () => undefined,
    warn: (...args) => assert.fail(args.join(' ')),
  }
  installLedger(rt)
  installParts(rt)
  installDelivery(rt)
  return { rt, agent, sender, node, entered, released, requests, pages }
}

test('a joined reply to a busy sender is on chatPage now and runs its own completed turn', async t => {
  const w = await world(t)
  const { rt, agent, sender, node, entered, released } = w
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'current work' }], source: { kind: 'user' } }))
  await entered.promise
  assert.equal(agent.status, 'running')
  t.after(() => released.resolve())

  await replyToSender(rt, { fromId: sender.id, toId: node.id, exchangeId: 'reply-busy', text: 'The node finished.' })
  assert.equal(agent.status, 'running')
  const { items } = await rt.chatPage(sender.id)
  assert.ok(items.some(i => typeof i.text === 'string' && i.text.startsWith('[Reply from ')))
  const row = items.find(i => typeof i.text === 'string' && i.text.startsWith('[Reply from '))
  const transcript = w.pages.at(-1).map(record => record.event)
  assert.ok(transcript.some(event => event.seq === row.seq && isReply(event)))
  assert.equal(agent.session.log.filter(event => event.type === 'turn/start').length, 1, 'the current turn is still running')
  assert.equal(agent.inbox.nextTurn.some(message => message.source.replyTo === 'reply-busy'), false)

  released.resolve()
  await until(() => agent.session.log.filter(event => event.type === 'turn/end').length === 2)
  const starts = agent.session.log.filter(event => event.type === 'turn/start')
  const ends = agent.session.log.filter(event => event.type === 'turn/end')
  assert.equal(starts.length, 2)
  assert.ok(ends[0].seq < starts[1].seq)
  assert.ok(starts[1].seq < ends[1].seq)
  assert.equal(ends[1].data.turn, starts[1].data.turn)
  assert.equal(ends[1].data.reason.kind, 'completed')
  assert.equal(agent.session.log.filter(isReply).length, 1, 'the reply is recorded once')
  assert.equal(w.requests.length, 2, 'the wake makes a model request')
  assert.equal(w.requests[1].messages.filter(message => textOf(message.content).startsWith('[Reply from ')).length, 1)
  assert.equal(agent.inbox.nextTurn.length, 0)
  assert.equal((await rt.chatPage(sender.id)).items.filter(i => i.text?.startsWith('[Reply from ')).length, 1)
})

test('remote-worker work dispatches; answers and lifecycle controls keep the local path', async t => {
  const { rt, sender, node, released } = await world(t)
  released.resolve()
  const routed = []
  sender.type = 'remote-worker'
  rt.handleRemoteTurn = async message => { routed.push(message); return message.exchangeId }
  for (const role of ['reply', 'report', 'request', 'default', 'mystery']) {
    await rt.deliver({ fromId: node.id, toId: sender.id, role, text: role })
  }
  assert.deepEqual(routed.map(message => message.role), ['request', 'default', 'mystery'])
  for (const role of ['kickoff', 'continue', 'update']) {
    await rt.deliver({ toId: sender.id, role, text: role })
  }
  assert.equal(routed.length, 3)
})

test('an idle sender wakes and consecutive visible messages each complete a turn', async t => {
  const { rt, agent, sender, node, released, requests } = await world(t)
  released.resolve()
  for (const role of ['reply', 'report', 'mystery']) {
    await rt.deliver({ fromId: node.id, toId: sender.id, text: role, role })
  }
  assert.equal((await rt.chatPage(sender.id)).items.filter(item => item.kind === 'user').length, 3)
  await until(() => agent.session.log.filter(event => event.type === 'turn/end').length === 3)
  assert.equal(requests.length, 3)
  assert.ok(agent.session.log.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'))
  assert.equal(agent.inbox.nextTurn.length, 0)
  assert.equal((await rt.chatPage(sender.id)).items.filter(item => item.kind === 'user').length, 3)
})

test('a control message keeps followup delivery without an immediate transcript row', async t => {
  const { rt, agent, sender, entered, released } = await world(t)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'current work' }], source: { kind: 'user' } }))
  await entered.promise
  await rt.deliver({ toId: sender.id, role: 'continue', text: 'resume work' })
  assert.equal(agent.session.log.some(event => event.type === 'user/message' && event.data.source.role === 'continue'), false)
  assert.equal(agent.inbox.nextTurn[0].source.role, 'continue')
  released.resolve()
  await agent.whenIdle()
})

test('a visible node message to a joined Bot is dispatched at once without holding the node', async () => {
  const calls = []
  const rt = {
    state: { bots: { joined: { id: 'joined', origin: 'joined' } } },
    handleJoinedTurn: async message => { calls.push(message) },
  }
  for (const kind of ['ask', 'reply']) await handleNodeMessage(rt, {
    kind, from: { id: 'sender', name: 'Sender' }, to: { id: 'joined' }, text: kind, exchangeId: kind, depth: 0,
  })
  assert.equal(calls.length, 2)
  // defer only decides whether the caller awaits; the turn is dispatched either way.
  assert.ok(calls.every(message => message.defer === true))
})
