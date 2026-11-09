import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { botRowClick } from '../src/client/row-actions.js'
import { teamActions } from '../src/client/team-actions.js'

describe('S23b: botHome feature flag routing', () => {
  it('S23b-flag-from-roster: botHomeEnabled reads roster.botHomeEnabled, not undefined rt', () => {
    // Knife: change to rt.botHomeEnabled → ReferenceError (rt undefined) → RED
    const rosterState = { botHomeEnabled: true }
    const roster = { getSnapshot: () => rosterState }
    const actions = teamActions({
      call: () => Promise.resolve({}),
      after: p => p,
      partFor: () => null,
      roster,
      ui: { set: () => {}, getSnapshot: () => ({}) },
      live: { getSnapshot: () => ({}) },
      cards: { getSnapshot: () => ({}) },
      heldCards: { getSnapshot: () => ({}) },
      turnClock: { getSnapshot: () => ({}) },
      panelFolded: () => false,
    })
    assert.equal(actions.botHomeEnabled(), true, 'must read roster.botHomeEnabled=true')
    rosterState.botHomeEnabled = false
    assert.equal(actions.botHomeEnabled(), false, 'must reflect roster update to false')
  })

  it('S23b-flag-off: botHomeEnabled=false → openJoinedChat called, openAgent not called', () => {
    // Knife: delete botHomeEnabled check (always openAgent) → openJoinedChat not called → RED
    const calls = { openJoinedChat: 0, openAgent: 0, openSession: 0 }
    const actions = {
      botHomeEnabled: () => false,
      openJoinedChat: (id) => { calls.openJoinedChat++; assert.equal(id, 'bot-j1') },
      openAgent: (id) => { calls.openAgent++; assert.equal(id, 'bot-j1') },
      openSession: () => { calls.openSession++ },
    }
    botRowClick(true, 'bot-j1', actions)
    assert.equal(calls.openJoinedChat, 1, 'openJoinedChat must be called when flag=false')
    assert.equal(calls.openAgent, 0, 'openAgent must NOT be called when flag=false')
    assert.equal(calls.openSession, 0)
  })

  it('S23b-flag-on: botHomeEnabled=true → openAgent called, openJoinedChat not called', () => {
    const calls = { openJoinedChat: 0, openAgent: 0, openSession: 0 }
    const actions = {
      botHomeEnabled: () => true,
      openJoinedChat: (id) => { calls.openJoinedChat++; assert.equal(id, 'bot-j1') },
      openAgent: (id) => { calls.openAgent++; assert.equal(id, 'bot-j1') },
      openSession: () => { calls.openSession++ },
    }
    botRowClick(true, 'bot-j1', actions)
    assert.equal(calls.openAgent, 1, 'openAgent must be called when flag=true')
    assert.equal(calls.openJoinedChat, 0, 'openJoinedChat must NOT be called when flag=true')
    assert.equal(calls.openSession, 0)
  })

  it('S23b-non-joined: non-joined bot always routes to openSession regardless of flag', () => {
    const calls = { openJoinedChat: 0, openAgent: 0, openSession: 0 }
    const actions = {
      botHomeEnabled: () => true,
      openJoinedChat: () => { calls.openJoinedChat++ },
      openAgent: () => { calls.openAgent++ },
      openSession: () => { calls.openSession++ },
    }
    botRowClick(false, 'bot-local', actions)
    assert.equal(calls.openSession, 1)
    assert.equal(calls.openJoinedChat, 0)
    assert.equal(calls.openAgent, 0)
  })
})
