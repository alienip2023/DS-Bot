// test/store-by-session-id.test.js
// Verify that store.js:install wires rt.bySessionId from bySessionIdMap,
// covering both bot.sessionId and segment sessionIds.
// Knife: delete the `bySessionId: sid => bySessionIdMap.get(sid)` line from
// store.js → both assertions go red.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import { install } from '../src/host/store.js'

describe('store-by-session-id: real rt.load() + bySessionId wiring', () => {
  let tmpHome, rt

  before(async () => {
    // 1. Create a temp home dir with a state.json containing:
    //    - one joined bot (sessionId: 'mirror-1')
    //    - one segment with sessionId: 'session-2'
    tmpHome = mkdtempSync(join(tmpdir(), 'store-by-sid-'))

    const state = {
      version: 1,
      mainBotIds: [],
      bots: {
        'bot-joined-1': {
          id: 'bot-joined-1',
          name: 'TestJoined',
          role: '',
          origin: 'joined',
          sessionId: 'mirror-1',
          segments: [{ sessionId: 'session-2', title: 'old part' }],
          worker: {
            nodeId: 'node-1',
            remoteBotId: 'session-r1',
            hostname: 'node-1',
            home: 'remote',
            online: false,
          },
          createdAt: Date.now(),
        },
      },
      rooms: {},
      agents: {},
      capabilities: { items: {} },
      exchanges: [],
      exchangeTurns: {},
      works: {},
      requests: {},
      questions: {},
      views: {},
      closedCards: {},
      prefs: {},
      switching: {},
      revision: 0,
      privateArchives: [],
    }
    writeFileSync(join(tmpHome, 'state.json'), JSON.stringify(state))

    // 2. Build minimal rt + ctx required by store.js install
    const ctx = {
      effect: () => {},
      on: () => {},
      emit: () => {},
      emitAsync: async () => {},
    }
    rt = {
      ctx,
      home: tmpHome,
      statePath: join(tmpHome, 'state.json'),
      warn: () => {},
    }
    // Additional methods that store.js may call during indexSessions
    rt.retitleRoom = async () => {}
    rt.ctx.sessionTitle = { rename: async () => {} }

    install(rt)
    // load() reads state.json and builds bySessionIdMap
    await rt.load()
  })

  after(() => {
    try { rmSync(tmpHome, { recursive: true }) } catch {}
  })

  it('rt.bySessionId(bot.sessionId) returns the joined bot', () => {
    const found = rt.bySessionId('mirror-1')
    assert.ok(found, 'bySessionId("mirror-1") should return the bot')
    // bySessionId may return the bot object or bot id — check id covers both
    const foundId = typeof found === 'string' ? found : found?.id
    assert.equal(foundId, 'bot-joined-1')
  })

  it('rt.bySessionId(segment.sessionId) also returns the joined bot', () => {
    const found = rt.bySessionId('session-2')
    assert.ok(found, 'bySessionId("session-2") should return the bot owning that segment')
    const foundId = typeof found === 'string' ? found : found?.id
    assert.equal(foundId, 'bot-joined-1')
  })

  it('rt.bySessionId(unknown) returns undefined', () => {
    assert.equal(rt.bySessionId('no-such-session'), undefined)
  })
})
