// The hub writes a node Bot's thinking and tool steps (bot/trace) into its mirror Session in the events a local
// turn writes: while the turn runs, once per step, in order, never twice, and never leaving a step or a thinking
// block open when the turn ends any way at all. These tests drive the hub side with `botTrace` events shaped as
// AC's ingest emits them; test/node-trace-e2e.test.js runs the same through AC's real functions.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld, textRequest } from './joined-world.js'
import { answers, assertStrict, FULL_SKELETON, reasoningOf, skeleton, textOf } from './node-trace-world.js'
import { handleJoinedTurn, LINK_LOST_TEXT } from '../src/host/joined-turn.js'
import { startSideTurn } from '../src/host/executor.js'
import { mirrorStateOf } from '../src/host/mirror.js'
import { NO_RESULT_TEXT, TRACE_NOTE_MARK } from '../src/host/hub-trace.js'
import { AC_NEEDED } from '../src/host/node-compat.js'

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

async function pageTurn(w, text = 'hi', requestId = 'req-1') {
  await w.prompt(textRequest(text, requestId))
  await drain(2)
}

// ── the page turn ────────────────────────────────────────────────────────────────────────────────
test('a page turn: the steps are written while the node works, then the answer closes the turn like a local turn', async () => {
  const w = makeWorld()
  await pageTurn(w)
  const session = w.sessionOf('mirror-1')
  trace(w, 0, 1, FULL.slice(0, 2))
  assert.deepEqual(skeleton(session), ['turn/start', 'step/start:1', 'user', 'assistant[reasoning+tool-call]', 'call:bash', 'result:ok'], 'the first step is on the page before the turn is over')
  trace(w, 0, 2, FULL.slice(2))
  trace(w, 0, 3, FULL, { final: true })
  assert.deepEqual(skeleton(session).slice(-1), ['result:ok'], 'the last step stays open until the answer or the end of the turn closes it')
  w.reply(0, { text: 'a.txt says hello' })
  await w.idle()
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

test('the same steps in the Session of a local turn and of the mirror give the same derived messages', async () => {
  const w = makeWorld()
  await pageTurn(w)
  trace(w, 0, 1, FULL, { final: true })
  w.reply(0, { text: 'a.txt says hello' })
  await w.idle()
  const messages = w.sessionOf('mirror-1').deriveMessages()
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
  assert.deepEqual(messages[1].content.map(block => block.type), ['reasoning', 'tool-call'])
  assert.deepEqual(messages[1].content[1].name, 'bash')
  assert.equal(messages[2].toolCallId, 'c1')
  assert.deepEqual(messages[5].content.map(block => block.type), ['reasoning', 'text'])
})

test('a turn that no trace came for is exactly what it was: one step, one answer', async () => {
  const w = makeWorld()
  await pageTurn(w)
  w.reply(0, { text: 'plain' })
  await w.idle()
  assert.deepEqual(skeleton(w.sessionOf('mirror-1')), ['turn/start', 'step/start:1', 'user', 'assistant[text]', 'step/end:1', 'turn/end:completed'])
})

test('a frame played twice, or the same steps under another seq, write nothing twice', async () => {
  const w = makeWorld()
  await pageTurn(w)
  trace(w, 0, 1, FULL.slice(0, 2))
  trace(w, 0, 1, FULL.slice(0, 2))
  trace(w, 0, 2, FULL.slice(0, 2))
  trace(w, 0, 3, FULL.slice(0, 4))
  trace(w, 0, 4, FULL.slice(1, 4))
  trace(w, 0, 5, FULL, { final: true })
  trace(w, 0, 6, FULL, { final: true })
  w.reply(0, { text: 'done' })
  await w.idle()
  assert.deepEqual(skeleton(w.sessionOf('mirror-1')), FULL_SKELETON)
})

test('batches that arrive out of order wait for the one before them, and are written in order', async () => {
  const w = makeWorld()
  await pageTurn(w)
  trace(w, 0, 2, FULL.slice(2, 4))
  trace(w, 0, 3, FULL.slice(4))
  assert.deepEqual(skeleton(w.sessionOf('mirror-1')), ['turn/start', 'step/start:1', 'user'], 'nothing is written ahead of a missing step')
  trace(w, 0, 1, FULL.slice(0, 2))
  w.reply(0, { text: 'done' })
  await w.idle()
  assert.deepEqual(skeleton(w.sessionOf('mirror-1')), FULL_SKELETON)
})

test('a batch lost on the way is made good by the final list, written in order before the answer', async () => {
  const w = makeWorld()
  await pageTurn(w)
  // batch 1 (steps 1-2) never arrives; batch 2 (3-4) does and waits
  trace(w, 0, 2, FULL.slice(2, 4))
  assert.equal(skeleton(w.sessionOf('mirror-1')).length, 3)
  trace(w, 0, 3, FULL, { final: true })
  w.reply(0, { text: 'done' })
  await w.idle()
  assert.deepEqual(skeleton(w.sessionOf('mirror-1')), FULL_SKELETON)
})

test('a hole the final list cannot fill (the node cut its list) is skipped, and the page says how many steps were left out', async () => {
  const w = makeWorld()
  await pageTurn(w)
  trace(w, 0, 1, [FULL[0], FULL[1], FULL[3]], { final: true, omitted: 7 })
  w.reply(0, { text: 'done' })
  await w.idle()
  const session = w.sessionOf('mirror-1')
  assertStrict(session)
  assert.ok(answers(session).some(event => textOf(event).includes('省略了 7 个步骤')), 'visible, not silent')
  assert.equal(session.log.filter(event => event.type === 'tool/call').length, 1, 'only the call whose steps are there')
})

// ── every way a turn can end leaves nothing open ─────────────────────────────────────────────────
test('the link is lost in the middle of a step: the turn is closed as lost, the unanswered tool call is answered with an error', async () => {
  const w = makeWorld()
  await pageTurn(w)
  trace(w, 0, 1, FULL.slice(0, 3))   // step 2's tool is running when the link drops
  w.emitter.emit('nodeOffline', { nodeId: 'n1' })
  await w.idle().catch(() => {})
  const session = w.sessionOf('mirror-1')
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

test('the page Stops a turn in the middle of a step: closed as stopped, nothing dangling, the thinking so far stays', async () => {
  const w = makeWorld()
  await pageTurn(w)
  trace(w, 0, 1, [A(1, 'plan', [call('c1')])])
  await w.cancel()
  await w.idle().catch(() => {})
  const session = w.sessionOf('mirror-1')
  assertStrict(session)
  assert.equal(session.log.at(-1).data.reason.kind, 'aborted')
  assert.equal(reasoningOf(answers(session)[0]), 'plan')
  const before = session.log.length
  trace(w, 0, 2, FULL, { final: true })
  assert.equal(session.log.length, before, 'a trace that arrives after the Stop writes nothing')
})

test('a failed node turn: the steps stay, the held thinking leads the failure line, the log is strict', async () => {
  const w = makeWorld()
  await pageTurn(w)
  trace(w, 0, 1, FULL, { final: true })
  w.reply(0, { ok: false, error: 'bot-turn-failed', text: '' })
  await w.idle().catch(() => {})
  const session = w.sessionOf('mirror-1')
  assertStrict(session)
  const last = answers(session).at(-1)
  assert.equal(reasoningOf(last), 'now answer')
  assert.ok(textOf(last).includes('bot-turn-failed') || textOf(last).includes('无法送达节点'))
  assert.equal(session.log.at(-1).data.reason.kind, 'error')
})

test('a thinking-only step that is followed by more steps (the turn went on) is written as its own message', async () => {
  const w = makeWorld()
  await pageTurn(w)
  trace(w, 0, 1, [A(1, 'first answer?'), A(2, 'no, more work', [call('c1')]), R(3, 'c1', 'x'), A(4, 'final')], { final: true })
  w.reply(0, { text: 'done' })
  await w.idle()
  const session = w.sessionOf('mirror-1')
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

test('a Bot-to-Bot exchange that waits behind the page turn keeps its steps and writes them with its turn, once the page turn is over', async () => {
  const w = makeWorld()
  w.rt.state.exchanges = []
  await pageTurn(w, 'from the page')
  const pending = handleJoinedTurn(w.rt, { fromId: 'local', toId: w.bot.id, text: 'from the team', exchangeId: 'ex-2', role: 'request' })
  await drain()
  trace(w, 1, 1, FULL, { final: true })
  trace(w, 0, 1, [A(1, 'page thinking', [call('p1')]), R(2, 'p1', 'p')], { final: true })
  w.reply(1, { text: 'team answer' })
  w.reply(0, { text: 'page answer' })
  await w.idle()
  assert.equal(await pending, 'ex-2')
  const session = w.sessionOf('mirror-1')
  assertStrict(session)
  const turns = skeleton(session).join(' ').split('turn/start').slice(1)
  assert.equal(turns.length, 2)
  assert.deepEqual(skeleton(session).slice(skeleton(session).lastIndexOf('turn/start')), FULL_SKELETON, 'the waiting exchange has the whole turn, steps included')
  assert.equal(reasoningOf(answers(session)[0]), 'page thinking', 'and the page turn has its own, not the exchange\'s')
})

test('a steer that joins the open page turn has no steps of its own: the page turn carries the whole run', async () => {
  const w = makeWorld({ tracker: true })
  await pageTurn(w, 'first', 'req-1')
  await w.prompt({ ...textRequest('and also', 'req-2'), mode: 'steer' })
  await drain(2)
  assert.equal(exchangeOf(w, 1) !== exchangeOf(w, 0), true)
  trace(w, 0, 1, FULL, { final: true })
  trace(w, 1, 1, FULL, { final: true })   // the node sends the steer's run too; the hub has nowhere to put it twice
  w.reply(1, { text: 'steer answer' })
  w.reply(0, { text: 'page answer' })
  await w.idle()
  const session = w.sessionOf('mirror-1')
  assertStrict(session)
  assert.equal(session.log.filter(event => event.type === 'tool/call').length, 2, 'the steps are on the page once')
  assert.equal(session.log.filter(event => event.type === 'user/message').length, 2)
})

test('a steer that is written as a turn of its own (no page turn is open) has its steps inside that turn', async () => {
  const w = makeWorld({ tracker: true })
  const session = w.sessionOf('mirror-1')
  const state = mirrorStateOf(w.rt, w.bot.id, session)
  const started = startSideTurn({ rt: w.rt, bot: w.bot, text: 'side', requestId: 'req-side', session, state, tracker: w.rt.turnTracker, mode: 'steer' })
  await drain()
  trace(w, 0, 1, FULL, { final: true })
  w.reply(0, { text: 'side answer' })
  await started.done
  assert.deepEqual(skeleton(session), FULL_SKELETON)
  assertStrict(session)
})

// ── compatibility ────────────────────────────────────────────────────────────────────────────────
const withCaps = (w, caps) => {
  const registry = { send: (...args) => w.rt.ctx.get('remote-agent:registry').__send(...args), on: (n, f) => w.emitter.on(n, f), off: (n, f) => w.emitter.off(n, f), getNode: () => ({ hello: { caps } }) }
  const original = w.rt.ctx.get('remote-agent:registry')
  registry.__send = (...args) => original.send(...args)
  w.rt.ctx.get = key => (key === 'remote-agent:registry' ? registry : undefined)
}
const notes = session => answers(session).map(textOf).filter(text => text.startsWith(TRACE_NOTE_MARK))

test('a node that cannot send traces: the answer arrives as before, and the page says once that the node is too old', async () => {
  const w = makeWorld()
  withCaps(w, ['bot-turn-mode/1', 'bot-action/1', 'roster-cards/1'])
  const session = w.sessionOf('mirror-1')
  await pageTurn(w, 'one', 'req-1')
  w.reply(0, { text: 'first answer' })
  await w.idle()
  await drain()
  assert.equal(notes(session).length, 1)
  assert.ok(notes(session)[0].includes('版本太旧') && notes(session)[0].includes(AC_NEEDED), 'names the update that is needed')
  assert.ok(textOf(answers(session)[0]) === 'first answer')
  await pageTurn(w, 'two', 'req-2')
  w.reply(1, { text: 'second answer' })
  await w.idle()
  await drain()
  assert.equal(notes(session).length, 1, 'once per Bot, not per turn')
  assertStrict(session)
})

test('a node that can send traces but none arrived (a hub whose AC cannot take them, or frames lost): said once, the answer is untouched', async () => {
  const w = makeWorld()
  withCaps(w, ['bot-turn-mode/1', 'bot-action/1', 'roster-cards/1', 'bot-trace/1'])
  const session = w.sessionOf('mirror-1')
  await pageTurn(w)
  w.reply(0, { text: 'the answer' })
  await w.idle()
  await drain()
  assert.equal(notes(session).length, 1)
  assert.ok(notes(session)[0].includes('没有收到'))
  assert.equal(textOf(answers(session)[0]), 'the answer')
})

test('a node that sent its steps is never told it is old, and a node whose capabilities are unknown is not nagged', async () => {
  const w = makeWorld()
  withCaps(w, ['bot-trace/1'])
  await pageTurn(w)
  trace(w, 0, 1, [], { final: true })
  w.reply(0, { text: 'ok' })
  await w.idle()
  await drain()
  assert.deepEqual(notes(w.sessionOf('mirror-1')), [])
  const unknown = makeWorld()
  await pageTurn(unknown)
  unknown.reply(0, { text: 'ok' })
  await unknown.idle()
  await drain()
  assert.deepEqual(notes(unknown.sessionOf('mirror-1')), [])
})

test('a registry that cannot listen (older host) opens no sink and the turn runs as before', async () => {
  const w = makeWorld()
  const registry = w.rt.ctx.get('remote-agent:registry')
  const bare = { send: registry.send, on: undefined, off: undefined }
  w.rt.ctx.get = key => (key === 'remote-agent:registry' ? bare : undefined)
  await pageTurn(w)
  assert.deepEqual(skeleton(w.sessionOf('mirror-1')), ['turn/start', 'step/start:1', 'user'])
})

test('a trace for another exchange or another node is not written', async () => {
  const w = makeWorld()
  await pageTurn(w)
  w.emitter.emit('botTrace', { nodeId: 'n1', remoteBotId: 'rb1', exchangeId: 'someone-else', seq: 1, items: FULL })
  w.emitter.emit('botTrace', { nodeId: 'n2', remoteBotId: 'rb1', exchangeId: exchangeOf(w, 0), seq: 1, items: FULL })
  assert.deepEqual(skeleton(w.sessionOf('mirror-1')), ['turn/start', 'step/start:1', 'user'])
})

test('a failing Session append stops the steps but never the turn: the answer is still written and the turn closed', async () => {
  const w = makeWorld({ failAppendOn: 'tool/call' })
  await pageTurn(w)
  trace(w, 0, 1, FULL, { final: true })
  w.reply(0, { text: 'the answer' })
  await w.idle()
  const session = w.sessionOf('mirror-1')
  assert.equal(session.log.at(-1).type, 'turn/end')
  assert.equal(textOf(answers(session).at(-1)).includes('the answer'), true)
  assert.ok(w.warnings.some(args => String(args[0]).includes('steps of a node turn')))
})

test('the link-loss line stays the same with a trace', () => {
  assert.ok(LINK_LOST_TEXT.includes('桥已断'))
})
