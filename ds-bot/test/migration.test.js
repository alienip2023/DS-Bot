// test/migration.test.js
// Tests for migrateLegacyJoined (roster-join.js)
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { migrateLegacyJoined } from '../src/host/roster-join.js'

const { Session } = await import('@deepseek-ai/dsh-session')

function makeJoinedBot(overrides = {}) {
  return {
    id: 'bot-j-' + randomUUID().slice(0,8),
    origin: 'joined',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true },
    sessionId: null,
    mirrorWatermark: 0,
    ...overrides,
  }
}

const DEFAULT_ITEMS = [
  { kind: 'user', text: 'Hello', seq: 1, turn: 1, time: 100 },
  { kind: 'bot', text: 'Hi', seq: 2, turn: 1, time: 200 },
  { kind: 'user', text: 'How are you?', seq: 3, turn: 2, time: 300 },
  { kind: 'bot', text: 'Great', seq: 4, turn: 2, time: 400 },
]

function makeRt(bots, { chatPageFn = null, chatPageItems = null, chatPageOffline = false } = {}) {
  const botMap = {}
  const sessions = new Map()
  const bySessionIdMap = new Map()
  const saves = []
  const warns = []
  const created = []
  const tmpDir = join(tmpdir(), 'migration-test-' + Date.now())
  mkdirSync(tmpDir, { recursive: true })

  for (const b of bots) botMap[b.id] = b

  const defaultChatPage = chatPageOffline
    ? async () => ({ items: [{ kind: 'bot', text: '节点离线', time: Date.now() }], cursor: null })
    : async (botId, cursor) => {
        const items = chatPageItems ?? DEFAULT_ITEMS
        return { items, cursor: null }
      }

  return {
    rt: {
      state: { bots: botMap },
      dshHome: tmpDir,
      botOf: (id) => botMap[id],
      bySessionId: (sid) => bySessionIdMap.get(sid),
      updateBySessionId: (botId, oldSid, newSid) => {
        if (oldSid) bySessionIdMap.delete(oldSid)
        if (newSid && botMap[botId]) bySessionIdMap.set(newSid, botMap[botId])
      },
      createSession: async (title) => {
        const sid = 'new-sid-' + randomUUID().slice(0,8)
        created.push(sid)
        const session = new Session('test-' + sid)
        sessions.set(sid, { session })
        return sid
      },
      resolveAgent: async (sid) => {
        if (!sessions.has(sid)) throw new Error('session not found: ' + sid)
        return sessions.get(sid)
      },
      joinedChatPage: chatPageFn ?? defaultChatPage,
      save: async () => saves.push(Date.now()),
      warn: (...args) => warns.push(args.join(' ')),
    },
    saves,
    warns,
    created,
    sessions,
  }
}

describe('migrateLegacyJoined', () => {
  it('S23-migrate-basic: rebuilds session from node history, old id in legacyMirrorSessionId', async () => {
    const bot = makeJoinedBot({ sessionId: 'old-sid-xyz', mirrorWatermark: 0 })
    const { rt, created, sessions } = makeRt([bot])
    const result = await migrateLegacyJoined(rt, {})
    assert.equal(result.migrated.length, 1, 'one bot migrated')
    assert.equal(result.failed.length, 0)
    assert.equal(bot.legacyMirrorSessionId, 'old-sid-xyz', 'old sessionId preserved')
    assert.ok(bot.sessionId !== 'old-sid-xyz', 'sessionId updated to new')
    assert.ok(bot.mirrorWatermark > 0, 'watermark updated')
    assert.ok(typeof bot.mirrorRebuiltAt === 'string', 'mirrorRebuiltAt set')
    assert.equal(created.length, 1, 'exactly one new session created')
    // Verify importHistory actually imported turns (not 0)
    assert.ok(result.migrated[0].imported > 0, 'must import at least one turn')
    // Verify session has turn/start events matching number of turns in DEFAULT_ITEMS (2 turns)
    const migratedSession = sessions.get(bot.sessionId)?.session
    if (migratedSession) {
      const turnStarts = migratedSession.log.filter(e => e.type === 'turn/start')
      assert.equal(turnStarts.length, 2, 'session must have 2 turn/start events (DEFAULT_ITEMS has 2 turns)')
    } else {
      assert.fail('session not found for migrated bot')
    }
  })

  it('S23-migrate-skip: watermark >= maxSeq → skip, no new session', async () => {
    const bot = makeJoinedBot({ sessionId: 'existing-sid', mirrorWatermark: 100 })
    const { rt, created, sessions } = makeRt([bot])
    const result = await migrateLegacyJoined(rt, {})
    assert.equal(result.skipped.length, 1)
    assert.equal(result.migrated.length, 0)
    assert.equal(created.length, 0, 'no new session when watermark >= maxSeq')
    assert.equal(bot.sessionId, 'existing-sid', 'sessionId unchanged')
  })

  it('S23-migrate-offline: node offline → failed, no session created, original sessionId unchanged', async () => {
    const bot = makeJoinedBot({ sessionId: 'intact-sid', mirrorWatermark: 0 })
    const { rt, created } = makeRt([bot], { chatPageOffline: true })
    const result = await migrateLegacyJoined(rt, {})
    assert.equal(result.failed.length, 1, 'offline bot must be failed')
    assert.equal(created.length, 0, 'no session created for offline bot')
    assert.equal(bot.sessionId, 'intact-sid', 'sessionId must remain unchanged after offline')
  })

  it('S23-migrate-empty-no-session: empty history + no sessionId → session built, 0 turns, watermark=0', async () => {
    const bot = makeJoinedBot({ sessionId: null, mirrorWatermark: 0 })
    const { rt, created } = makeRt([bot], { chatPageItems: [] })
    const result = await migrateLegacyJoined(rt, {})
    assert.equal(result.migrated.length, 1, 'empty history + no sessionId must build session')
    assert.equal(result.failed.length, 0)
    assert.equal(created.length, 1, 'one session created')
    assert.equal(bot.mirrorWatermark, 0, 'watermark=0 for empty history')
  })

  it('S23-migrate-empty-has-session: empty history + existing sessionId → skip, preserve mirror', async () => {
    const bot = makeJoinedBot({ sessionId: 'keep-this-sid', mirrorWatermark: 3 })
    const { rt, created } = makeRt([bot], { chatPageItems: [] })
    const result = await migrateLegacyJoined(rt, {})
    assert.equal(result.skipped.length, 1, 'empty history with existing sessionId must skip')
    assert.equal(created.length, 0, 'no new session created')
    assert.equal(bot.sessionId, 'keep-this-sid', 'sessionId preserved')
  })

  it('S23-migrate-pagination: multi-page history concatenated in time order', async () => {
    // Knife: delete allItems.reverse() → items in wrong order → import turn seqs out of order
    const bot = makeJoinedBot({ sessionId: null, mirrorWatermark: 0 })
    let pageCall = 0
    // Simulate newest-first pagination: first page has newer items (turn 5-6), second has older (turn 1-4)
    const chatPageFn = async (botId, cursor) => {
      pageCall++
      if (pageCall === 1) return {
        items: [
          { kind: 'user', text: 'msg5', seq: 9, turn: 5, time: 900 },
          { kind: 'bot', text: 'reply5', seq: 10, turn: 5, time: 1000 },
          { kind: 'user', text: 'msg6', seq: 11, turn: 6, time: 1100 },
          { kind: 'bot', text: 'reply6', seq: 12, turn: 6, time: 1200 },
        ],
        cursor: { part: 0, at: 3 },
      }
      return {
        items: [
          { kind: 'user', text: 'msg1', seq: 1, turn: 1, time: 100 },
          { kind: 'bot', text: 'reply1', seq: 2, turn: 1, time: 200 },
          { kind: 'user', text: 'msg2', seq: 3, turn: 2, time: 300 },
          { kind: 'bot', text: 'reply2', seq: 4, turn: 2, time: 400 },
          { kind: 'user', text: 'msg3', seq: 5, turn: 3, time: 500 },
          { kind: 'bot', text: 'reply3', seq: 6, turn: 3, time: 600 },
          { kind: 'user', text: 'msg4', seq: 7, turn: 4, time: 700 },
          { kind: 'bot', text: 'reply4', seq: 8, turn: 4, time: 800 },
        ],
        cursor: null,
      }
    }
    const { rt, sessions } = makeRt([bot], { chatPageFn })
    const result = await migrateLegacyJoined(rt, {})
    assert.equal(result.migrated.length, 1)
    const session = sessions.get(bot.sessionId)?.session
    assert.ok(session, 'session created')
    const turnStarts = session.log.filter(e => e.type === 'turn/start').map(e => e.data.turn)
    assert.equal(turnStarts.length, 6, '6 turns imported (1-6 in order)')
    assert.deepEqual(turnStarts, [1,2,3,4,5,6], 'turns must be in time order, not newest-first')
  })

  it('S23-migrate-fail: single bot failure (save throws) does not abort others, rolls back state', async () => {
    const bot1 = makeJoinedBot({ id: 'bot-fail', mirrorWatermark: 0 })
    const bot2 = makeJoinedBot({ id: 'bot-ok', mirrorWatermark: 0 })
    const origSessionId1 = bot1.sessionId
    const { rt } = makeRt([bot1, bot2])
    // Make bot1 fail at rt.save (not in inner try/catch → exercises outer catch)
    const origSave = rt.save
    let saveCount = 0
    rt.save = async () => {
      saveCount++
      if (saveCount === 1) throw new Error('save failed for bot1')
      return origSave()
    }
    const result = await migrateLegacyJoined(rt, {})
    assert.equal(result.failed.length, 1, 'bot-fail must be in failed')
    assert.equal(result.migrated.length, 1, 'bot-ok must still be migrated despite bot-fail error')
    // Rollback: bot1 state must be reverted after save failure
    assert.equal(bot1.sessionId, origSessionId1, 'bot1 sessionId must be rolled back after save failure')
    assert.equal(bot1.mirrorWatermark, 0, 'bot1 watermark must be rolled back after save failure')
  })


  it('S23-migrate-rebuild: existing mirror with fewer turns → rebuild, sessionId changes, events in node order', async () => {
    const bot = makeJoinedBot({ sessionId: 'old-partial-mirror', mirrorWatermark: 6 })
    // Simulate node having 18 turns of history, mirror only had 3
    const nodeItems = []
    for (let t = 1; t <= 18; t++) {
      nodeItems.push({ kind: 'user', text: `msg${t}`, seq: t * 2 - 1, turn: t, time: t * 100 })
      nodeItems.push({ kind: 'bot', text: `reply${t}`, seq: t * 2, turn: t, time: t * 100 + 50 })
    }
    const { rt, sessions, created } = makeRt([bot], { chatPageItems: nodeItems })
    const oldSid = bot.sessionId
    const result = await migrateLegacyJoined(rt, {})
    assert.equal(result.migrated.length, 1, 'bot must be migrated (rebuild)')
    assert.equal(result.failed.length, 0)
    assert.notEqual(bot.sessionId, oldSid, 'sessionId must change (new session created)')
    assert.equal(bot.legacyMirrorSessionId, oldSid, 'old sessionId preserved in legacyMirrorSessionId')
    assert.equal(bot.mirrorWatermark, 36, 'watermark = maxSeq = 36 (18 turns × 2 events)')
    assert.equal(created.length, 1, 'exactly one new session created')
    // Verify session has 18 turn/start events in order 1..18
    const migratedSession = sessions.get(bot.sessionId)?.session
    assert.ok(migratedSession, 'session must exist')
    const turnStarts = migratedSession.log.filter(e => e.type === 'turn/start')
    assert.equal(turnStarts.length, 18, 'session must have 18 turn/start events')
    assert.deepEqual(turnStarts.map(e => e.data.turn), Array.from({length: 18}, (_, i) => i + 1), 'turns must be 1..18 in order')
    // Verify content: first turn should have msg1/reply1
    const userMsgs = migratedSession.log.filter(e => e.type === 'user/message')
    assert.equal(userMsgs.length, 18, '18 user messages')
    assert.equal(userMsgs[0].data?.content?.[0]?.text ?? userMsgs[0].data?.content, 'msg1', 'first user message is msg1 (time order)')
    assert.equal(userMsgs[17].data?.content?.[0]?.text ?? userMsgs[17].data?.content, 'msg18', 'last user message is msg18')
  })

  it('S23-migrate-dryrun: dryRun=true → wouldRebuild list, zero writes, no session created', async () => {
    const bot = makeJoinedBot({ sessionId: 'dry-sid', mirrorWatermark: 0 })
    const { rt, created, saves } = makeRt([bot])
    const result = await migrateLegacyJoined(rt, { dryRun: true })
    assert.ok(Array.isArray(result.wouldRebuild), 'dryRun returns wouldRebuild')
    assert.equal(result.wouldRebuild.length, 1)
    assert.equal(created.length, 0, 'dryRun must not create sessions')
    assert.equal(saves.length, 0, 'dryRun must not save state')
    assert.equal(bot.sessionId, 'dry-sid', 'dryRun must not change sessionId')
  })
})
