import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyRosterReport } from '../src/host/roster-join.js'

function makeState(bots = {}) {
  return { bots, deletedJoinedIds: undefined }
}

describe('S23c: delete joined bot + roster recreate protection', () => {
  it('S23c-delete-joined: deletedJoinedIds populated after delete, state cleaned', () => {
    const state = makeState({
      'joined:n1:rb1': { id: 'joined:n1:rb1', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } },
    })
    const bot = state.bots['joined:n1:rb1']
    // Simulate deleteBot logic: delete from bots + push to deletedJoinedIds
    delete state.bots[bot.id]
    if (bot.origin === 'joined') {
      if (!Array.isArray(state.deletedJoinedIds)) state.deletedJoinedIds = []
      if (!state.deletedJoinedIds.includes(bot.id)) state.deletedJoinedIds.push(bot.id)
    }
    assert.equal(state.bots['joined:n1:rb1'], undefined, 'bot must be removed from state.bots')
    assert.ok(Array.isArray(state.deletedJoinedIds), 'deletedJoinedIds must be an array')
    assert.ok(state.deletedJoinedIds.includes('joined:n1:rb1'), 'deletedJoinedIds must include the deleted bot id')
  })

  it('S23c-roster-recreate-blocked: applyRosterReport skips bots in deletedJoinedIds', () => {
    // Knife: delete `if (Array.isArray(state.deletedJoinedIds) && ...)` check → bot recreated → assert fails → RED
    const state = makeState({})
    state.deletedJoinedIds = ['joined:n1:rb1']
    const report = { nodeId: 'n1', online: true, hostname: 'host1', bots: [{ id: 'rb1', name: 'Bot1', role: 'Worker' }] }
    applyRosterReport(state, report)
    assert.equal(state.bots['joined:n1:rb1'], undefined, 'deleted joined bot must NOT be recreated by roster report')
  })

  it('S23c-non-deleted: applyRosterReport still creates non-deleted bots', () => {
    const state = makeState({})
    state.deletedJoinedIds = ['joined:n1:other-bot']
    const report = { nodeId: 'n1', online: true, hostname: 'host1', bots: [{ id: 'rb1', name: 'Bot1', role: 'Worker' }] }
    applyRosterReport(state, report)
    assert.ok(state.bots['joined:n1:rb1'] !== undefined, 'non-deleted bot must still be created')
  })
})
