import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { handleJoinedTurn, BRIDGE_DOWN_TEXT } from '../src/host/joined-turn.js'

test('a throwing transport closes the Bot-to-Bot mirror, work and result listeners', async () => {
  const bot = {
    id: 'joined:n1:r1', name: 'Remote', origin: 'joined', sessionId: 'mirror-a',
    worker: { home: 'remote', nodeId: 'n1', remoteBotId: 'r1' },
  }
  const session = new Session('mirror-a')
  const registry = new EventEmitter()
  registry.send = () => { throw new Error('connection closed while sending') }
  const bots = { [bot.id]: bot, sender: { id: 'sender', name: 'Sender' } }
  const replies = []
  const closed = []
  const rt = {
    ctx: { get: () => registry },
    state: { bots, exchanges: [] },
    botOf: id => bots[id],
    resolveAgent: async () => ({ session }),
    closeWork: (...args) => closed.push(args),
    deliver: async msg => replies.push(msg),
  }
  const result = await handleJoinedTurn(rt, { fromId: 'sender', toId: bot.id, text: 'work', role: 'request', exchangeId: 'ex-a' })
  assert.deepEqual(result, { ok: false, error: 'bridge-down' })
  assert.equal(registry.listenerCount('botTurnResult'), 0)
  assert.equal(registry.listenerCount('nodeOffline'), 0)
  assert.equal(session.log.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(session.log.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(closed.length, 1)
  assert.equal(replies.length, 1)
  assert.equal(replies[0].text, BRIDGE_DOWN_TEXT)
})
