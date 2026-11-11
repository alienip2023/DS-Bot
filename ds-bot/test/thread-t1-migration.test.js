// test/thread-t1-migration.test.js
// P1-T1 (docs/thread-model.md §1, §5, §9): the real v1 → v2 migration, run through
// install(rt) + rt.load() on a real state.json, and the thread-based joined routing that
// A2 requires. Nothing here re-implements the migration: it drives the product code and
// reads the saved team back.
//
// Knives (each cuts product source and must turn the named test red):
//   K1 migrateThreads skips Main creation        → "T1-migration gives every Bot …"
//   K2 indexSessions drops the thread set        → "T1-full index covers …"
//   K3 migrateThreads forgets the version bump   → "T1-empty team and fresh install …"
//   K4 joinedBotOfSession checks bot.sessionId   → "T1-joined routing follows …"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { install, migrateThreads } from '../src/host/store.js'
import { joinedBotOfSession } from '../src/host/joined-prompt.js'
import { mainThreadId, threadsOfBot } from '../src/host/bot-store.js'

const homes = []
const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'thread-t1-'))
  homes.push(home)
  return home
}

// A v1 team as an installed DS Bot would have saved it: a local Bot with an archived
// segment, a joined Bot on a remote node, and a Bot that never got a Session.
function v1State() {
  return {
    version: 1,
    mainBotIds: ['alpha'],
    bots: {
      alpha: {
        id: 'alpha', name: 'Alpha', role: '', origin: 'local', createdAt: 1000,
        sessionId: 'session-alpha', model: 'deepseek-official/deepseek-flash',
        segments: [{ sessionId: 'session-alpha-old', title: 'part 1', time: 900 }],
      },
      beta: {
        id: 'beta', name: 'Beta', role: '', origin: 'joined', createdAt: 2000,
        sessionId: 'session-beta',
        worker: { nodeId: 'node-1', remoteBotId: 'remote-beta', hostname: 'node-1', home: 'remote', online: true, lastSeen: null },
      },
      gamma: { id: 'gamma', name: 'Gamma', role: '', createdAt: 3000 },
    },
    rooms: {},
    agents: {},
    sections: [],
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    works: {},
    requests: {},
    questions: {},
    views: {},
    closedCards: {},
    closedViews: {},
    prefs: {},
    switching: {},
    privateArchives: [],
    revision: 0,
  }
}

// A Thread saved beyond Main, to prove the indexes cover every thread rather than only
// the one the migration makes.
function secondBetaThread() {
  return {
    id: 'thread-beta-2', botId: 'beta', title: 'Second', createdAt: 2500, updatedAt: 2500,
    archived: false, model: null, effort: null, workDir: null, sessionId: 'session-beta-2',
    parentThreadId: null, parentTurn: null, lastSeq: 0, unread: 0, running: false, queued: 0,
  }
}

function runtime(home, state) {
  if (state !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = { effect: () => {}, on: () => {}, emit: () => {}, emitAsync: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  const rt = {
    ctx,
    home,
    statePath: join(home, 'state.json'),
    warn: () => {},
    retitleRoom: async () => {},
    keepGroupLine: (roomId, line) => line,
    autoRoomName: members => (members ?? []).join(', '),
  }
  install(rt)
  return rt
}

async function loaded(state) {
  const rt = runtime(makeHome(), state)
  await rt.load()
  return rt
}

after(() => {
  for (const home of homes) {
    try { rmSync(home, { recursive: true }) } catch {}
  }
})

describe('P1-T1 thread model: migration and joined routing', () => {
  it('T1-migration gives every Bot exactly one Main thread, whose Session is the Bot Session', async () => {
    const rt = await loaded(v1State())

    assert.equal(rt.state.version, 2, 'the loaded team is v2')
    assert.equal(Object.keys(rt.state.threads).length, 3, 'one Main thread for each of the three Bots')

    for (const bot of Object.values(rt.state.bots)) {
      const threads = threadsOfBot(rt.state, bot.id)
      assert.equal(threads.length, 1, `${bot.id} has exactly one thread`)
      const [thread] = threads
      assert.equal(thread.id, mainThreadId(bot.id))
      assert.equal(thread.botId, bot.id)
      assert.equal(thread.title, 'Main')
      assert.equal(thread.sessionId, bot.sessionId ?? null, `${bot.id}: thread.sessionId mirrors bot.sessionId`)
      assert.deepEqual(bot.threadIds, [thread.id], `${bot.id}: threadIds names its Main thread`)
      assert.equal(thread.archived, false)
      assert.equal(thread.lastSeq, 0)
      assert.equal(thread.unread, 0)
    }
    // The invariant the design states in so many words: a v1 Bot's own Session is its Main
    // thread's Session, not a copy somewhere else.
    assert.equal(threadsOfBot(rt.state, 'alpha')[0].sessionId, 'session-alpha')
    assert.equal(threadsOfBot(rt.state, 'beta')[0].sessionId, 'session-beta')
    assert.equal(threadsOfBot(rt.state, 'gamma')[0].sessionId, null)

    // The saved v1 file stays beside the new one for a manual rollback (§12).
    const backup = JSON.parse(readFileSync(join(rt.home, 'state.json.v1.bak'), 'utf8'))
    assert.equal(backup.version, 1)
    assert.equal(Object.hasOwn(backup, 'threads'), false, 'the backup is the untouched v1 file')
    const saved = JSON.parse(readFileSync(rt.statePath, 'utf8'))
    assert.equal(saved.version, 2)
    assert.equal(Object.keys(saved.threads).length, 3)
  })

  it('T1-full index covers Main, segments and extra threads; the old index still answers', async () => {
    const state = v1State()
    state.threads = { 'thread-beta-2': secondBetaThread() }
    const rt = await loaded(state)

    assert.deepEqual(rt.bySessionIdFull('session-alpha'), { botId: 'alpha', threadId: mainThreadId('alpha') })
    assert.deepEqual(rt.bySessionIdFull('session-alpha-old'), { botId: 'alpha', threadId: mainThreadId('alpha') }, 'an archived segment still resolves to its Bot Main thread')
    assert.deepEqual(rt.bySessionIdFull('session-beta'), { botId: 'beta', threadId: mainThreadId('beta') })
    assert.deepEqual(rt.bySessionIdFull('session-beta-2'), { botId: 'beta', threadId: 'thread-beta-2' }, 'a thread beyond Main resolves to that thread')
    assert.equal(rt.bySessionIdFull('no-such-session'), undefined)

    // The old lookup keeps its shape and still answers for every indexed Session.
    assert.equal(rt.bySessionId('session-alpha').id, 'alpha')
    assert.equal(rt.bySessionId('session-alpha-old').id, 'alpha')
    assert.equal(rt.bySessionId('session-beta').id, 'beta')
    assert.equal(rt.bySessionId('session-beta-2').id, 'beta')
    assert.equal(rt.bySessionId('no-such-session'), undefined)

    assert.equal(rt.threadOf('thread-beta-2').sessionId, 'session-beta-2')
    assert.equal(rt.threadOf('no-such-thread'), undefined)
    assert.equal(rt.mainThreadOf('beta').id, mainThreadId('beta'))
    assert.equal(rt.threadsOfBot('beta').length, 2)
  })

  it('T1-empty team and fresh install migrate to empty threads without throwing', async () => {
    // A team file that exists but has no Bots.
    const emptyTeam = await loaded({ version: 1 })
    assert.equal(emptyTeam.state.version, 2)
    assert.deepEqual(emptyTeam.state.threads, {})
    assert.deepEqual(JSON.parse(readFileSync(emptyTeam.statePath, 'utf8')).threads, {})

    // A brand-new install: no state.json at all.
    const fresh = await loaded(undefined)
    assert.equal(fresh.state.version, 2)
    assert.deepEqual(fresh.state.threads, {})
    assert.deepEqual(JSON.parse(readFileSync(fresh.statePath, 'utf8')).threads, {})
  })

  it('T1-joined routing follows the thread session, not the Bot mirror session', async () => {
    const state = v1State()
    state.threads = { 'thread-beta-2': secondBetaThread() }
    const rt = await loaded(state)

    assert.equal(joinedBotOfSession(rt, 'session-beta').id, 'beta', 'the Main thread routes')
    assert.equal(joinedBotOfSession(rt, 'session-beta-2').id, 'beta', 'a second thread routes to the same joined Bot')
    assert.equal(joinedBotOfSession(rt, 'session-alpha'), undefined, 'a local Bot is not a joined page')
    assert.equal(joinedBotOfSession(rt, 'no-such-session'), undefined)
    assert.equal(joinedBotOfSession(rt, ''), undefined)
  })

  it('T1-a Bot added after load keeps routing until its Thread row is written', async () => {
    const rt = await loaded(v1State())
    // A joined Bot made while this host runs has no Thread row until the next load
    // (T2 creates one with the Bot); its own Session must still reach it meanwhile.
    rt.state.bots.late = {
      id: 'late', name: 'Late', role: '', origin: 'joined', createdAt: 4000,
      sessionId: 'session-late',
      worker: { nodeId: 'node-1', remoteBotId: 'remote-late', hostname: 'node-1', home: 'remote', online: true, lastSeen: null },
    }
    await rt.save()

    assert.equal(rt.threadOf(mainThreadId('late')), undefined, 'save does not invent a Thread row')
    assert.equal(joinedBotOfSession(rt, 'session-late').id, 'late')
  })

  it('T1-re-keyed mirror Session keeps the Main thread in step', async () => {
    const rt = await loaded(v1State())
    rt.state.bots.beta.sessionId = 'session-beta-new'
    rt.updateBySessionId('beta', 'session-beta', 'session-beta-new')

    assert.deepEqual(rt.bySessionIdFull('session-beta-new'), { botId: 'beta', threadId: mainThreadId('beta') })
    assert.equal(rt.bySessionIdFull('session-beta'), undefined, 'the replaced Session leaves the index')
    assert.equal(rt.threadOf(mainThreadId('beta')).sessionId, 'session-beta-new', 'the Main thread follows the re-keyed Session')
    assert.equal(joinedBotOfSession(rt, 'session-beta-new').id, 'beta')
    assert.equal(joinedBotOfSession(rt, 'session-beta'), undefined)
  })

  it('T1-migration is idempotent on an already migrated team', async () => {
    const home = makeHome()
    const first = runtime(home, v1State())
    await first.load()
    const count = Object.keys(first.state.threads).length

    // Same loaded state, migration run again: nothing is added.
    assert.equal(migrateThreads(first.state), false)
    assert.equal(Object.keys(first.state.threads).length, count)

    // A fresh host reading the saved v2 file: still one Main thread per Bot.
    const second = runtime(home)
    await second.load()
    assert.equal(Object.keys(second.state.threads).length, count)
    for (const bot of Object.values(second.state.bots)) {
      assert.equal(threadsOfBot(second.state, bot.id).length, 1)
    }
  })
})
