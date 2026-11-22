// A hub steer reaching a node Bot: the node takes it as a steer (not a queued message), it bypasses
// the gate when it joins the turn running on that Session, and the turn that took it answers every
// message it took (the opening one and each steer that joined).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotTurnReceiver } from '../src/host/joined-turn.js'
import { settleJoinForTurns } from '../src/host/turns.js'

function nodeWorld({ running } = {}) {
  const sent = []
  const gated = []
  const rt = {
    state: { bots: { b1: { id: 'b1', name: 'Worker', type: 'local' } } },
    chatOf: () => 's1',
    botOf: id => rt.state.bots[id],
    sendUser: async args => { sent.push(args) },
    sendThreadTurn: async spec => { gated.push(spec); if (spec.run) await spec.run() },
    threadQueueLive: () => ({ running: running ? { sessionId: 's1' } : null, queued: [] }),
    warn: () => {},
  }
  const accept = createBotTurnReceiver(rt, { timeoutMs: 1000 })
  return { rt, accept, sent, gated }
}
const turn = (over = {}) => ({ remoteBotId: 'b1', exchangeId: 'e1', text: 'hello', ...over })

test('a plain hub turn is sent as a queued message through the gate', async () => {
  const w = nodeWorld({ running: true })
  const done = w.accept(turn())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.sent.length, 1)
  assert.equal(w.sent[0].mode, undefined)
  assert.equal(w.gated.length, 1)
  w.rt.settleJoinedTurn('e1', 'done')
  assert.deepEqual(await done, { ok: true, exchangeId: 'e1', text: 'done' })
})

test('a steer is sent with mode steer and, joining the running turn, does not wait behind the gate', async () => {
  const w = nodeWorld({ running: true })
  const done = w.accept(turn({ exchangeId: 'e2', mode: 'steer' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.sent[0].mode, 'steer')
  assert.equal(w.gated.length, 0, 'it joins the turn that is running, it does not queue behind it')
  w.rt.settleJoinedTurn('e2', 'ok')
  await done
})

test('a steer to an idle Bot goes through the gate like any message', async () => {
  const w = nodeWorld({ running: false })
  const done = w.accept(turn({ exchangeId: 'e3', mode: 'steer' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.sent[0].mode, 'steer')
  assert.equal(w.gated.length, 1)
  w.rt.settleJoinedTurn('e3', 'ok')
  await done
})

test('one turn answers every message it took: the opener and each steer that joined', async () => {
  const w = nodeWorld({ running: true })
  const first = w.accept(turn({ exchangeId: 'a' }))
  const second = w.accept(turn({ exchangeId: 'b', mode: 'steer', text: 'and this' }))
  const third = w.accept(turn({ exchangeId: 'c', mode: 'steer', text: 'and that' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settleJoinForTurns(w.rt, { rpcId: 'a' }, new Set(['a', 'b', 'c']), 'all done'), true)
  assert.deepEqual((await Promise.all([first, second, third])).map(result => result.text), ['all done', 'all done', 'all done'])
})
