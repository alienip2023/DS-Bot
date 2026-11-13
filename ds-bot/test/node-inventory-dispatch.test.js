// M2: a node-owned Bot takes a turn over bot/turn. The hub must not open a mirror
// Session for it, must not block the sender while the node works, and the page's own
// send must return the answer instead of writing a local exchange.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inventory, seedTeam, settle, startWorld } from './node-inventory-world.js'

const NODE_BOT = 'node:n1:rb1'

function nodeTeam(over = {}) {
  return seedTeam({
    bots: {
      [NODE_BOT]: {
        id: NODE_BOT, name: 'NodeOne', role: 'N', origin: 'node', type: 'remote-worker',
        managedBy: 'node', readonly: true, dispatchable: true, createdAt: 5,
        worker: { home: 'node', nodeId: 'n1', remoteBotId: 'rb1', hostname: 'box-1', online: true, ...(over.worker ?? {}) },
      },
    },
  })
}

const botTurn = (w) => w.frames.find(frame => frame.type === 'bot/turn')

test('D12 message_bot to a node Bot sends bot/turn, returns at once, and records the later reply', async (t) => {
  const w = await startWorld(nodeTeam())
  t.after(w.stop)
  const reply = await w.rt.teamTools.find(def => def.name === 'message_bot')
    .execute({ to: 'NodeOne', message: 'please do it' }, { agent: { id: 'a' } })
  assert.equal(reply, 'Delivered to NodeOne on box-1. Its reply will arrive later as a new message; do not wait for it.')
  const frame = botTurn(w)
  assert.equal(frame.nodeId, 'n1')
  assert.deepEqual(frame.payload, { nodeId: 'n1', remoteBotId: 'rb1', exchangeId: frame.payload.exchangeId, text: 'please do it' })
  // No mirror Session, no local Session lookup for the node row.
  assert.equal(Object.values(w.rt.state.threads).some(thread => thread.botId === NODE_BOT), false)
  w.registry.emit('botTurnResult', { exchangeId: frame.payload.exchangeId, ok: true, text: 'done on the node', seq: 3 })
  await settle()
  assert.equal(w.rt.state.exchanges.at(-1).text, 'done on the node')
  assert.equal(w.rt.state.exchanges.at(-1).role, 'reply')
})

test('D13 the reply a node turn produces comes back to the sender as a message', async (t) => {
  const w = await startWorld(nodeTeam())
  t.after(w.stop)
  await w.rt.teamTools.find(def => def.name === 'message_bot')
    .execute({ to: 'NodeOne', message: 'work' }, { agent: { id: 'a' } })
  const xid = botTurn(w).payload.exchangeId
  assert.notEqual(w.rt.state.works[xid], undefined, 'the request opened a work')
  w.registry.emit('botTurnResult', { exchangeId: xid, ok: true, text: 'finished', seq: 2 })
  await settle()
  // Like a joined reply, the answer is an exchange for the sender; the work itself stays
  // open until the sender's next turn reads the answer (turns.js takenWork), so it can
  // never be settled behind that turn's back.
  const reply = w.rt.state.exchanges.find(entry => entry.replyTo === xid)
  assert.equal(reply.text, 'finished')
  assert.equal(reply.from, NODE_BOT)
  assert.equal(reply.to, 'a')
  assert.notEqual(w.rt.state.works[xid], undefined)
})

test('D14 the page send returns the node answer without a local exchange or Thread', async (t) => {
  const w = await startWorld(nodeTeam())
  t.after(w.stop)
  const before = w.rt.state.exchanges.length
  const pending = w.rt.sendUser({ sessionId: NODE_BOT, content: 'from the page', requestId: 'req-page' })
  await settle(2)
  const frame = botTurn(w)
  assert.equal(frame.payload.text, 'from the page')
  w.registry.emit('botTurnResult', { exchangeId: 'req-page', ok: true, text: 'page answer', seq: 4 })
  const shown = await pending
  assert.deepEqual(shown, { ok: true, botId: NODE_BOT, text: 'page answer', requestId: 'req-page' })
  assert.equal(w.rt.state.exchanges.length, before, 'no exchange is written for a page send')
  assert.equal(Object.values(w.rt.state.threads).some(thread => thread.botId === NODE_BOT), false)
})

test('D15 an offline node fails the delivery fast, with no frame and no open work', async (t) => {
  const w = await startWorld(nodeTeam({ worker: { online: false } }))
  t.after(w.stop)
  const worksBefore = Object.keys(w.rt.state.works).length
  await assert.rejects(
    () => w.rt.teamTools.find(def => def.name === 'message_bot').execute({ to: 'NodeOne', message: 'hi' }, { agent: { id: 'a' } }),
    /E_NODE_OFFLINE/,
  )
  assert.equal(w.frames.filter(frame => frame.type === 'bot/turn').length, 0)
  assert.equal(Object.keys(w.rt.state.works).length, worksBefore)
})

test('D16 the chat page of a node Bot reads bot/history from its machine', async (t) => {
  const w = await startWorld(nodeTeam())
  t.after(w.stop)
  w.registry.nodes.set('n1', { nodeId: 'n1', online: true })
  const pending = w.call('chat', { botId: NODE_BOT })
  await settle(2)
  const frame = w.frames.find(f => f.type === 'bot/history')
  assert.equal(frame.nodeId, 'n1')
  assert.equal(frame.payload.remoteBotId, 'rb1')
  w.registry.emit('botHistoryResult', {
    requestId: frame.payload.requestId,
    ok: true,
    sessionId: 'remote-session',
    items: [{ kind: 'bot', text: 'remote history', time: 10 }],
    cursor: null,
  })
  const page = await pending
  assert.equal(page.ok, true)
  assert.deepEqual(page.value.items, [{ kind: 'bot', text: 'remote history', time: 10 }])
})

test('D17 stop_bot says the node turn cannot be stopped instead of "not running"', async (t) => {
  const w = await startWorld(nodeTeam())
  t.after(w.stop)
  await assert.rejects(
    () => w.rt.teamTools.find(def => def.name === 'stop_bot').execute({ bot: 'NodeOne', reason: 'stop' }, { agent: { id: 'a' } }),
    /E_NODE_STOP_UNSUPPORTED/,
  )
  assert.equal(w.frames.filter(frame => frame.type === 'bot/stop').length, 0)
})
