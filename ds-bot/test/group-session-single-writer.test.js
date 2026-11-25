// A group's own Session has an agent of its own (the group's relay runs its turns). DSH's agent numbers its next turn from
// a counter that only its own turns advance, so a second writer of turns in that Session (the node members' mirror
// turns, until fork.130) makes the agent's next turn repeat a number, or start inside the mirror's open turn: the stored
// Session then cannot be opened again ("turn/start does not open the expected turn"). Seen on the group
// 节点群测 (2026-11-26) and on an older group. Here the real agent loop runs the group's Session and a node member's
// group turn goes through handleJoinedTurn; DSH's own load check is applied to the log.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { install as installDelivery } from '../src/host/delivery.js'
import { handleJoinedTurn } from '../src/host/joined-turn.js'
import { fakeContext } from './fake-ctx.js'
import { assertStoredLogLoads } from './stored-log.js'

const drain = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)) }

async function boot(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-group-writer-'))
  const root = new Context()
  await mountAgentLoopTestDependencies(root)
  let replies = 0
  class Adapter extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'mock' } }
    async listModels() { return [{ id: 'm', name: 'm', inputModalities: ['text'] }] }
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 50_000 }, defaultMaxTokens: 2_000 } }
    async *stream() {
      const text = `relay ${++replies}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['mock'], new Adapter())
  await mountAgentLoopTestHarness(root)
  const { agents } = await new Promise(resolve => root.inject(['agents'], resolve))
  t.after(async () => { await root.fiber.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const { agent: group } = await agents.create({ sessionId: 'room-session', agentOptions: { provider: 'mock', model: 'm', maxTokens: 2_000 }, meta: { cwd: home } })
  const registry = new EventEmitter()
  const frames = []
  registry.send = (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true }
  const shadow = { id: 'joined:n1:rb1', name: 'Node', origin: 'joined', type: 'remote-worker', sessionId: 'private-mirror', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } }
  const sender = { id: 'sender', name: 'Sender', sessionId: 'sender-private' }
  const bots = { [shadow.id]: shadow, sender }
  const room = { id: 'room-1', name: 'Team', sessionId: 'room-session', sessions: { [shadow.id]: 'member-session' } }
  const sessions = new Map([['room-session', group.session], ['private-mirror', new Session('private-mirror')]])
  const rt = {
    ctx: fakeContext({ services: { 'remote-agent:registry': registry } }),
    state: { bots, exchanges: [], threads: {}, rooms: { [room.id]: room } },
    botOf: id => bots[id], chatOf: id => bots[id]?.sessionId,
    roomOf: id => rt.state.rooms[id], sessionOfRoom: item => item.sessionId,
    resolveAgent: async id => ({ session: sessions.get(id) }),
    hideBotUnusedTools() {},
    warn() {},
    ledger: { importer() {}, records: () => [], append() {}, written: async () => {} },
  }
  rt.ctx.sessionController = { resolveAgent: async id => ({ agent: { session: sessions.get(id) } }) }
  installDelivery(rt)
  const deliver = rt.deliver
  rt.deliver = msg => msg.role === 'reply' ? Promise.resolve() : deliver(msg)
  rt.handleJoinedTurn = msg => handleJoinedTurn(rt, msg)
  t.after(async () => { registry.emit('nodeOffline', { nodeId: 'n1' }); await drain() })
  // One turn of the group's own agent, as the group's relay runs it.
  const relayTurn = async (text) => {
    const idle = new Promise(resolve => {
      const off = root.on('agent/status', ({ agent, status }) => { if (agent.id === 'room-session' && status === 'idle') { off(); resolve() } })
    })
    group.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await idle
  }
  // A node member's turn in the group: the frame goes out, and the node answers (now, or later).
  const startNodeTurn = async (text, exchangeId) => {
    await handleJoinedTurn(rt, { fromId: sender.id, toId: shadow.id, roomId: room.id, text, exchangeId, defer: true })
    await drain()
  }
  const answerNodeTurn = async (text, exchangeId) => {
    registry.emit('botTurnResult', { nodeId: 'n1', exchangeId, ok: true, text: `answer to ${text}`, roomId: room.id })
    await drain()
  }
  const nodeTurn = async (text, exchangeId) => { await startNodeTurn(text, exchangeId); await answerNodeTurn(text, exchangeId) }
  return { group, relayTurn, nodeTurn, startNodeTurn, answerNodeTurn, frames }
}

test('node members\' group turns are not written into the group\'s own Session: its agent keeps counting its own turns and the stored log loads', async (t) => {
  const { group, relayTurn, nodeTurn, frames } = await boot(t)
  const turns = () => group.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn)
  await relayTurn('Group post: kick off')
  assert.deepEqual(turns(), [1])
  // Two node members answer while the group's agent is idle; the agent is not told, as it is in a live group.
  await nodeTurn('first', 'g-1')
  await nodeTurn('second', 'g-2')
  assert.equal(frames.length, 2, 'both turns went to the node')
  assert.deepEqual(turns(), [1], 'a node member\'s turn is not a turn of the group\'s Session')
  assert.equal(group.session.snapshotEvents().some(event => event.data?.message?.source?.provider === 'mirror'), false, 'nothing of it is on the group\'s timeline')
  await relayTurn('Group post: go on')
  assert.deepEqual(turns(), [1, 2], 'the agent\'s next turn follows its own')
  assert.doesNotThrow(() => assertStoredLogLoads(group.session), 'the stored log opens')
})

test('a node member\'s group turn that is still open when the group\'s agent runs again does not break the stored log', async (t) => {
  const { group, relayTurn, startNodeTurn, answerNodeTurn } = await boot(t)
  const turns = () => group.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn)
  await relayTurn('Group post: kick off')
  // The node has not answered when the group's relay runs again; its answer comes after.
  await startNodeTurn('slow', 'g-slow')
  await relayTurn('Group post: while the node works')
  await answerNodeTurn('slow', 'g-slow')
  assert.deepEqual(turns(), [1, 2])
  assert.doesNotThrow(() => assertStoredLogLoads(group.session))
})
