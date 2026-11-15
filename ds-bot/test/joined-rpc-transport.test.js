import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createBotOnNode } from '../src/host/joined-create.js'
import { joinedChatPage, joinedUpdateBot, joinedDeleteBot } from '../src/host/joined-page.js'

function world() {
  const registry = new EventEmitter()
  const node = { nodeId: 'n1', online: true }
  registry.nodes = new Map([['n1', node]])
  registry.onlineNodes = () => [node]
  registry.send = () => true
  const bot = { id: 'joined:n1:r1', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'r1', home: 'remote' } }
  const rt = {
    ctx: { get: () => registry },
    state: { bots: { [bot.id]: bot } },
    botOf: id => id === bot.id ? bot : undefined,
  }
  return { rt, registry, bot }
}

const calls = [
  ['history', 'botHistoryResult', ({ rt, bot }) => joinedChatPage(rt, bot.id)],
  ['create', 'botCreateResult', ({ rt }) => createBotOnNode(rt, { nodeId: 'n1', name: 'Remote' })],
  ['update', 'botUpdateResult', ({ rt, bot }) => joinedUpdateBot(rt, bot.id, { model: 'model-a' })],
  ['delete', 'botDeleteResult', ({ rt, bot }) => joinedDeleteBot(rt, bot.id)],
]

for (const [name, event, call] of calls) {
  test(`${name} cancels its result wait when the transport throws`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const w = world()
    w.registry.send = () => { throw new Error('connection closed while sending') }
    const result = await call(w).catch(error => ({ error: error.message }))
    assert.equal(w.registry.listenerCount(event), 0)
    assert.equal(w.registry.listenerCount('nodeOffline'), 0)
    if (name === 'history') {
      assert.equal(result.cursor, null)
      assert.match(result.items[0].text, /桥已断/)
    } else assert.deepEqual(result, { ok: false, error: 'bridge-down' })
  })
}

test('failed create model resolution leaves no result listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = world()
  w.rt.resolveModel = async () => { throw new Error('unknown model') }
  const result = await createBotOnNode(w.rt, { nodeId: 'n1', name: 'Remote', modelRef: 'unknown' })
  assert.deepEqual(result, { ok: false, error: 'bot-create-model-unknown' })
  assert.equal(w.registry.listenerCount('botCreateResult'), 0)
  assert.equal(w.registry.listenerCount('nodeOffline'), 0)
})

for (const [name, event, call] of calls.slice(2)) {
  test(`${name} settles on its node going offline and releases both listeners`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const w = world()
    const pending = call(w)
    w.registry.emit('nodeOffline', { nodeId: 'another-node' })
    assert.equal(w.registry.listenerCount(event), 1)
    w.registry.emit('nodeOffline', { nodeId: 'n1' })
    t.mock.timers.tick(30000)
    assert.deepEqual(await pending, { ok: false, error: 'bridge-down' })
    assert.equal(w.registry.listenerCount(event), 0)
    assert.equal(w.registry.listenerCount('nodeOffline'), 0)
  })
}
