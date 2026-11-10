import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyRosterReport } from '../src/host/roster-join.js'
import { joinedDeleteBot, createBotDeleteReceiver } from '../src/host/joined-page.js'

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

  // ── S57-B: bot/delete propagation ──────────────────────────────────────────

  it('S57-B-missing-mark: applyRosterReport marks joined bots absent from report as missingFromReport', () => {
    // Knife: remove missingFromReport assignment → bot has no missingFromReport flag → assert fails → RED
    const state = makeState({
      'joined:n1:rb1': { id: 'joined:n1:rb1', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true } },
      'joined:n1:rb2': { id: 'joined:n1:rb2', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb2', home: 'remote', online: true } },
    })
    // Report only includes rb2 — rb1 is missing
    const report = { nodeId: 'n1', online: true, hostname: 'host1', bots: [{ id: 'rb2', name: 'Bot2', role: 'Worker' }] }
    applyRosterReport(state, report)
    assert.equal(state.bots['joined:n1:rb1']?.worker?.missingFromReport, true, 'absent bot must be marked missingFromReport')
    assert.equal(state.bots['joined:n1:rb2']?.worker?.missingFromReport, undefined, 'present bot must NOT be marked missingFromReport')
  })

  it('S57-B-delete-send: joinedDeleteBot sends bot/delete to node registry', async () => {
    // Knife: comment out registry.send call → sent.length=0 → timeout → error → assert fails → RED
    const sends = []
    const registry = {
      send: (nodeId, type, data) => { sends.push({ nodeId, type, data }); return true },
      on: (event, fn) => {},
      off: (event, fn) => {},
      onlineNodes: () => [{ nodeId: 'n1' }],
    }
    const rt = {
      state: {},
      botOf: (id) => ({
        id, origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' },
      }),
      ctx: { get: (key) => key === 'remote-agent:registry' ? registry : undefined },
    }
    // Don't await (no result listener in this test) — just verify send was dispatched
    const p = joinedDeleteBot(rt, 'joined:n1:rb1')
    assert.equal(sends.length, 1, 'must have dispatched one bot/delete send')
    assert.equal(sends[0].type, 'bot/delete', 'send type must be bot/delete')
    assert.equal(sends[0].data.remoteBotId, 'rb1', 'payload must contain remoteBotId')
    assert.equal(sends[0].data.nodeId, 'n1', 'payload must contain nodeId')
    // Cancel to avoid hanging test (no result listener wired)
    registry.on = () => {}  // already captured, nothing to cancel
    p.catch(() => {})
  })

  it('S57-B-node-receiver: createBotDeleteReceiver calls rt.deleteBot with the correct remoteBotId', async () => {
    // Knife: change `rt.deleteBot(remoteBotId)` to `rt.deleteBot(null)` → deletedWith[0]=null → assert fails → RED
    const deletedWith = []
    const rt = { deleteBot: async (id) => { deletedWith.push(id) } }
    const accept = createBotDeleteReceiver(rt)
    const result = await accept({ remoteBotId: 'rb1' })
    assert.deepEqual(deletedWith, ['rb1'], 'must call rt.deleteBot with remoteBotId')
    assert.equal(result.ok, true, 'must return ok:true on success')
  })

  it('S57-B-offline: joinedDeleteBot returns node-offline when node is not in onlineNodes', async () => {
    // Knife: remove online check → goes ahead and sends → no result → timeout → different error → RED
    const rt = {
      state: {},
      botOf: (id) => ({ id, origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } }),
      ctx: { get: (key) => key === 'remote-agent:registry' ? {
        send: () => true, on: () => {}, off: () => {}, onlineNodes: () => [],
      } : undefined },
    }
    const result = await joinedDeleteBot(rt, 'joined:n1:rb1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'node-offline', 'offline node must return node-offline error immediately')
  })
})

