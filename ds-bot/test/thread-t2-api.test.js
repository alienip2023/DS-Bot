// P1-T2 host API: Threads are the unit of a Bot's Sessions. These tests drive the real
// runtime and the real route handler from channel.js; they do not reimplement any of it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { threadWorld, makeBot } from './thread-t2-world.js'
import { applyRosterReport } from '../src/host/roster-join.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

test('T2-new Bot gets a Main thread row', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const rows = w.rt.threadsOfBot(bot.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, `${bot.id}:main`)
  assert.equal(rows[0].title, 'Main')
  assert.equal(rows[0].archived, false)
  assert.equal(rows[0].botId, bot.id)
  assert.deepEqual(w.rt.state.bots[bot.id].threadIds, [rows[0].id])
})

test('T2-joined shadow gets a Main thread without a Session', async () => {
  const w = threadWorld()
  await w.rt.load()
  const created = applyRosterReport(w.rt.state, {
    nodeId: 'node-1',
    bots: [{ id: 'remote-a', name: 'Remote A', role: 'worker' }],
  }, 1_000)
  assert.equal(created.length, 1)
  const shadow = created[0]
  assert.equal(shadow.origin, 'joined')
  const rows = w.rt.threadsOfBot(shadow.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, `${shadow.id}:main`)
  assert.equal(rows[0].sessionId, null)
  assert.deepEqual(shadow.threadIds, [rows[0].id])
})

test('T2-thread-create makes a Session, a row and threadIds entry', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const res = await w.call('thread-create', { botId: bot.id, title: '  Research  ' })
  assert.equal(res.ok, true, JSON.stringify(res))
  const { thread, sessionId } = res.value
  assert.equal(thread.title, 'Research')
  assert.match(thread.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(thread.isMain, false)
  assert.equal(thread.sessionId, sessionId)
  assert.equal(w.rt.state.threads[thread.id].sessionId, sessionId)
  assert.deepEqual(w.rt.state.bots[bot.id].threadIds, [`${bot.id}:main`, thread.id])
  const renamed = w.titles.filter(entry => entry.sessionId === sessionId)
  assert.deepEqual(renamed, [{ sessionId, title: 'Research' }])
})

test('T2-thread-create refuses the eleventh thread', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  for (let i = 1; i <= 9; i += 1) {
    const res = await w.call('thread-create', { botId: bot.id, title: `Thread ${i}` })
    assert.equal(res.ok, true, `thread ${i}: ${JSON.stringify(res)}`)
  }
  assert.equal(w.rt.threadsOfBot(bot.id).length, 10)
  const res = await w.call('thread-create', { botId: bot.id, title: 'Too many' })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'bot/refused')
  assert.equal(w.rt.threadsOfBot(bot.id).length, 10)
})

test('T2-thread-rename trims and refuses empty/over-80', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const main = w.rt.threadsOfBot(bot.id)[0]
  const trimmed = await w.call('thread-rename', { threadId: main.id, title: '  Work  ' })
  assert.equal(trimmed.ok, true)
  assert.equal(trimmed.value.thread.title, 'Work')
  const empty = await w.call('thread-rename', { threadId: main.id, title: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'bot/invalid')
  const long = await w.call('thread-rename', { threadId: main.id, title: 'x'.repeat(81) })
  assert.equal(long.ok, false)
  assert.equal(long.error.code, 'bot/invalid')
  assert.equal(w.rt.state.threads[main.id].title, 'Work')
})

test('T2-thread-archive refuses Main and a running thread', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const main = w.rt.threadsOfBot(bot.id)[0]
  const refused = await w.call('thread-archive', { threadId: main.id })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/refused')

  const created = await w.call('thread-create', { botId: bot.id, title: 'Research' })
  const threadId = created.value.thread.id
  await w.call('send', { sessionId: bot.id, text: 'still answering' })
  const busy = await w.call('thread-archive', { threadId })
  assert.equal(busy.ok, false)
  assert.equal(busy.error.code, 'bot/busy')
  assert.equal(w.rt.state.threads[threadId].archived, false)

  w.sessionEvent(bot.id, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  w.sessionEvent(bot.id, { type: 'turn/end', data: { turn: 1 }, time: Date.now() })
  await tick()
  const archived = await w.call('thread-archive', { threadId })
  assert.equal(archived.ok, true)
  assert.equal(archived.value.thread.archived, true)
})

test("T2-chat with threadId reads that thread's Session", async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const created = await w.call('thread-create', { botId: bot.id, title: 'Research' })
  const thread = created.value.thread
  const res = await w.call('chat', { botId: bot.id, threadId: thread.id })
  assert.equal(res.ok, true)
  assert.equal(res.value.sessionId, created.value.sessionId)
  assert.deepEqual(res.value.items, [])
  assert.deepEqual(res.value.cursor, null)
  assert.equal(w.pageCalls.at(-1).address.sessionId, created.value.sessionId)
  assert.notEqual(w.pageCalls.at(-1).address.sessionId, bot.id)
})

test('T2-send to an archived thread is refused', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const created = await w.call('thread-create', { botId: bot.id, title: 'Research' })
  const threadId = created.value.thread.id
  assert.equal((await w.call('thread-archive', { threadId })).ok, true)
  const res = await w.call('send', { threadId, text: 'hello' })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'bot/thread-archived')
  assert.equal(w.prompts.length, 0)
})

test('T2-deleteBot removes thread rows', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const created = await w.call('thread-create', { botId: bot.id, title: 'Research' })
  const threadId = created.value.thread.id
  assert.deepEqual(Object.keys(w.rt.state.threads).sort(), [`${bot.id}:main`, threadId].sort())
  await w.rt.deleteBot(bot.id)
  assert.equal(w.rt.state.bots[bot.id], undefined)
  assert.deepEqual(Object.keys(w.rt.state.threads), [])
  assert.ok(w.archivedSessions.includes(bot.id))
  assert.ok(w.archivedSessions.includes(created.value.sessionId))
  assert.equal(w.rt.threadQueueLive(bot.id).running, null)
})

test('T2-thread ids are never reused', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const first = await w.call('thread-create', { botId: bot.id, title: 'Same' })
  assert.equal(first.ok, true)
  const firstId = first.value.thread.id
  assert.equal((await w.call('thread-archive', { threadId: firstId })).ok, true)
  assert.equal(w.rt.state.threads[firstId].archived, true)
  const second = await w.call('thread-create', { botId: bot.id, title: 'Same' })
  assert.equal(second.ok, true)
  const secondId = second.value.thread.id
  assert.notEqual(secondId, firstId)
  assert.match(secondId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(secondId.includes('Same'), false)
  assert.equal(w.rt.state.threads[firstId].archived, true)
  assert.equal(w.rt.state.threads[secondId].archived, false)
})

test('T3a-thread-owner names the Bot and Thread of a Thread Session', async () => {
  const w = threadWorld()
  const bot = await makeBot(w)
  const created = await w.call('thread-create', { botId: bot.id, title: 'Research' })
  const { thread, sessionId } = created.value
  const owner = await w.call('thread-owner', { sessionId })
  assert.equal(owner.ok, true, JSON.stringify(owner))
  assert.deepEqual(owner.value, { botId: bot.id, threadId: thread.id })
})

test('T3a-thread-owner answers null for a Session no Thread owns', async () => {
  const w = threadWorld()
  await makeBot(w)
  assert.equal((await w.call('thread-owner', { sessionId: 'no-such-session' })).value, null)
  assert.equal((await w.call('thread-owner', { sessionId: '' })).value, null)
  assert.equal((await w.call('thread-owner', {})).value, null)
})
