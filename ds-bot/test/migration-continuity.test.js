import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { install, migrateLegacyJoined, shadowId } from '../src/host/roster-join.js'
import { mirrorTurn } from '../src/host/mirror.js'
import { install as installParts } from '../src/host/parts.js'
import { joinedChatPage, createBotPageReceiver } from '../src/host/joined-page.js'
import { fakeContext } from './fake-ctx.js'

const pair = (partId, turn = 1, seq = 2) => [
  { kind: 'user', text: `${partId} question ${turn}`, partId, turn, seq: seq - 1, turnComplete: true },
  { kind: 'bot', text: `${partId} answer ${turn}`, partId, turn, seq, turnComplete: true },
]
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }

function world(t, { items = pair('part-a'), page } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-history-continuity-'))
  const registry = new EventEmitter()
  const bot = { id: shadowId('n1', 'r1'), origin: 'joined', sessionId: null, worker: { nodeId: 'n1', remoteBotId: 'r1', home: 'remote', online: true } }
  const sessions = new Map()
  const created = []
  const disposers = []
  const rt = {
    state: { bots: { [bot.id]: bot } }, dshHome: home,
    botOf: id => rt.state.bots[id], save: async () => {}, warn() {},
    ctx: {
      get: key => key === 'remote-agent:registry' ? registry : undefined,
      effect: fn => disposers.push(fn()),
    },
    joinedChatPage: page ?? (async () => ({ items, cursor: null })),
    createSession: async () => {
      const id = `mirror-${created.length + 1}`
      created.push(id)
      sessions.set(id, new Session(id))
      return id
    },
    resolveAgent: async id => {
      if (!sessions.has(id)) throw new Error('session missing')
      return { session: sessions.get(id) }
    },
  }
  const dispose = () => { for (const off of disposers.splice(0)) off?.() }
  t.after(() => { dispose(); rmSync(home, { recursive: true, force: true }) })
  const roster = (bots = [{ id: 'r1', name: 'Remote' }]) => registry.emit('roster', { nodeId: 'n1', bots })
  const answers = () => (sessions.get(rt.botOf(bot.id).sessionId)?.log ?? []).filter(e => e.type === 'assistant/message').map(e => e.data.message.content[0].text)
  return { rt, bot, registry, sessions, created, dispose, roster, answers }
}

test('part identities keep reset turns and sequences as separate exchanges', async t => {
  const w = world(t, { page: async (_id, cursor) => cursor
    ? { items: pair('part-a'), cursor: null }
    : { items: pair('part-b'), cursor: { part: 0 } } })
  const result = await migrateLegacyJoined(w.rt)
  assert.equal(result.failed.length, 0)
  assert.deepEqual(w.answers(), ['part-a answer 1', 'part-b answer 1'])
})

test('a newer part below the old seq watermark appends without replacing the open Session', async t => {
  const w = world(t, { items: pair('part-a', 1, 100) })
  await migrateLegacyJoined(w.rt)
  const sid = w.bot.sessionId
  w.rt.joinedChatPage = async () => ({ items: [...pair('part-a', 1, 100), ...pair('part-b')], cursor: null })
  await migrateLegacyJoined(w.rt)
  assert.equal(w.bot.sessionId, sid)
  assert.deepEqual(w.answers(), ['part-a answer 1', 'part-b answer 1'])
  assert.equal(w.created.length, 1)
})

test('restarting with lost state checkpoints recovers imported identities from Session events', async t => {
  const w = world(t)
  await migrateLegacyJoined(w.rt)
  const sid = w.bot.sessionId
  const before = w.sessions.get(sid).log.length
  const restored = new Session(sid)
  for (const event of JSON.parse(JSON.stringify(w.sessions.get(sid).log))) restored.append(event.type, event.data, ['user/message', 'assistant/message'].includes(event.type) ? { surfaceOp: 'append' } : undefined)
  w.sessions.set(sid, restored)
  delete w.rt._mirrorState
  delete w.bot.mirrorHistory
  w.bot.mirrorWatermark = 0
  await migrateLegacyJoined(w.rt)
  assert.equal(w.bot.sessionId, sid)
  assert.equal(w.sessions.get(sid).log.length, before)
  assert.equal(w.created.length, 1)
})

test('failed first roster history fetch retries without a second roster', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let calls = 0
  const w = world(t, { page: async () => ++calls === 1
    ? { items: [{ kind: 'bot', text: 'offline' }], cursor: null }
    : { items: pair('part-a'), cursor: null } })
  install(w.rt)
  w.roster()
  t.mock.timers.tick(0)
  await settle()
  assert.equal(calls, 1)
  t.mock.timers.tick(5000)
  await settle()
  assert.ok(calls >= 2, 'failed bootstrap must be retried')
  assert.deepEqual(w.answers(), ['part-a answer 1'])
})

test('automatic retry preserves a live mirror opened after an earlier fetch failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let calls = 0
  const w = world(t, { page: async () => ++calls === 1
    ? { items: [{ kind: 'bot', text: 'offline' }], cursor: null }
    : { items: pair('part-a'), cursor: null } })
  install(w.rt)
  w.roster()
  t.mock.timers.tick(0)
  await settle()
  const current = w.rt.botOf(w.bot.id)
  current.sessionId = 'live-page'
  const session = new Session('live-page')
  w.sessions.set('live-page', session)
  await mirrorTurn(session, { userText: 'new live question', botText: 'new live answer' })
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(current.sessionId, 'live-page')
  assert.deepEqual(w.answers(), ['new live answer'])
  assert.equal(w.created.length, 0)
})

test('automatic migration never replaces an idle legacy mirror on the first roster', async t => {
  const w = world(t)
  w.bot.sessionId = 'legacy-page'
  const session = new Session('legacy-page')
  w.sessions.set('legacy-page', session)
  await mirrorTurn(session, { userText: 'old question', botText: 'old answer' })
  const result = await migrateLegacyJoined(w.rt, { automatic: true })
  assert.equal(w.bot.sessionId, 'legacy-page')
  assert.deepEqual(w.answers(), ['old answer'])
  assert.equal(w.created.length, 0)
  assert.ok(result.deferred?.some(item => item.botId === w.bot.id))
})

test('a Bot arriving in a later roster still gets its history bootstrapped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const w = world(t)
  install(w.rt)
  w.roster()
  t.mock.timers.tick(0)
  await settle()
  w.roster([{ id: 'r1' }, { id: 'r2' }])
  t.mock.timers.tick(0)
  await settle()
  assert.ok(w.rt.botOf(shadowId('n1', 'r2'))?.sessionId)
  assert.equal(w.created.length, 2)
})

test('an incomplete import is not published with a successful watermark', async t => {
  const w = world(t)
  const create = w.rt.createSession
  w.rt.createSession = async () => {
    const sid = await create()
    const session = w.sessions.get(sid)
    const append = session.append.bind(session)
    session.append = (type, ...args) => {
      if (type === 'assistant/message') throw new Error('simulated write failure')
      return append(type, ...args)
    }
    return sid
  }
  const result = await migrateLegacyJoined(w.rt)
  assert.deepEqual(result.failed, [w.bot.id])
  assert.equal(w.bot.sessionId, null)
  assert.equal(w.bot.mirrorWatermark ?? 0, 0)
})

test('concurrent migrations cannot create two Sessions for the same Bot', async t => {
  const w = world(t)
  await Promise.all([migrateLegacyJoined(w.rt), migrateLegacyJoined(w.rt)])
  assert.equal(w.created.length, 1)
  assert.deepEqual(w.answers(), ['part-a answer 1'])
})

test('a repeated history cursor fails before any Session is published', async t => {
  let calls = 0
  const w = world(t, { page: async () => ({ items: pair('part-a'), cursor: ++calls < 3 ? { part: 0, beforeSeq: 8 } : null }) })
  const result = await migrateLegacyJoined(w.rt)
  assert.deepEqual(result.failed, [w.bot.id])
  assert.ok(calls <= 2)
  assert.equal(w.created.length, 0)
})

test('open node turns do not advance the migration checkpoint', async t => {
  const w = world(t, { items: pair('part-a').map(item => ({ ...item, turnComplete: false })) })
  const result = await migrateLegacyJoined(w.rt, { automatic: true })
  assert.equal(w.answers().length, 0)
  assert.ok(result.deferred?.some(item => item.botId === w.bot.id))
})

test('a failed incremental write can retry without losing or duplicating successful exchanges', async t => {
  const w = world(t)
  await migrateLegacyJoined(w.rt)
  const sid = w.bot.sessionId
  const session = w.sessions.get(sid)
  const append = session.append.bind(session)
  let fail = true
  session.append = (type, ...args) => {
    if (type === 'assistant/message' && fail) { fail = false; throw new Error('one failed incremental append') }
    return append(type, ...args)
  }
  w.rt.joinedChatPage = async () => ({ items: [...pair('part-a'), ...pair('part-a', 2, 4)], cursor: null })
  const failed = await migrateLegacyJoined(w.rt)
  assert.deepEqual(failed.failed, [w.bot.id])
  const retried = await migrateLegacyJoined(w.rt)
  assert.equal(retried.failed.length, 0)
  assert.equal(retried.deferred?.length ?? 0, 0)
  assert.equal(w.bot.sessionId, sid)
  assert.deepEqual(w.answers(), ['part-a answer 1', 'part-a answer 2'])
})

test('a node switching its current part between history pages aborts the snapshot', async t => {
  const w = world(t, { page: async (_id, cursor) => cursor
    ? { sessionId: 'node-current-b', items: pair('part-a'), cursor: null }
    : { sessionId: 'node-current-a', items: pair('part-b'), cursor: { part: 0 } } })
  const result = await migrateLegacyJoined(w.rt)
  assert.deepEqual(result.failed, [w.bot.id])
  assert.equal(w.created.length, 0)
})

test('nonempty history without part identity is deferred by the automatic path', async t => {
  const w = world(t, { items: pair('part-a').map(({ partId: _partId, ...item }) => item) })
  const result = await migrateLegacyJoined(w.rt, { automatic: true })
  assert.equal(w.created.length, 0)
  assert.ok(result.deferred?.length > 0)
})

test('unloading after a failed fetch cancels its retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let calls = 0
  const w = world(t, { page: async () => { calls++; throw new Error('temporary history error') } })
  install(w.rt)
  w.roster()
  t.mock.timers.tick(0)
  await settle()
  assert.equal(calls, 1)
  w.dispose()
  t.mock.timers.tick(10000)
  await settle()
  assert.equal(calls, 1)
  assert.equal(w.registry.listenerCount('roster'), 0)
})

test('a checkpoint save failure replays from committed Session markers after a roster refresh', async t => {
  const w = world(t)
  await migrateLegacyJoined(w.rt)
  const sid = w.bot.sessionId
  w.rt.joinedChatPage = async () => ({ items: [...pair('part-a'), ...pair('part-b')], cursor: null })
  let fail = true
  w.rt.save = async () => {
    if (fail) {
      fail = false
      const current = w.rt.botOf(w.bot.id)
      w.rt.state.bots[w.bot.id] = { ...current }
      throw new Error('checkpoint save failed')
    }
  }
  assert.deepEqual((await migrateLegacyJoined(w.rt)).failed, [w.bot.id])
  const result = await migrateLegacyJoined(w.rt)
  assert.equal(result.failed.length, 0)
  assert.equal(w.rt.botOf(w.bot.id).sessionId, sid)
  assert.deepEqual(w.answers(), ['part-a answer 1', 'part-b answer 1'])
})


test('node chat pages preserve part identity and closure through the DS Bot history receiver and hub importer', async t => {
  const w = world(t)
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  const nodeSessions = new Map()
  for (const id of ['node-old', 'node-current']) {
    const session = new Session(id)
    await mirrorTurn(session, { userText: `${id} question`, botText: `${id} answer` })
    nodeSessions.set(id, session)
  }
  const local = { id: 'r1', sessionId: 'node-current', segments: [{ sessionId: 'node-old' }] }
  const node = {
    ctx, config: {}, state: { bots: { r1: local }, exchangeTurns: {} },
    botOf: id => id === 'r1' ? local : undefined, roomOf: () => undefined,
    chatOf: () => local.sessionId, isBotSession: () => false,
    resolveAgent: async sid => ({ session: nodeSessions.get(sid) }),
  }
  ctx.sessionController = { page: async ({ address, beforeSeq, throughSeq }) => ({
    records: nodeSessions.get(address.sessionId).log
      .filter(event => (beforeSeq === undefined || event.seq < beforeSeq) && event.seq <= throughSeq)
      .map(event => ({ event })), hasMore: false,
  }) }
  installParts(node)
  const receive = createBotPageReceiver(node)
  const first = await receive({ remoteBotId: 'r1' })
  assert.ok(first.items.filter(item => item.kind === 'bot').every(item => item.partId === 'node-current' && item.turnComplete === true))
  const past = await receive({ remoteBotId: 'r1', cursor: first.cursor })
  assert.ok(past.items.filter(item => item.kind === 'bot').every(item => item.partId === 'node-old' && item.turnComplete === true))
  w.registry.nodes = new Map([['n1', { online: true }]])
  w.registry.send = (_id, type, payload) => {
    assert.equal(type, 'bot/history')
    void receive(payload).then(result => w.registry.emit('botHistoryResult', { ...result, requestId: payload.requestId, nodeId: 'n1' }))
    return true
  }
  w.rt.joinedChatPage = (id, cursor) => joinedChatPage({ ...w.rt, joinedChatPage: undefined }, id, cursor)
  const result = await migrateLegacyJoined(w.rt, { automatic: true })
  assert.equal(result.failed.length, 0)
  assert.deepEqual(w.answers(), ['node-old answer', 'node-current answer'])
  assert.equal(w.registry.listenerCount('botHistoryResult'), 0)
})

test('history is flushed before publishing its mirror Session and checkpoint', async t => {
  const w = world(t)
  w.rt.ctx.sessions = { flush: async () => { throw new Error('session flush failed') } }
  const result = await migrateLegacyJoined(w.rt)
  assert.deepEqual(result.failed, [w.bot.id])
  assert.equal(w.bot.sessionId, null)
  assert.equal(w.bot.mirrorHistory, undefined)
})

test('an incremental flush finishing after a Session switch never restores the old page', async t => {
  const w = world(t)
  await migrateLegacyJoined(w.rt)
  const originalId = w.bot.sessionId
  w.rt.joinedChatPage = async () => ({ items: [...pair('part-a'), ...pair('part-b')], cursor: null })
  w.rt.ctx.sessions = { flush: async () => {
    w.rt.botOf(w.bot.id).sessionId = 'new-page-during-flush'
    w.sessions.set('new-page-during-flush', new Session('new-page-during-flush'))
  } }
  const result = await migrateLegacyJoined(w.rt)
  assert.equal(w.bot.sessionId, 'new-page-during-flush')
  assert.deepEqual(result.skipped, [w.bot.id])
  assert.equal(w.created.length, 1)
  assert.equal(w.sessions.get(originalId).log.filter(event => event.type === 'assistant/message').length, 2)
})
