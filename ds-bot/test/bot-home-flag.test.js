import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { botRowClick } from '../src/client/row-actions.js'
import { realTeamActions, hostRoster, joinedRuntime } from './bot-home-fixtures.js'

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

function clickThrough(roster) {
  const real = realTeamActions(roster)
  const calls = []
  const actions = { ...real, openSession: id => calls.push(['openSession', id]), openJoinedChat: id => calls.push(['openJoinedChat', id]) }
  botRowClick(true, 'bot-j1', actions)
  return calls
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

  it('S23b-real-shape-1: joined Bot not chatted yet (chatOf falls back to its id), flag on -> openJoinedChat only', () => {
    const rt = joinedRuntime()
    const roster = hostRoster(rt)
    assert.equal(roster.byId['bot-j1'].sessionId, 'bot-j1', 'precondition: real chatOf fell back to the Bot id')
    assert.equal(roster.botHomeEnabled, true)
    assert.deepEqual(clickThrough(roster), [['openJoinedChat', 'bot-j1']])
  })

  it('S23b-real-shape-2: joined Bot with a mirror session, flag on -> openSession(bot.id) once', () => {
    const rt = joinedRuntime({ mirrorSessionId: 'sess-mirror' })
    const roster = hostRoster(rt)
    assert.equal(roster.byId['bot-j1'].sessionId, 'sess-mirror')
    assert.deepEqual(clickThrough(roster), [['openSession', 'bot-j1']])
  })
})
