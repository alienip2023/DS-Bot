import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { botRowClick } from '../src/client/row-actions.js'
import { teamActions } from '../src/client/team-actions.js'
import { realTeamActions, hostRoster, joinedRuntime } from './bot-home-fixtures.js'

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
  function harness({ mirrorSessionId, ensure = 'ok', refresh = true } = {}) {
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
})
