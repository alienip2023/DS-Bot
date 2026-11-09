import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { botRowClick } from '../src/client/row-actions.js'
import { teamActions } from '../src/client/team-actions.js'
import { realTeamActions, hostRoster, joinedRuntime } from './bot-home-fixtures.js'
import { installLocale } from '../src/client/i18n.js'

function spyActions() {
  const calls = []
  const rec = name => id => { calls.push([name, id]) }
  return {
    calls,
    actions: { openSession: rec('openSession'), openJoinedHome: rec('openJoinedHome'), openJoinedChat: rec('openJoinedChat') },
  }
}

describe('S23b: a joined Bot click opens its Bot page, never the dialog', () => {
  it('S23b-a joined -> openJoinedHome(bot.id) once; openSession and openJoinedChat never', () => {
    const { calls, actions } = spyActions()
    botRowClick(true, 'bot-j1', actions)
    assert.deepEqual(calls, [['openJoinedHome', 'bot-j1']])
  })

  it('S23b-d non-joined Bot -> openSession only', () => {
    const { calls, actions } = spyActions()
    botRowClick(false, 'bot-local', actions)
    assert.deepEqual(calls, [['openSession', 'bot-local']])
  })

  it('S23b-botHasHome: id fallback is not a home; a distinct sessionId is (real host shape)', () => {
    const state = { byId: {
      fallback: { id: 'fallback', sessionId: 'fallback' },
      mirror: { id: 'mirror', sessionId: 'sess-mirror' },
      empty: { id: 'empty', sessionId: '' },
      none: { id: 'none' },
    } }
    const actions = realTeamActions(state)
    assert.equal(actions.botHasHome('fallback'), false, 'sessionId === bot.id is chatOf\'s fallback, not a session')
    assert.equal(actions.botHasHome('mirror'), true)
    assert.equal(actions.botHasHome('empty'), false)
    assert.equal(actions.botHasHome('none'), false)
    assert.equal(actions.botHasHome('unknown'), false)
    state.byId.fallback = { id: 'fallback', sessionId: 'later-mirror' }
    assert.equal(actions.botHasHome('fallback'), true, 'must read the live snapshot, not a copy')
  })

  it('S23b-no-dead-action: openBotHome no longer exists on teamActions', () => {
    assert.equal(realTeamActions({}).openBotHome, undefined)
  })
})

describe('S23b: openJoinedHome (real teamActions)', () => {
  // The real host shape: the roster comes from a real runtime's chatOf; `joined-ensure`
  // is answered like channel.js does, by giving the Bot its mirror sessionId.
  function harness({ mirrorSessionId, ensure = 'ok', refresh = true, listed } = {}) {
    const rt = joinedRuntime({ mirrorSessionId })
    let roster = hostRoster(rt)
    const calls = []
    const ui = { state: {}, set(fn) { this.state = fn(this.state) }, getSnapshot() { return this.state } }
    const actions = teamActions({
      call: async (endpoint, body) => {
        calls.push([endpoint, body])
        if (endpoint !== 'joined-ensure') return {}
        if (ensure === 'fail') throw new Error('Could not open the Bot\'s page: disk full')
        rt.state.bots[body.botId].sessionId = 'sess-mirror-new'
        return { sessionId: 'sess-mirror-new' }
      },
      after: async (promise) => { const value = await promise; if (refresh) roster = hostRoster(rt); return value },
      partFor: () => null,
      roster: { getSnapshot: () => roster },
      ui,
      live: { getSnapshot: () => ({}) }, cards: { getSnapshot: () => ({}) }, heldCards: { getSnapshot: () => ({}) },
      turnClock: { getSnapshot: () => ({}) }, panelFolded: () => false,
      openSession: id => calls.push(['openSession', id]),
      // `listed`: undefined = no list wired; { now, afterRefresh } = what the core's session list holds
      ...(listed === undefined ? {} : {
        sessionListed: id => { calls.push(['listed?', id]); return listed.refreshed ? listed.afterRefresh : listed.now },
        refreshSessions: async () => { calls.push(['refreshSessions']); if (listed.refreshFails) return false; listed.refreshed = true; return true },
      }),
    })
    return { actions, calls, ui }
  }

  it('S23b-home-existing: a Bot with a mirror session opens at once, no ensure call', async () => {
    const { actions, calls } = harness({ mirrorSessionId: 'sess-mirror' })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(calls, [['openSession', 'bot-j1']])
  })

  it('S23b-home-ensure: a Bot never chatted with is ensured first, then opened once', async () => {
    const { actions, calls } = harness()
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(calls, [['joined-ensure', { botId: 'bot-j1' }], ['openSession', 'bot-j1']])
  })

  it('S23b-home-ensure-fail: a host failure is shown as a toast, the page is not opened', async () => {
    const { actions, calls, ui } = harness({ ensure: 'fail' })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(calls, [['joined-ensure', { botId: 'bot-j1' }]])
    assert.match(ui.state.toast?.text ?? '', /disk full/)
  })

  it('S23b-home-not-ready: ensure answered but the team still shows no session -> toast, no open', async () => {
    const { actions, calls, ui } = harness({ refresh: false })
    await actions.openJoinedHome('bot-j1')
    assert.deepEqual(calls, [['joined-ensure', { botId: 'bot-j1' }]])
    assert.match(ui.state.toast?.text ?? '', /not ready/i)
  })

  // A mirror session whose stored log is damaged is dropped from DSH's session list; the core opener
  // then waits for it forever. The click must say so (O10).
  describe('S37: openJoinedHome reports a mirror session the core does not list', () => {
    const sayings = (ui) => ui.state.toast?.text ?? ''

    it('S37-listed: a mirror session that is listed opens at once, no refresh', async () => {
      const { actions, calls, ui } = harness({ mirrorSessionId: 'sess-mirror', listed: { now: true, afterRefresh: true } })
      await actions.openJoinedHome('bot-j1')
      assert.deepEqual(calls, [['listed?', 'sess-mirror'], ['openSession', 'bot-j1']])
      assert.equal(sayings(ui), '')
    })

    it('S37-late: not listed yet but listed after one refresh (cold start) opens, no toast', async () => {
      const { actions, calls, ui } = harness({ mirrorSessionId: 'sess-mirror', listed: { now: false, afterRefresh: true } })
      await actions.openJoinedHome('bot-j1')
      assert.deepEqual(calls, [['listed?', 'sess-mirror'], ['refreshSessions'], ['listed?', 'sess-mirror'], ['openSession', 'bot-j1']])
      assert.equal(sayings(ui), '')
    })

    it('S37-unreadable: still not listed after the refresh -> a toast that says the mirror file is damaged, the page is not opened', async () => {
      const { actions, calls, ui } = harness({ mirrorSessionId: 'sess-mirror', listed: { now: false, afterRefresh: false } })
      await actions.openJoinedHome('bot-j1')
      assert.equal(calls.some(call => call[0] === 'openSession'), false, 'nothing opened')
      assert.equal(calls.filter(call => call[0] === 'refreshSessions').length, 1, 'read the list again exactly once')
      assert.match(sayings(ui), /mirror conversation file/)
      assert.match(sayings(ui), /not affected/)
    })

    it('S37-unreadable-zh: in Chinese the toast names the damaged mirror and the next step', async () => {
      const dicts = new Map()
      const restore = installLocale({
        register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
        bind: ns => (key, params) => (dicts.get(`${ns}:zh`)?.[key] ?? key),
        getLocale: () => ({ active: 'zh' }),
      })
      try {
        const { actions, ui } = harness({ mirrorSessionId: 'sess-mirror', listed: { now: false, afterRefresh: false } })
        await actions.openJoinedHome('bot-j1')
        const text = sayings(ui)
        assert.match(text, /镜像对话文件已损坏或无法读取/)
        assert.match(text, /节点上的对话不受影响/)
        assert.match(text, /联系维护者重建/)
        assert.doesNotMatch(text, /mirror conversation file/)
      } finally { restore?.() }
    })

    it('S38-refresh-failed: when the list cannot be read again the toast says THAT — it does not call the mirror damaged', async () => {
      const { actions, calls, ui } = harness({ mirrorSessionId: 'sess-mirror', listed: { now: false, afterRefresh: true, refreshFails: true } })
      await actions.openJoinedHome('bot-j1')
      assert.equal(calls.some(call => call[0] === 'openSession'), false, 'nothing opened')
      assert.deepEqual(calls, [['listed?', 'sess-mirror'], ['refreshSessions']], 'the list is not asked again after a failed refresh')
      assert.match(sayings(ui), /conversation list could not be refreshed/)
      assert.doesNotMatch(sayings(ui), /damaged|mirror conversation file/)
    })

    it('S38-refresh-failed-zh: in Chinese it names the failed refresh, not a damaged file', async () => {
      const dicts = new Map()
      const restore = installLocale({
        register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
        bind: ns => (key, params) => (dicts.get(`${ns}:zh`)?.[key] ?? key),
        getLocale: () => ({ active: 'zh' }),
      })
      try {
        const { actions, ui } = harness({ mirrorSessionId: 'sess-mirror', listed: { now: false, afterRefresh: true, refreshFails: true } })
        await actions.openJoinedHome('bot-j1')
        assert.match(sayings(ui), /会话列表刷新失败/)
        assert.match(sayings(ui), /稍后再试/)
        assert.doesNotMatch(sayings(ui), /损坏/)
      } finally { restore?.() }
    })

    it('S37-fresh: a Bot that was just given its mirror session by the host is not judged by the list (the list catches up on its own)', async () => {
      const { actions, calls, ui } = harness({ listed: { now: false, afterRefresh: false } })
      await actions.openJoinedHome('bot-j1')
      assert.deepEqual(calls, [['joined-ensure', { botId: 'bot-j1' }], ['openSession', 'bot-j1']])
      assert.equal(sayings(ui), '')
    })
  })
})
