// fork.125: the Stop button on a Bot's conversation where no turn runs, while that conversation waits for work it
// handed on, stops that work (through the core's cancel, as the page's Stop sends it).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeBot, threadWorld } from './thread-t2-world.js'

test('Stop on a conversation that only waits for what it handed on stops that work', async (t) => {
  const w = threadWorld()
  t.after(async () => { await w.ctx.dispose?.() })
  const chief = await makeBot(w, 'Chief')
  const writer = await makeBot(w, 'Writer')
  const chat = w.rt.chatOf(chief.id)
  const root = w.rt.openRootWork({ to: chief.id, part: chat })
  w.rt.openWork('child-1', { from: chief.id, to: writer.id, parent: root })
  const result = await w.ctx.sessionController.cancel({ sessionId: chat })
  assert.equal(result.accepted, true)
  assert.deepEqual(Object.keys(w.rt.state.works ?? {}), [], 'the root work and what it handed on are gone')
  assert.equal(w.rt.isStoppedWork('child-1'), true, 'its answer, if it comes, goes nowhere')
})

test('Stop while a turn runs there leaves the waiting work to that turn\'s own end', async (t) => {
  const w = threadWorld()
  t.after(async () => { await w.ctx.dispose?.() })
  const chief = await makeBot(w, 'Chief')
  const writer = await makeBot(w, 'Writer')
  const chat = w.rt.chatOf(chief.id)
  const root = w.rt.openRootWork({ to: chief.id, part: chat })
  w.rt.openWork('child-1', { from: chief.id, to: writer.id, parent: root })
  w.sessionEvent(chat, { type: 'turn/start', data: { turn: 1 } })
  await w.ctx.sessionController.cancel({ sessionId: chat })
  assert.equal(w.rt.state.works?.['child-1'] !== undefined, true)
})
