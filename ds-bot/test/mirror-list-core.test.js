// openJoinedHome against a model of the core's session list with ITS failure semantics.
//
// What the core really does (dsh-api-session-controller; src/client/sessions/manager.ts:397-446,
// service.ts:372 and :710; the built lib/client.js :3335-3371, :4012, :4337):
//   · refresh() = manager.refreshList(): session.list returning { ok: false } — or throwing a
//     RemoteFailure — only sets listState = 'error' / listError and RESOLVES. Anything that is not
//     a RemoteFailure is rethrown, so refresh() rejects.
//   · the public `ctx.sessions.list` snapshot is { ids, byId, phase, projectionsBySession }: the
//     manager's `state` and `error` are NOT projected, and `manager` is private.
// So a resolved refresh() carries no success signal and the client cannot read the failure from
// the core. These tests wire teamActions the way src/client/index.js does (sessionProbes) onto a
// model with exactly that behavior.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { teamActions } from '../src/client/team-actions.js'
import { sessionProbes, hostHasSession } from '../src/client/host-session.js'
import { hostRoster, joinedRuntime } from './bot-home-fixtures.js'
import { installLocale } from '../src/client/i18n.js'

const MIRROR = 'sess-mirror'
class RemoteFailure extends Error { constructor(m) { super(m); this.isRemoteFailure = true } }

/**
 * `remoteMode(callIndex)` says what the Host's session.list does on each call (0-based):
 *   'ok' (items: the Host's sessions), 'result-error' ({ok:false}), 'remote-failure' (throws one),
 *   'other-error' (throws something else).
 */
function world({ hostItems = [], remoteMode = () => 'ok', withRemote = true } = {}) {
  let calls = 0
  const log = []
  const remote = {
    async list() {
      const mode = remoteMode(calls); calls += 1; log.push(['remote.session.list', mode])
      if (mode === 'result-error') return { ok: false, error: { code: 'EACCES' } }
      if (mode === 'remote-failure') throw new RemoteFailure('transport')
      if (mode === 'other-error') throw new TypeError('boom')
      return { ok: true, value: { items: hostItems.map(sessionId => ({ sessionId })) } }
    },
  }
  // the core's client-side list: manager state private, store projected without state/error
  const manager = { listState: 'idle', listError: null, phase: 'pending', summaries: [] }
  const listStore = { snapshot: { ids: [], byId: {}, phase: 'pending', projectionsBySession: {} } }
  const publish = () => {
    const byId = Object.fromEntries(manager.summaries.map(s => [s.sessionId, { sessionId: s.sessionId }]))
    listStore.snapshot = { ids: Object.keys(byId), byId, phase: manager.phase, projectionsBySession: {} }
  }
  const sessions = {
    list: { getSnapshot: () => listStore.snapshot },
    async refresh() {
      manager.listState = 'loading'
      try {
        const result = await remote.list({})
        if (result.ok) { manager.summaries = result.value.items; manager.listState = 'idle'; manager.phase = 'ready'; manager.listError = null }
        else { manager.listState = 'error'; manager.listError = result.error }      // RESOLVES
      } catch (error) {
        if (!error.isRemoteFailure) throw error                                      // REJECTS
        manager.listState = 'error'; manager.listError = error                       // RESOLVES
      }
      publish()
    },
  }
  const ctx = { sessions, get: name => (name === 'remote.session' && withRemote ? remote : undefined) }
  return { ctx, manager, listStore, log, remote }
}

function homeActions({ w, mirrorInCore = false }) {
  if (mirrorInCore) { w.manager.summaries = [{ sessionId: MIRROR }]; w.manager.phase = 'ready'; w.listStore.snapshot = { ids: [MIRROR], byId: { [MIRROR]: { sessionId: MIRROR } }, phase: 'ready', projectionsBySession: {} } }
  const rt = joinedRuntime({ mirrorSessionId: MIRROR })
  const roster = hostRoster(rt)
  const opened = []
  const ui = { state: {}, set(fn) { this.state = fn(this.state) }, getSnapshot() { return this.state } }
  const actions = teamActions({
    call: async () => ({}), after: async p => p, partFor: () => null,
    roster: { getSnapshot: () => roster }, ui,
    live: { getSnapshot: () => ({}) }, cards: { getSnapshot: () => ({}) }, heldCards: { getSnapshot: () => ({}) },
    turnClock: { getSnapshot: () => ({}) }, panelFolded: () => false,
    openSession: id => opened.push(id),
    ...sessionProbes(w.ctx),
  })
  return { actions, opened, toast: () => ui.state.toast?.text ?? '' }
}

describe('S42: openJoinedHome with the core\'s list-failure semantics', () => {
  it('S42-premise: the model has the core\'s shape — a failed pull resolves, and nothing public says it failed', async () => {
    const w = world({ remoteMode: () => 'result-error' })
    await w.ctx.sessions.refresh()                         // resolved, not rejected
    assert.equal(w.manager.listState, 'error', 'the failure exists, privately')
    assert.deepEqual(Object.keys(w.ctx.sessions.list.getSnapshot()).sort(), ['byId', 'ids', 'phase', 'projectionsBySession'])
    assert.equal('state' in w.ctx.sessions.list.getSnapshot(), false)
    assert.equal('error' in w.ctx.sessions.list.getSnapshot(), false)
    const w2 = world({ remoteMode: () => 'other-error' })
    await assert.rejects(w2.ctx.sessions.refresh(), TypeError, 'only a non-RemoteFailure rejects')
  })

  it('S42-a: session.list fails (resolved by the core) -> the "list could not be refreshed" toast, not "damaged"', async () => {
    for (const mode of ['result-error', 'remote-failure']) {
      const w = world({ hostItems: [MIRROR], remoteMode: () => mode })
      const { actions, opened, toast } = homeActions({ w })
      await actions.openJoinedHome('bot-j1')
      assert.deepEqual(opened, [], `${mode}: nothing opened`)
      assert.match(toast(), /conversation list could not be refreshed/, mode)
      assert.doesNotMatch(toast(), /damaged/, mode)
    }
  })

  it('S42-b: the list is read fine but the mirror is not in it -> "damaged"', async () => {
    const w = world({ hostItems: ['other-session'] })
    const { actions, opened, toast } = homeActions({ w })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(opened, [])
    assert.match(toast(), /damaged or cannot be read/)
    assert.doesNotMatch(toast(), /could not be refreshed/)
  })

  it('S42-c: the core\'s refresh REJECTS -> the "list could not be refreshed" toast', async () => {
    const w = world({ hostItems: [MIRROR], remoteMode: () => 'other-error' })
    const { actions, opened, toast } = homeActions({ w })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(opened, [])
    assert.match(toast(), /conversation list could not be refreshed/)
    assert.doesNotMatch(toast(), /damaged/)
  })

  it('S42-c2: the core\'s refresh REJECTS once but the Host\'s list can be read afterwards -> still the "could not be refreshed" toast (a rejected pull is never read as a verdict)', async () => {
    const w = world({ hostItems: ['other-session'], remoteMode: index => (index === 0 ? 'other-error' : 'ok') })
    const { actions, opened, toast } = homeActions({ w })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(opened, [])
    assert.match(toast(), /conversation list could not be refreshed/)
    assert.doesNotMatch(toast(), /damaged/)
    assert.equal(w.log.length, 1, 'the Host is not asked again after a rejected refresh')
  })

  it('S42-d: the core\'s pull failed once but the Host does list the mirror (a passing failure) -> it opens, no toast', async () => {
    const w = world({ hostItems: [MIRROR], remoteMode: index => (index === 0 ? 'result-error' : 'ok') })
    const { actions, opened, toast } = homeActions({ w })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(opened, ['bot-j1'])
    assert.equal(toast(), '')
  })

  it('S42-e: the mirror is already in the core\'s list -> it opens at once, the Host is never asked', async () => {
    const w = world({ hostItems: [] })
    const { actions, opened, toast } = homeActions({ w, mirrorInCore: true })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(opened, ['bot-j1'])
    assert.equal(toast(), '')
    assert.deepEqual(w.log, [], 'no list call at all')
  })

  it('S42-f: the first pull lists it (cold start) -> it opens, and the Host is not asked a second time', async () => {
    const w = world({ hostItems: [MIRROR] })
    const { actions, opened, toast } = homeActions({ w })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(opened, ['bot-j1'])
    assert.equal(toast(), '')
    assert.equal(w.log.length, 1, 'only the core\'s own pull')
  })

  it('S42-g: without a remote.session service there is no way to ask — a missing mirror keeps the old verdict', async () => {
    const w = world({ hostItems: [], withRemote: false })
    const { actions, opened, toast } = homeActions({ w })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(opened, [])
    assert.match(toast(), /damaged or cannot be read/)
  })

  it('S42-zh: in Chinese the failed list read says so, and a read list without the mirror says damaged', async () => {
    const dicts = new Map()
    const restore = installLocale({
      register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
      bind: ns => (key, params) => (dicts.get(`${ns}:zh`)?.[key] ?? key),
      getLocale: () => ({ active: 'zh' }),
    })
    try {
      const failed = homeActions({ w: world({ hostItems: [MIRROR], remoteMode: () => 'result-error' }) })
      await failed.actions.openJoinedHome('bot-j1')
      assert.match(failed.toast(), /会话列表刷新失败/)
      assert.doesNotMatch(failed.toast(), /损坏/)
      const missing = homeActions({ w: world({ hostItems: [] }) })
      await missing.actions.openJoinedHome('bot-j1')
      assert.match(missing.toast(), /镜像对话文件已损坏或无法读取/)
    } finally { restore?.() }
  })

  it('S42-unit: hostHasSession — true/false for a read list, undefined when the read fails, null with no service', async () => {
    const noted = []
    const read = items => ({ list: async () => ({ ok: true, value: { items: items.map(sessionId => ({ sessionId })) } }) })
    assert.equal(await hostHasSession(read([MIRROR, 'x']), MIRROR), true)
    assert.equal(await hostHasSession(read(['x']), MIRROR), false)
    assert.equal(await hostHasSession({ list: async () => ({ ok: false, error: {} }) }, MIRROR), undefined)
    assert.equal(await hostHasSession({ list: async () => ({ ok: true, value: {} }) }, MIRROR), undefined, 'a malformed answer is not "missing"')
    assert.equal(await hostHasSession({ list: async () => { throw new Error('down') } }, MIRROR, error => noted.push(error.message)), undefined)
    assert.deepEqual(noted, ['down'])
    assert.equal(await hostHasSession(undefined, MIRROR), null)
    assert.equal(await hostHasSession({}, MIRROR), null)
  })
})
