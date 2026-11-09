import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { botRowClick } from '../src/client/row-actions.js'
import { teamActions } from '../src/client/team-actions.js'

function spyActions({ enabled, hasHome }) {
  const calls = []
  const rec = name => id => { calls.push([name, id]) }
  return {
    calls,
    actions: {
      botHomeEnabled: () => enabled,
      botHasHome: () => hasHome,
      openSession: rec('openSession'),
      openJoinedChat: rec('openJoinedChat'),
    },
  }
}

function realTeamActions(rosterState) {
  return teamActions({
    call: () => Promise.resolve({}),
    after: p => p,
    partFor: () => null,
    roster: { getSnapshot: () => rosterState },
    ui: { set: () => {}, getSnapshot: () => ({}) },
    live: { getSnapshot: () => ({}) },
    cards: { getSnapshot: () => ({}) },
    heldCards: { getSnapshot: () => ({}) },
    turnClock: { getSnapshot: () => ({}) },
    panelFolded: () => false,
  })
}

describe('S23b: Bot Home routing of a joined Bot click', () => {
  it('S23b-a flag on + has sessionId -> openSession(bot.id) once, openJoinedChat never', () => {
    const { calls, actions } = spyActions({ enabled: true, hasHome: true })
    botRowClick(true, 'bot-j1', actions)
    assert.deepEqual(calls, [['openSession', 'bot-j1']])
  })

  it('S23b-b flag on + no sessionId -> openJoinedChat once, openSession never', () => {
    const { calls, actions } = spyActions({ enabled: true, hasHome: false })
    botRowClick(true, 'bot-j1', actions)
    assert.deepEqual(calls, [['openJoinedChat', 'bot-j1']])
  })

  it('S23b-c flag off -> openJoinedChat even when the Bot has a sessionId', () => {
    const { calls, actions } = spyActions({ enabled: false, hasHome: true })
    botRowClick(true, 'bot-j1', actions)
    assert.deepEqual(calls, [['openJoinedChat', 'bot-j1']])
  })

  it('S23b-d non-joined Bot -> openSession regardless of flag and sessionId', () => {
    for (const [enabled, hasHome] of [[true, true], [true, false], [false, true], [false, false]]) {
      const { calls, actions } = spyActions({ enabled, hasHome })
      botRowClick(false, 'bot-local', actions)
      assert.deepEqual(calls, [['openSession', 'bot-local']])
    }
  })

  it('S23b-botHasHome: real teamActions reads the roster snapshot', () => {
    const state = { byId: {
      has: { sessionId: 'sess-1' },
      empty: { sessionId: '' },
      none: {},
    } }
    const actions = realTeamActions(state)
    assert.equal(actions.botHasHome('has'), true)
    assert.equal(actions.botHasHome('empty'), false)
    assert.equal(actions.botHasHome('none'), false)
    assert.equal(actions.botHasHome('unknown'), false)
    state.byId.none.sessionId = 'later'
    assert.equal(actions.botHasHome('none'), true, 'must read the live snapshot, not a copy')
  })

  it('S23b-flag-from-roster: real teamActions.botHomeEnabled follows roster.botHomeEnabled', () => {
    const state = { botHomeEnabled: true }
    const actions = realTeamActions(state)
    assert.equal(actions.botHomeEnabled(), true)
    state.botHomeEnabled = false
    assert.equal(actions.botHomeEnabled(), false)
  })

  it('S23b-no-dead-action: openBotHome no longer exists on teamActions', () => {
    assert.equal(realTeamActions({}).openBotHome, undefined)
  })

  it('S23b-end-to-end: real teamActions drive botRowClick (flag on, session present -> openSession)', () => {
    const real = realTeamActions({ botHomeEnabled: true, byId: { 'bot-j1': { sessionId: 'sess-1' } } })
    const calls = []
    const actions = { ...real, openSession: id => calls.push(['openSession', id]), openJoinedChat: id => calls.push(['openJoinedChat', id]) }
    botRowClick(true, 'bot-j1', actions)
    assert.deepEqual(calls, [['openSession', 'bot-j1']])
    const real2 = realTeamActions({ botHomeEnabled: true, byId: { 'bot-j1': {} } })
    const calls2 = []
    botRowClick(true, 'bot-j1', { ...real2, openSession: id => calls2.push(['openSession', id]), openJoinedChat: id => calls2.push(['openJoinedChat', id]) })
    assert.deepEqual(calls2, [['openJoinedChat', 'bot-j1']])
  })
})
