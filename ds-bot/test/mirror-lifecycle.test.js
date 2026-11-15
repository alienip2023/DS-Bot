import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { ensureMirrorSession } from '../src/host/mirror.js'
import { applyRosterReport, shadowId } from '../src/host/roster-join.js'
import { mainThreadOf } from '../src/host/bot-store.js'

function world() {
  const state = { bots: {}, threads: {} }
  const report = { nodeId: 'node-a', bots: [{ id: 'remote-a', name: 'Remote', role: 'Worker' }] }
  applyRosterReport(state, report)
  const id = shadowId('node-a', 'remote-a')
  const sessions = new Map()
  const persisted = []
  const index = new Map()
  let creates = 0
  const rt = {
    state,
    botOf: id => state.bots[id],
    async createSession() {
      const sid = `mirror-${++creates}`
      sessions.set(sid, new Session(sid))
      return sid
    },
    async resolveAgent(sid) { return { session: sessions.get(sid) } },
    updateBySessionId(botId, oldSid, newSid) {
      if (oldSid) index.delete(oldSid)
      if (newSid) index.set(newSid, botId)
      mainThreadOf(state, botId).sessionId = newSid ?? null
    },
    async save() { persisted.push(JSON.parse(JSON.stringify(state))) },
  }
  return { rt, id, report, sessions, persisted, index, creates: () => creates }
}

test('concurrent first opens share one mirror and one persisted Session id', async () => {
  const w = world()
  const bot = w.rt.botOf(w.id)
  const [first, second] = await Promise.all([ensureMirrorSession(w.rt, bot), ensureMirrorSession(w.rt, bot)])
  assert.equal(w.creates(), 1)
  assert.equal(first, second)
  assert.equal(first.id, w.rt.botOf(w.id).sessionId)
  assert.equal(mainThreadOf(w.rt.state, w.id).sessionId, first.id)
  assert.equal(w.persisted.length, 1)
})

test('a roster refresh during mirror creation keeps the page on the authoritative Bot row', async () => {
  const w = world()
  const bot = w.rt.botOf(w.id)
  const create = w.rt.createSession
  w.rt.createSession = async () => {
    const sid = await create()
    applyRosterReport(w.rt.state, w.report)
    return sid
  }
  const session = await ensureMirrorSession(w.rt, bot)
  assert.equal(w.rt.botOf(w.id).sessionId, session.id)
  assert.equal(w.persisted.at(-1).bots[w.id].sessionId, session.id)
  assert.equal(mainThreadOf(w.rt.state, w.id).sessionId, session.id)
  assert.equal(await ensureMirrorSession(w.rt, w.rt.botOf(w.id)), session)
  assert.equal(w.creates(), 1)
})

test('an unresolvable new mirror is never published as the Bot page', async () => {
  const w = world()
  w.rt.resolveAgent = async () => { throw new Error('session unavailable') }
  await assert.rejects(ensureMirrorSession(w.rt, w.rt.botOf(w.id)), { code: 'no-session' })
  assert.equal(w.rt.botOf(w.id).sessionId ?? null, null)
  assert.equal(mainThreadOf(w.rt.state, w.id).sessionId, null)
  assert.equal(w.index.size, 0)
  assert.equal(w.persisted.length, 0)
})

test('a failed mirror save rolls back the page and indexes, and the next open can retry', async () => {
  const w = world()
  const save = w.rt.save
  w.rt.save = async () => { throw new Error('disk unavailable') }
  await assert.rejects(ensureMirrorSession(w.rt, w.rt.botOf(w.id)), /disk unavailable/)
  assert.equal(w.rt.botOf(w.id).sessionId ?? null, null)
  assert.equal(mainThreadOf(w.rt.state, w.id).sessionId, null)
  assert.equal(w.index.size, 0)
  w.rt.save = save
  const session = await ensureMirrorSession(w.rt, w.rt.botOf(w.id))
  assert.equal(w.persisted.at(-1).bots[w.id].sessionId, session.id)
})
