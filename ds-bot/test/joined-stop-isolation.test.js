import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { listenBotTurnResult, settleStoppedTurns, noteStoppedExchange } from '../src/host/joined-turn.js'

test('stopping one remote Bot leaves another Bot on the same node waiting for its own result', async () => {
  const registry = new EventEmitter()
  const first = listenBotTurnResult(registry, 'stop-first', 'node-a', 1000, 'remote-first')
  const second = listenBotTurnResult(registry, 'keep-second', 'node-a', 1000, 'remote-second')
  let secondEnded = false
  second.pending.then(() => { secondEnded = true })
  try {
    assert.equal(settleStoppedTurns(registry, 'node-a', 'remote-first'), 1)
    assert.equal((await first.pending).error, 'stopped')
    await Promise.resolve()
    assert.equal(secondEnded, false)
    registry.emit('botTurnResult', { exchangeId: 'keep-second', ok: true, text: 'still completed' })
    assert.equal((await second.pending).text, 'still completed')
  } finally { first.cancel(); second.cancel() }
})

test('a stop on one registry cannot settle the same node identity in another runtime', async () => {
  const one = new EventEmitter()
  const two = new EventEmitter()
  const first = listenBotTurnResult(one, 'registry-one', 'shared-node', 1000, 'bot-a')
  const second = listenBotTurnResult(two, 'registry-two', 'shared-node', 1000, 'bot-a')
  let secondEnded = false
  second.pending.then(() => { secondEnded = true })
  try {
    assert.equal(settleStoppedTurns(one, 'shared-node', 'bot-a'), 1)
    await first.pending
    await Promise.resolve()
    assert.equal(secondEnded, false)
  } finally { first.cancel(); second.cancel() }
})

test('a stopped Bot receipt does not hide a real bridge loss for another Bot on its node', async () => {
  const registry = new EventEmitter()
  noteStoppedExchange('stop-receipt', 'receipt-node', registry)
  const other = listenBotTurnResult(registry, 'ordinary-turn', 'receipt-node', 1000, 'other-bot')
  const receipt = listenBotTurnResult(registry, 'stop-receipt', 'receipt-node', 1000, 'stopped-bot')
  try {
    registry.emit('nodeOffline', { nodeId: 'receipt-node' })
    const [stopped, lost] = await Promise.all([receipt.pending, other.pending])
    assert.equal(stopped.error, 'stopped')
    assert.equal(lost.error, 'bridge-down')
  } finally { receipt.cancel(); other.cancel() }
})
