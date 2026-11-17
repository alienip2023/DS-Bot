import test from 'node:test'
import assert from 'node:assert/strict'
import { install as installDelivery } from '../src/host/delivery.js'
import { shadowId } from '../src/host/roster-join.js'

function delivery(target) {
  const sender = { id: 'local', name: 'Local', type: 'normal' }
  const bots = { [sender.id]: sender, [target.id]: target }
  const events = []
  const records = []
  const joined = []
  const remote = []
  const messages = []
  const agent = { session: {}, followup(message) { messages.push(message) } }
  const rt = {
    ctx: {
      sessions: { flush: async () => {} },
      sessionController: { resolveAgent: async () => ({ agent }) },
    },
    state: { bots, exchanges: [] },
    ledger: {
      importer() {},
      records: () => records,
      append(name, record) { events.push(`book:${name}`); records.push(record) },
      async written() { await Promise.resolve(); events.push('written') },
    },
    botOf: id => bots[id],
    roomOf: () => undefined,
    chatOf: id => `chat:${id}`,
    ensureCapabilities: async () => {},
    hideBotUnusedTools() {},
    save: async () => {},
    handleJoinedTurn(message) { events.push('joined'); joined.push(message); return 'joined-turn' },
    handleRemoteTurn(message) { remote.push(message); return 'remote-turn' },
  }
  installDelivery(rt)
  return { rt, sender, events, records, joined, remote, messages }
}

function shadow() {
  return {
    id: shadowId('node-a', 'alpha'), name: 'Alpha', type: 'remote-worker', origin: 'joined',
    worker: { home: 'remote', nodeId: 'node-a', remoteBotId: 'alpha', hostname: 'desk-1' },
  }
}

for (const role of ['reply', 'report', 'kickoff', 'continue', 'update']) {
  test(`${role} to a joined shadow is refused without dispatch or a book write`, async () => {
    const target = shadow()
    const w = delivery(target)
    const result = await w.rt.deliver({ fromId: w.sender.id, toId: target.id, text: 'back', role })
    assert.equal(result?.error, 'joined shadow cannot dispatch', `${role} is refused: an answer or control is not new work`)
    assert.equal(result.ok, false)
    assert.equal(w.joined.length, 0, 'handleJoinedTurn is not called')
    assert.equal(w.remote.length, 0, 'joined refusal never falls through to handleRemoteTurn')
    assert.deepEqual(w.records, [], 'refused messages write no book records')
    assert.deepEqual(w.events, [], 'refused messages neither write nor flush the book')
    assert.deepEqual(w.messages, [], 'joined refusal never falls through to a local session')
    assert.deepEqual(w.rt.state.exchanges, [])
  })
}

for (const role of ['request', 'default', 'mystery']) {
  test(`${role} to a joined shadow dispatches work, booking a request before the call`, async () => {
    const target = shadow()
    const w = delivery(target)
    const exchangeId = `joined-${role}`
    const book = `pair-${[w.sender.id, target.id].sort().join('-')}`
    const result = await w.rt.deliver({ fromId: w.sender.id, toId: target.id, text: 'go', role, exchangeId })
    assert.equal(result, 'joined-turn')
    assert.equal(w.joined.length, 1)
    assert.equal(w.joined[0].role, role)
    assert.equal(w.joined[0].exchangeId, exchangeId)
    assert.equal(w.remote.length, 0)
    assert.deepEqual(w.messages, [])
    if (role === 'request') {
      assert.deepEqual(w.events, [`book:${book}`, 'written', 'joined'])
      assert.equal(w.records.length, 1)
      assert.equal(w.records[0].id, exchangeId)
      assert.equal(w.records[0].to, target.id)
    } else {
      assert.deepEqual(w.events, ['joined'])
      assert.deepEqual(w.records, [])
    }
  })
}

for (const role of ['reply', 'report', 'kickoff', 'continue', 'update']) {
  test(`${role} to a remote-worker is not dispatched back to the hub`, async () => {
    const target = { id: 'worker', name: 'Worker', type: 'remote-worker' }
    const w = delivery(target)
    await w.rt.deliver({ fromId: w.sender.id, toId: target.id, text: 'back', role })
    assert.equal(w.remote.length, 0, 'handleRemoteTurn is not called for an answer or control')
    assert.equal(w.joined.length, 0)
    assert.equal(w.messages.length, 1, 'answers and controls retain local delivery')
    assert.equal(w.messages[0].source.role, role)
  })
}

for (const role of ['request', 'default', 'mystery']) {
  test(`${role} to a remote-worker dispatches work once`, async () => {
    const target = { id: 'worker', name: 'Worker', type: 'remote-worker' }
    const w = delivery(target)
    const result = await w.rt.deliver({ fromId: w.sender.id, toId: target.id, text: 'go', role })
    assert.equal(result, 'remote-turn')
    assert.equal(w.remote.length, 1)
    assert.equal(w.remote[0].role, role)
    assert.equal(w.remote[0].toId, target.id)
    assert.equal(w.joined.length, 0)
    assert.deepEqual(w.messages, [])
  })
}
