// The hub writes a node Bot's thinking and tool steps (bot/trace) into the mirror page of that Bot, for an exchange with
// it, in the events a local turn writes: while the turn runs, once per step, in order, never twice, and never leaving a
// step or a thinking block open when the turn ends any way at all. These tests drive the hub side with `botTrace`
// events shaped as AC's ingest emits them; test/node-trace-e2e.test.js runs the same through AC's real functions.
// A node's own page is a copy of its chat (conv-replica.js), so this is the path of a node without the copy. Group rounds
// no longer write into the group's own Session (fork.130: its agent is the only writer of turns there), so no trace
// reaches a group; the rounds below are Bot-to-Bot exchanges (handleJoinedTurn without a roomId).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld } from './joined-world.js'
import { answers, assertStrict, FULL_SKELETON, reasoningOf, skeleton, textOf } from './node-trace-world.js'
import { handleJoinedTurn, LINK_LOST_TEXT, settleStoppedTurns } from '../src/host/joined-turn.js'
import { NO_RESULT_TEXT } from '../src/host/hub-trace.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
const drain = async (times = 4) => { for (let i = 0; i < times; i += 1) await settle() }

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
const call = (id, name = 'bash', args = '{"command":"ls"}') => ({ id, name, args })
const A = (i, think, calls) => ({ i, t: 'a', ...(think ? { think } : {}), ...(calls ? { calls } : { end: true }) })
const R = (i, id, out = 'ok', ok = true) => ({ i, t: 'r', id, ok, out })
// plan → bash, read → answer (the last step called no tool: its thinking leads the answer)
const FULL = [A(1, 'plan', [call('c1')]), R(2, 'c1', 'a.txt'), A(3, 'read it', [call('c2', 'read', '{"file_path":"a.txt"}')]), R(4, 'c2', 'hello'), A(5, 'now answer')]

const exchangeOf = (w, index = 0) => w.frames.filter(frame => frame.type === 'bot/turn')[index].payload.exchangeId
const trace = (w, index, seq, items, extra = {}) => w.emitter.emit('botTrace', { nodeId: 'n1', remoteBotId: 'rb1', exchangeId: exchangeOf(w, index), seq, items, ...extra })

// An exchange with the node Bot: its round is written into the Bot's mirror page (joined-turn.js openMirrorTurn).
function groupWorld(options) {
  const w = makeWorld(options)
  w.rt.state.exchanges = []
  return w
}
async function groupRound(w, text = 'hi') {
  const done = handleJoinedTurn(w.rt, { fromId: 'local', toId: w.bot.id, text, role: 'request' })
  await drain()
  return { done, session: w.sessionOf(w.bot.sessionId) }
}

// ── the group round ──────────────────────────────────────────────────────────────────────────────
test('a round: the steps are written while the node works, then the answer closes the turn like a local turn', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  trace(w, 0, 1, FULL.slice(0, 2))
  assert.deepEqual(skeleton(session), ['turn/start', 'step/start:1', 'user', 'assistant[reasoning+tool-call]', 'call:bash', 'result:ok'], 'the first step is in the group before the turn is over')
  trace(w, 0, 2, FULL.slice(2))
  trace(w, 0, 3, FULL, { final: true })
  assert.deepEqual(skeleton(session).slice(-1), ['result:ok'], 'the last step stays open until the answer or the end of the turn closes it')
  w.reply(0, { text: 'a.txt says hello' })
  assert.equal(await done, exchangeOf(w, 0))
  assert.deepEqual(skeleton(session), FULL_SKELETON)
  const [first, second, last] = answers(session)
  assert.equal(reasoningOf(first), 'plan')
  assert.equal(reasoningOf(second), 'read it')
  assert.equal(reasoningOf(last), 'now answer', 'the thinking before the answer leads the answer, as a local turn')
  assert.equal(textOf(last), 'a.txt says hello')
  const calls = session.log.filter(event => event.type === 'tool/call').map(event => [event.data.name, event.data.arguments, event.data.callId])
  assert.deepEqual(calls, [['bash', '{"command":"ls"}', 'c1'], ['read', '{"file_path":"a.txt"}', 'c2']])
  const outputs = session.log.filter(event => event.type === 'tool/result').map(event => event.data.message.content[0].text)
  assert.deepEqual(outputs, ['a.txt', 'hello'])
  assertStrict(session)
  assert.equal(w.warnings.length, 0)
})

test('the same steps in the Session of a local turn and of a round give the same derived messages', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  trace(w, 0, 1, FULL, { final: true })
  w.reply(0, { text: 'a.txt says hello' })
  await done
  const messages = session.deriveMessages()
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
  assert.deepEqual(messages[1].content.map(block => block.type), ['reasoning', 'tool-call'])
  assert.deepEqual(messages[1].content[1].name, 'bash')
  assert.equal(messages[2].toolCallId, 'c1')
  assert.deepEqual(messages[5].content.map(block => block.type), ['reasoning', 'text'])
})

test('a turn that no trace came for is exactly what it was: one step, one answer', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  w.reply(0, { text: 'plain' })
  await done
  assert.deepEqual(skeleton(session), ['turn/start', 'step/start:1', 'user', 'assistant[text]', 'step/end:1', 'turn/end:completed'])
})

test('a frame played twice, or the same steps under another seq, write nothing twice', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  trace(w, 0, 1, FULL.slice(0, 2))
  trace(w, 0, 1, FULL.slice(0, 2))
  trace(w, 0, 2, FULL.slice(0, 2))
  trace(w, 0, 3, FULL.slice(0, 4))
  trace(w, 0, 4, FULL.slice(1, 4))
  trace(w, 0, 5, FULL, { final: true })
  trace(w, 0, 6, FULL, { final: true })
  w.reply(0, { text: 'done' })
  await done
  assert.deepEqual(skeleton(session), FULL_SKELETON)
})

test('batches that arrive out of order wait for the one before them, and are written in order', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  trace(w, 0, 2, FULL.slice(2, 4))
  trace(w, 0, 3, FULL.slice(4))
  assert.deepEqual(skeleton(session), ['turn/start', 'step/start:1', 'user'], 'nothing is written ahead of a missing step')
  trace(w, 0, 1, FULL.slice(0, 2))
  w.reply(0, { text: 'done' })
  await done
  assert.deepEqual(skeleton(session), FULL_SKELETON)
})

test('a batch lost on the way is made good by the final list, written in order before the answer', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  // batch 1 (steps 1-2) never arrives; batch 2 (3-4) does and waits
  trace(w, 0, 2, FULL.slice(2, 4))
  assert.equal(skeleton(session).length, 3)
  trace(w, 0, 3, FULL, { final: true })
  w.reply(0, { text: 'done' })
  await done
  assert.deepEqual(skeleton(session), FULL_SKELETON)
})

test('a hole the final list cannot fill (the node cut its list) is skipped, and the turn says how many steps were left out', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  trace(w, 0, 1, [FULL[0], FULL[1], FULL[3]], { final: true, omitted: 7 })
  w.reply(0, { text: 'done' })
  await done
  assertStrict(session)
  assert.ok(answers(session).some(event => textOf(event).includes('省略了 7 个步骤')), 'visible, not silent')
  assert.equal(session.log.filter(event => event.type === 'tool/call').length, 1, 'only the call whose steps are there')
})

// ── every way a turn can end leaves nothing open ─────────────────────────────────────────────────
test('the link is lost in the middle of a step: the turn is closed as lost, the unanswered tool call is answered with an error', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  trace(w, 0, 1, FULL.slice(0, 3))   // step 2's tool is running when the link drops
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  assert.equal((await done).error, 'bridge-down')
  assertStrict(session)
  const results = session.log.filter(event => event.type === 'tool/result')
  assert.deepEqual(results.map(event => [event.data.message.toolCallId, event.data.message.isError]), [['c1', false], ['c2', true]])
  assert.equal(results[1].data.message.content[0].text, NO_RESULT_TEXT)
  assert.ok(textOf(answers(session).at(-1)).includes('无法送达节点'))
  assert.equal(session.log.at(-1).data.reason.kind, 'error')
  // a step in a closed turn: whatever the node sends after that writes nothing
  const before = session.log.length
  trace(w, 0, 2, FULL, { final: true })
  assert.equal(session.log.length, before)
})

test('a stop of the node turn in the middle of a step: closed as stopped, nothing dangling, the thinking so far stays', async () => {
  // Traces now reach only group rounds (W4: the page is a copy of the node chat); the stop settles the round's exchange.
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  trace(w, 0, 1, [A(1, 'plan', [call('c1')])])
  assert.equal(settleStoppedTurns(w.rt.ctx.get('remote-agent:registry'), 'n1', 'rb1'), 1)
  assert.equal((await done).error, 'stopped')
  assertStrict(session)
  assert.equal(session.log.at(-1).data.reason.kind, 'aborted')
  assert.equal(reasoningOf(answers(session)[0]), 'plan')
  const before = session.log.length
  trace(w, 0, 2, FULL, { final: true })
  assert.equal(session.log.length, before, 'a trace that arrives after the stop writes nothing')
})

test('a failed node turn: the steps stay, the held thinking leads the failure line, the log is strict', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  trace(w, 0, 1, FULL, { final: true })
  w.reply(0, { ok: false, error: 'bot-turn-failed', text: '' })
  assert.equal((await done).error, 'bot-turn-failed')
  assertStrict(session)
  assert.equal(session.log.filter(event => event.type === 'tool/call').length, 2, 'the steps the node did stay')
  const last = answers(session).at(-1)
  assert.equal(reasoningOf(last), 'now answer')
  assert.ok(textOf(last).includes('bot-turn-failed'))
  assert.equal(session.log.at(-1).data.reason.kind, 'error')
})

test('a thinking-only step that is followed by more steps (the turn went on) is written as its own message', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  trace(w, 0, 1, [A(1, 'first answer?'), A(2, 'no, more work', [call('c1')]), R(3, 'c1', 'x'), A(4, 'final')], { final: true })
  w.reply(0, { text: 'done' })
  await done
  assertStrict(session)
  assert.deepEqual(skeleton(session), [
    'turn/start', 'step/start:1', 'user', 'assistant[reasoning]', 'step/end:1',
    'step/start:2', 'assistant[reasoning+tool-call]', 'call:bash', 'result:ok', 'step/end:2',
    'step/start:3', 'assistant[reasoning+text]', 'step/end:3', 'turn/end:completed',
  ])
})

// ── the other writers ────────────────────────────────────────────────────────────────────────────
test('a Bot-to-Bot exchange gets its steps too, in its own turn', async () => {
  const w = makeWorld()
  w.rt.state.exchanges = []
  const pending = handleJoinedTurn(w.rt, { fromId: 'local', toId: w.bot.id, text: 'from the team', exchangeId: 'ex-1', role: 'request' })
  await drain()
  trace(w, 0, 1, FULL.slice(0, 2))
  assert.deepEqual(skeleton(w.sessionOf('mirror-1')).slice(3), ['assistant[reasoning+tool-call]', 'call:bash', 'result:ok'])
  trace(w, 0, 2, FULL, { final: true })
  w.reply(0, { text: 'team answer' })
  assert.equal(await pending, 'ex-1')
  assert.deepEqual(skeleton(w.sessionOf('mirror-1')), FULL_SKELETON)
  assertStrict(w.sessionOf('mirror-1'))
})

test('a round that waits behind another round with the same Bot keeps its steps and writes them with its turn, once the first is over', async () => {
  // The exchange it waits behind is the Bot's own earlier one.
  const w = groupWorld()
  const first = await groupRound(w, 'first round')
  const second = await groupRound(w, 'second round')
  const session = first.session
  trace(w, 1, 1, FULL, { final: true })
  trace(w, 0, 1, [A(1, 'first thinking', [call('p1')]), R(2, 'p1', 'p')], { final: true })
  w.reply(1, { text: 'second answer' })
  assert.equal(session.log.filter(event => event.type === 'turn/start').length, 1, 'the waiting round is not written into the open one')
  w.reply(0, { text: 'first answer' })
  assert.equal(await first.done, exchangeOf(w, 0))
  assert.equal(await second.done, exchangeOf(w, 1))
  assertStrict(session)
  const turns = skeleton(session).join(' ').split('turn/start').slice(1)
  assert.equal(turns.length, 2)
  assert.deepEqual(skeleton(session).slice(skeleton(session).lastIndexOf('turn/start')), FULL_SKELETON, 'the waiting round has the whole turn, steps included')
  assert.equal(reasoningOf(answers(session)[0]), 'first thinking', 'and the first round has its own, not the waiting one\'s')
})

// ── compatibility ────────────────────────────────────────────────────────────────────────────────
test('a registry that cannot listen (older host) opens no sink and the turn runs as before', async () => {
  const w = groupWorld()
  const registry = w.rt.ctx.get('remote-agent:registry')
  const bare = { send: registry.send, on: undefined, off: undefined }
  w.rt.ctx.get = key => (key === 'remote-agent:registry' ? bare : undefined)
  const { session } = await groupRound(w)
  assert.equal(w.frames.filter(frame => frame.type === 'bot/turn').length, 1, 'the round still goes out')
  assert.deepEqual(skeleton(session), ['turn/start', 'step/start:1', 'user'])
  assert.equal(w.warnings.length, 0)
})

test('a trace for another exchange or another node is not written', async () => {
  const w = groupWorld()
  const { done, session } = await groupRound(w)
  w.emitter.emit('botTrace', { nodeId: 'n1', remoteBotId: 'rb1', exchangeId: 'someone-else', seq: 1, items: FULL })
  w.emitter.emit('botTrace', { nodeId: 'n2', remoteBotId: 'rb1', exchangeId: exchangeOf(w, 0), seq: 1, items: FULL })
  assert.deepEqual(skeleton(session), ['turn/start', 'step/start:1', 'user'])
  w.reply(0, { text: 'done' })
  await done
  assert.deepEqual(skeleton(session), ['turn/start', 'step/start:1', 'user', 'assistant[text]', 'step/end:1', 'turn/end:completed'])
})

test('a failing Session append stops the steps but never the turn: the answer is still written and the turn closed', async () => {
  const w = groupWorld({ failAppendOn: 'tool/call' })
  const { done, session } = await groupRound(w)
  trace(w, 0, 1, FULL, { final: true })
  w.reply(0, { text: 'the answer' })
  await done
  assert.equal(session.log.at(-1).type, 'turn/end')
  assert.equal(textOf(answers(session).at(-1)).includes('the answer'), true)
  assert.ok(w.warnings.some(args => String(args[0]).includes('steps of a node turn')))
})

test('the link-loss line stays the same with a trace', () => {
  assert.ok(LINK_LOST_TEXT.includes('桥已断'))
})
