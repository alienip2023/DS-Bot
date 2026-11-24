// D6 (task-board T-20261125-d6-dead-session-queue): a Bot's Main thread row still named an ended part of its chat
// (a rollover moves the Bot, not the row). Every prompt the composer sent then queued against that ended Session:
// the gate waited 60 s for a turn/start that never came there, held the Bot, and the hand-backs queued behind it
// went out only when the accept wait gave up ("a turn for session-34487f72… was accepted but never started").
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as settle } from 'node:timers/promises'
import { test } from 'node:test'
import { newMainThread } from '../src/host/bot-store.js'
import { threadWorld } from './thread-t2-world.js'

const BOT = 'chief'
const PEER = 'writer'
const OLD = 'session-34487f72-7045-451e-9e59-2f2cc939c4d6'
const CURRENT = 'session-current'
async function until(check, label, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 5)) }
  assert.fail(`timed out: ${label}`)
}
const bot = (id, sessionId, extra = {}) => ({ id, sessionId, name: id, role: 'Bot', instructions: '', createdAt: 1, ...extra })

async function world(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-d6-'))
  // As on the hub: the Bot is in its current part, an earlier part ended, and the Main thread row still names it.
  const chief = bot(BOT, CURRENT, { segments: [{ sessionId: OLD, startedAt: 1, endedAt: 2 }] })
  const main = { ...newMainThread(chief), sessionId: OLD }
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, whaleStored: true, mainBotIds: [], revision: 1,
    bots: { [BOT]: chief, [PEER]: bot(PEER, PEER) }, threads: { [main.id]: main }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const w = threadWorld({ home })
  t.after(async () => {
    await w.ctx.dispose?.()
    rmSync(home, { force: true, recursive: true })
  })
  await w.rt.load()
  const turn = (sessionId, kind) => w.sessionEvent(sessionId, { type: `turn/${kind}`, data: { turn: 1, ...(kind === 'end' ? { reason: { kind: 'completed' } } : {}) } })
  return { ...w, main, turn }
}

test('T0 (the D6 chain) a prompt on the Bot\'s current part, whose Main row names an ended part, releases the Bot when its turn ends; a hand-back behind it goes at once', async t => {
  const w = await world(t)
  const { rt, ctx, turn, followups } = w
  const warnings = t.mock.method(rt, 'warn', () => {})
  // The composer's prompt, through the gate (thread-prompt.js) as on the hub.
  await ctx.sessionController.prompt({ sessionId: CURRENT, requestId: 'r1', content: [{ type: 'text', text: '现在' }] })
  assert.equal(rt.threadQueueLive(BOT).running?.sessionId, CURRENT, 'the gate waits on the part the turn runs in')
  turn(CURRENT, 'start')
  // A hand-back arrives while that turn runs: it waits behind it.
  const delivered = rt.deliver({ fromId: PEER, toId: BOT, text: 'R121-GOT', role: 'reply', exchangeId: 'receipt-1' })
  await until(() => rt.threadQueueLive(BOT).queued.length === 1, 'the hand-back waits behind the running turn')
  turn(CURRENT, 'end')
  await delivered
  // Once DSH has finished recording the turn's end (fork.126), not inside it.
  await until(() => followups.length > 0, 'the hand-back went out after the turn')
  assert.deepEqual(followups.map(f => f.sessionId), [CURRENT], 'the hand-back went to the current part right after the turn')
  assert.equal(warnings.mock.calls.some(call => /accepted but never started/.test(String(call.arguments[0]))), false)
})

test('T1 a turn for an ended part fails at once with E_SESSION_ENDED: nothing runs, no accept wait, one failure recorded', async t => {
  const { rt } = await world(t)
  const warnings = t.mock.method(rt, 'warn', () => {})
  const failures = t.mock.method(rt, 'noteFailure', () => {})
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const run = t.mock.fn(async () => {})
  await assert.rejects(rt.sendThreadTurn({ botId: BOT, sessionId: OLD, kind: 'send', releaseOn: 'turn-end', run }), { code: 'E_SESSION_ENDED' })
  assert.equal(run.mock.callCount(), 0)
  t.mock.timers.tick(120_000)
  assert.equal(warnings.mock.callCount(), 0, 'no accept wait was armed')
  assert.deepEqual(failures.mock.calls.map(call => call.arguments[0].code), ['E_SESSION_ENDED'])
  assert.deepEqual(rt.threadQueueLive(BOT), { running: null, queued: [] })
})

test('T2 the same hand-back sent twice while the Bot is busy is queued once and delivered once', async t => {
  const { rt, turn, followups } = await world(t)
  await rt.sendThreadTurn({ botId: BOT, sessionId: CURRENT, kind: 'send', releaseOn: 'turn-end', run: async () => turn(CURRENT, 'start') })
  const args = { fromId: PEER, toId: BOT, text: 'R121-GOT', role: 'reply', exchangeId: 'receipt-2' }
  const both = Promise.all([rt.deliver(args), rt.deliver(args)])
  await until(() => rt.threadQueueLive(BOT).queued.length === 1, 'one hand-back waits')
  for (let i = 0; i < 20; i += 1) await settle()
  assert.equal(rt.threadQueueLive(BOT).queued.length, 1)
  turn(CURRENT, 'end')
  assert.deepEqual(await both, ['receipt-2', 'receipt-2'])
  await until(() => followups.length > 0, 'delivered')
  for (let i = 0; i < 10; i += 1) await settle()
  assert.deepEqual(followups.map(f => f.sessionId), [CURRENT])
})

test('T3 normal path: a hand-back to the current part is delivered, and the turn it starts runs and ends', async t => {
  const { rt, turn, followups } = await world(t)
  await rt.deliver({ fromId: PEER, toId: BOT, text: 'done', role: 'reply', exchangeId: 'receipt-3' })
  assert.deepEqual(followups.map(f => f.sessionId), [CURRENT])
  turn(CURRENT, 'start')
  turn(CURRENT, 'end')
  assert.deepEqual(rt.threadQueueLive(BOT), { running: null, queued: [] })
})

test('T4 an ended part is still read as history', async t => {
  const { rt, ctx } = await world(t)
  t.mock.method(ctx.sessionController, 'page', async ({ address }) => ({
    records: address.sessionId === OLD ? [{ event: { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'old page' }], source: { kind: 'user' } } } }] : [],
    hasMore: false,
  }))
  const page = await rt.chatPage(BOT, { part: 0 })
  assert.match(JSON.stringify(page.items), /old page/)
})

// fork.126: the queue released the next turn from inside the turn/end event DSH was still recording, and DSH refused
// its first write ("session append cannot reenter while another append is being published"): a hand-back was lost.
test('T5 the turn queued behind a turn starts after DSH finished recording that turn\'s end, not inside it', async t => {
  const w = await world(t)
  const { rt, ctx, turn, followups } = w
  const warnings = t.mock.method(rt, 'warn', () => {})
  let publishing = false
  const record = (sessionId, kind) => { publishing = true; try { turn(sessionId, kind) } finally { publishing = false } }
  const agent = w.agentOf(CURRENT)
  const followup = agent.followup
  agent.followup = function (message) {
    if (publishing) throw new Error('session append cannot reenter while another append is being published')
    return followup.call(this, message)
  }
  await ctx.sessionController.prompt({ sessionId: CURRENT, requestId: 'r1', content: [{ type: 'text', text: 'now' }] })
  record(CURRENT, 'start')
  const delivered = rt.deliver({ fromId: PEER, toId: BOT, text: 'R121-GOT', role: 'reply', exchangeId: 'receipt-5' })
  await until(() => rt.threadQueueLive(BOT).queued.length === 1, 'waits behind the running turn')
  record(CURRENT, 'end')
  await delivered
  await until(() => followups.some(f => f.sessionId === CURRENT), 'the hand-back went out')
  assert.equal(warnings.mock.calls.some(call => /queued turn for/.test(String(call.arguments[0]))), false)
})

test('T6 with untilSent, a delivery that waited for its turn and then failed to go out fails for its caller, who can send it again', async t => {
  const w = await world(t)
  const { rt, turn } = w
  t.mock.method(rt, 'warn', () => {})
  await rt.sendThreadTurn({ botId: BOT, sessionId: CURRENT, kind: 'send', releaseOn: 'turn-end', run: async () => turn(CURRENT, 'start') })
  const agent = w.agentOf(CURRENT)
  agent.followup = () => { throw new Error('refused') }
  const delivered = rt.deliver({ fromId: PEER, toId: BOT, text: 'results', role: 'reply', exchangeId: 'receipt-6', untilSent: true })
  await until(() => rt.threadQueueLive(BOT).queued.length === 1, 'waits')
  turn(CURRENT, 'end')
  await assert.rejects(delivered, /refused/)
})
