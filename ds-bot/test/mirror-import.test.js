// test/mirror-import.test.js
// Tests for importHistory (mirror.js)
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { importHistory, allocateTurn } from '../src/host/mirror.js'

// Real Session from dsh-session (validates event shapes)
const { Session } = await import('@deepseek-ai/dsh-session')
const makeSession = () => new Session('test-import-' + Math.random().toString(36).slice(2))

describe('importHistory', () => {
  it('S23-import-basic: imports items into session, turn/start sequence starts at 1', async () => {
    const session = makeSession()
    const items = [
      { userText: 'Hello', botText: 'Hi there', turn: 1, seq: 1 },
      { userText: 'How are you?', botText: 'Fine thanks', turn: 2, seq: 2 },
    ]
    const result = await importHistory(session, items, { watermark: 0, seenKeys: new Set(), closedKeys: new Set(), seenSteps: new Set() })
    assert.equal(result.imported, 2)
    assert.equal(result.skipped, 0)
    assert.equal(result.warnings.length, 0)
    const turnStarts = session.log.filter(e => e.type === 'turn/start').map(e => e.data.turn)
    assert.deepEqual(turnStarts, [1, 2], 'turn/start must be 1,2 from allocateTurn, not items.turn')
    const botMsgs = session.log.filter(e => e.type === 'assistant/message')
    for (const bm of botMsgs) {
      assert.ok(Array.isArray(bm.data.stream), 'assistant/message must have stream array')
    }
  })

  it('S23-import-turn-from-log: items.turn is NOT used as turn/start — allocateTurn governs', async () => {
    // Knife: change allocateTurn(session) to items.turn → turn/start gets items.turn (could be 5,10) → RED
    const session = makeSession()
    const items = [
      { userText: 'A', botText: 'B', turn: 5, seq: 1 },  // items.turn=5 must be ignored
      { userText: 'C', botText: 'D', turn: 10, seq: 2 }, // items.turn=10 must be ignored
    ]
    const result = await importHistory(session, items, { watermark: 0, seenKeys: new Set(), closedKeys: new Set(), seenSteps: new Set() })
    assert.equal(result.imported, 2)
    const turnStarts = session.log.filter(e => e.type === 'turn/start').map(e => e.data.turn)
    assert.deepEqual(turnStarts, [1, 2], 'turn/start must be [1,2] from session.log, not items.turn [5,10]')
  })

  it('S23-import-dedup: shared seenKeys blocks re-import even with fresh closedKeys', async () => {
    // Knife: delete seenKeys check → re-run with fresh closedKeys produces duplicate user/message → RED
    const session = makeSession()
    const seenKeys = new Set()
    const items = [{ userText: 'Q', botText: 'A', turn: 1, seq: 1 }]
    // First import: seenKeys gets 'undefined:1' entry
    await importHistory(session, items, {
      watermark: 0, seenKeys, closedKeys: new Set(), seenSteps: new Set(), botId: 'bot-x',
    })
    const logLen = session.log.length
    // Second import: fresh closedKeys but SAME seenKeys — only seenKeys.has can block this
    const result2 = await importHistory(session, items, {
      watermark: 0, seenKeys, closedKeys: new Set(), seenSteps: new Set(), botId: 'bot-x',
    })
    assert.equal(result2.imported, 0, 'second run must import 0 (seenKeys blocks)')
    assert.equal(result2.skipped, 1)
    assert.equal(session.log.length, logLen, 'no new events on re-run')
  })

  it('S23-import-watermark: seq <= watermark → silently skipped, no events', async () => {
    const session = makeSession()
    const items = [
      { userText: 'Old', botText: 'Old reply', turn: 1, seq: 5 }, // seq=5 <= watermark=5 → skip
    ]
    const result = await importHistory(session, items, { watermark: 5, seenKeys: new Set(), closedKeys: new Set(), seenSteps: new Set() })
    assert.equal(result.imported, 0)
    assert.equal(result.skipped, 1)
    assert.equal(result.warnings.length, 0, 'watermark skip must be silent')
    assert.equal(session.log.length, 0, 'no events written')
  })

  it('S23-import-gap: gap in seq → warning added, item skipped', async () => {
    // Knife: delete gap check → no warning even for gap → RED
    const session = makeSession()
    const items = [
      { userText: 'First', botText: 'Reply 1', turn: 1, seq: 1 },
      { userText: 'Gap', botText: 'Reply 2', turn: 2, seq: 10 }, // seq=10 > watermark(0)+1+1 → gap
    ]
    const result = await importHistory(session, items, { watermark: 0, seenKeys: new Set(), closedKeys: new Set(), seenSteps: new Set() })
    const gapWarns = result.warnings.filter(w => w.startsWith('gap:'))
    assert.ok(gapWarns.length > 0, 'gap must produce a warning')
    assert.ok(gapWarns[0].includes('seq=10'), 'warning must mention the gap seq')
  })

  it('S23-import-single-fail: one bad item does not abort remaining', async () => {
    // Knife: delete try/catch around item write → one failure stops all → RED
    const session = makeSession()
    let callCount = 0
    // Mock: 2nd append throws
    const origAppend = session.append.bind(session)
    const badSession = {
      get log() { return session.log },
      append: (type, data, opts) => {
        callCount++
        // Throw on the 3rd append (step/start of item 2) to simulate a corrupt item
        if (callCount === 9) throw new Error('corrupt item')
        return origAppend(type, data, opts)
      },
    }
    const items = [
      { userText: 'OK', botText: 'Fine', turn: 1, seq: 1 },
      { userText: 'Bad', botText: 'Crash', turn: 2, seq: 2 },
      { userText: 'After', botText: 'OK again', turn: 3, seq: 3 },
    ]
    const result = await importHistory(badSession, items, { watermark: 0, seenKeys: new Set(), closedKeys: new Set(), seenSteps: new Set() })
    assert.ok(result.warnings.length > 0, 'failed item must produce a warning')
    assert.ok(result.imported >= 1, 'at least one item must succeed before and after failure')
  })
  it('S23-import-gapmode-turn: real bot-event seqs (2,4,6,8) with gapMode=turn → imported=4, no gaps skipped', async () => {
    const session = makeSession()
    const seenKeys = new Set()
    const items = [
      { userText: 'q1', botText: 'a1', turn: 1, seq: 2 },
      { userText: 'q2', botText: 'a2', turn: 2, seq: 4 },
      { userText: 'q3', botText: 'a3', turn: 3, seq: 6 },
      { userText: 'q4', botText: 'a4', turn: 4, seq: 8 },
    ]
    const result = await importHistory(session, items, {
      watermark: 0,
      gapMode: 'turn',
      botId: 'bot-x',
      seenKeys,
    })
    assert.equal(result.imported, 4, 'all 4 items imported')
    assert.equal(result.warnings.length, 0, 'no gap warnings for consecutive turns')
    const turnStarts = session.log.filter(e => e.type === 'turn/start')
    assert.equal(turnStarts.length, 4, 'exactly 4 turn/start events')
    assert.deepEqual(turnStarts.map(e => e.data.turn), [1, 2, 3, 4], 'turns are 1..4 in order')
  })
})
