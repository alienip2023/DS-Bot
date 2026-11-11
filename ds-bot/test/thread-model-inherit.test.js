import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeBot, threadWorld } from './thread-t2-world.js'

// The model catalog these tests run against: two models of one provider.
function stubCatalog(w) {
  w.ctx.llm = {
    listProviders: () => [{ id: 't3astub', name: 'Stub' }],
    listModels: async () => [{ id: 'stub', name: 'Stub' }, { id: 'stub2', name: 'Stub Two' }],
    resolveModelInfo: async () => ({}),
    registerAdapter: () => ({ replace() {} }),
  }
}

function selectionFor(w, sessionId) {
  return w.selections.find(selection => selection.sessionId === sessionId)
}

test('a new Thread Session is selected on the Bot model, not the profile default', async () => {
  const w = threadWorld()
  stubCatalog(w)
  const bot = await makeBot(w)
  bot.model = 't3astub/stub'
  bot.appliedModel = 't3astub/stub'
  await w.rt.save()

  const created = await w.call('thread-create', { botId: bot.id })
  assert.equal(created.ok, true)
  const sessionId = created.value.sessionId

  assert.deepEqual(selectionFor(w, sessionId), { sessionId, provider: 't3astub', model: 'stub' })
  assert.equal(created.value.thread.model, null)
})

test('changing a Bot model re-selects the Sessions of its Threads', async () => {
  const w = threadWorld()
  stubCatalog(w)
  const bot = await makeBot(w)
  bot.model = 't3astub/stub'
  bot.appliedModel = 't3astub/stub'
  await w.rt.save()
  const created = await w.call('thread-create', { botId: bot.id })
  const sessionId = created.value.sessionId
  w.selections.length = 0

  bot.model = 't3astub/stub2'
  await w.rt.applyModel(bot, { force: true })

  assert.deepEqual(selectionFor(w, sessionId), { sessionId, provider: 't3astub', model: 'stub2' })
  assert.equal(bot.appliedModel, 't3astub/stub2')
})

test('a Bot with no model leaves its Thread Session unselected, as Main is', async () => {
  const w = threadWorld()
  stubCatalog(w)
  const bot = await makeBot(w)

  const created = await w.call('thread-create', { botId: bot.id })
  assert.equal(created.ok, true)
  assert.equal(selectionFor(w, created.value.sessionId), undefined)
})
