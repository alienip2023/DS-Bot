// A node Bot's page also shows what the node did on its own (a routine, its IM, its own Bot-to-Bot work). The
// page holds turns written live (a hub message and the node's answer) that carry no identity from the node's
// history, so: a mirror with such turns is never rewritten on a guess (its history up to now is a baseline), the
// turns the node adds afterwards are imported, and the live turns are recognised by what was said — never twice.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { syncJoinedHistory } from '../src/host/joined-history.js'
import { allocateTurn, mirrorTurnFinish, mirrorTurnStart } from '../src/host/mirror.js'

const group = (turn, seq, user, bot, partId = 'part-a') => [
  { kind: 'user', text: user, partId, turn, seq: seq - 1, turnComplete: true },
  { kind: 'bot', text: bot, partId, turn, seq, turnComplete: true },
]
const live = (session, user, bot) => {
  const turn = allocateTurn(session)
  mirrorTurnStart(session, { turn, step: 1, userText: user, rpcId: `rpc-${turn}` })
  mirrorTurnFinish(session, { turn, step: 1, botText: bot })
}
const texts = (session, type) => session.log.filter(event => event.type === type).map(event => event.data.message?.content?.[0]?.text ?? event.data.content?.[0]?.text)

function world() {
  const session = new Session('mirror-1')
  const bot = { id: 'joined:n1:b1', origin: 'joined', sessionId: 'mirror-1', worker: { nodeId: 'n1', remoteBotId: 'b1', home: 'remote', online: true } }
  const rt = { state: { bots: { [bot.id]: bot } }, botOf: id => rt.state.bots[id], save: async () => {}, warn: () => {}, ctx: { sessions: { flush: async () => {} } } }
  const sync = items => syncJoinedHistory(rt, bot, items, session, () => true, {})
  return { rt, bot, session, sync }
}

test('a mirror with live turns takes the history up to now as it is; the first sync writes nothing', async () => {
  const w = world()
  live(w.session, 'ask 1', 'answer 1')
  const before = w.session.log.length
  const result = await w.sync([...group(1, 2, 'ask 1', 'answer 1'), ...group(2, 4, 'a routine ran', 'routine done')])
  assert.match(result.deferred, /history up to now is kept/)
  assert.equal(w.session.log.length, before, 'nothing is rewritten on a guess')
  assert.deepEqual(w.bot.historyBaseline.parts, { 'part-a': 4 })
})

test('what the node adds afterwards is imported; a live turn is recognised by what was said and not shown twice', async () => {
  const w = world()
  live(w.session, 'ask 1', 'answer 1')
  const old = [...group(1, 2, 'ask 1', 'answer 1'), ...group(2, 4, 'a routine ran', 'routine done')]
  await w.sync(old)
  // later: the user asks again from the hub (written live, no identity), and the node does a turn of its own
  live(w.session, '[Message from Chief]\nask 2', 'answer 2')
  const items = [...old, ...group(3, 6, 'an IM message came in', 'replied on IM'), ...group(4, 8, 'ask 2', 'answer 2')]
  const result = await w.sync(items)
  assert.equal(result.migrated?.imported, 1, 'only the turn the node produced on its own')
  assert.deepEqual(texts(w.session, 'user/message').filter(text => /ask 2/.test(text)).length, 1, 'the live turn is not repeated')
  assert.ok(texts(w.session, 'assistant/message').includes('replied on IM'))
  assert.equal(texts(w.session, 'assistant/message').filter(text => text === 'answer 2').length, 1)
  // and a second sync of the same history changes nothing
  const size = w.session.log.length
  await w.sync(items)
  assert.equal(w.session.log.length, size)
})

test('a mirror without live turns is imported the way it always was', async () => {
  const w = world()
  const result = await w.sync([...group(1, 2, 'ask 1', 'answer 1')])
  assert.equal(result.migrated?.imported, 1)
  assert.equal(w.bot.historyBaseline, undefined)
})
