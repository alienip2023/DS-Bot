import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  hubBotCount, hubBots, hubEntryTotal, hubFindBot, hubMachines, hubNodeEntries,
  hubPlaceDepth, hubPlaceKey, hubPlaceScope, hubTeamEntries,
} from '../src/client/memory-hub-model.js'

const SCOPES = {
  team: { entries: 3 },
  nodes: [
    { nodeId: 'n1', hostname: 'studio', online: true, lastSeq: 4, sentSeq: 4, lastSeen: 10, entries: 2,
      bots: [{ remoteBotId: 'rb1', name: 'One', entries: 5 }, { remoteBotId: 'rb2', name: 'Two', entries: 0 }] },
    { nodeId: 'n2', hostname: 'air', online: false, lastSeq: 1, sentSeq: 0, lastSeen: 4, entries: 0, bots: [] },
  ],
}

test('the machine list keeps an offline node, and counts its Bots', () => {
  const machines = hubMachines(SCOPES)
  assert.equal(machines.length, 2)
  assert.equal(hubBotCount(machines[1]), 0)
  assert.deepEqual(hubBots(machines[0]).map(bot => bot.name), ['One', 'Two'])
  assert.equal(hubNodeEntries(machines[0]), 2)
  assert.equal(hubNodeEntries(machines[1]), 0)
})

test('the totals add the team, every machine, and every Bot', () => {
  assert.equal(hubTeamEntries(SCOPES), 3)
  assert.equal(hubEntryTotal(SCOPES), 3 + 2 + 0 + 5 + 0)
})

test('a missing or broken scope list reads as empty, never as undefined', () => {
  assert.deepEqual(hubMachines(null), [])
  assert.equal(hubTeamEntries({}), 0)
  assert.equal(hubEntryTotal(undefined), 0)
  assert.equal(hubNodeEntries({}), 0)
  assert.deepEqual(hubBots(undefined), [])
})

test('a place maps to the contract scope and to a stable key', () => {
  assert.deepEqual(hubPlaceScope({ kind: 'team' }), { kind: 'team' })
  assert.deepEqual(hubPlaceScope({ kind: 'node', nodeId: 'n1' }), { kind: 'node', nodeId: 'n1' })
  assert.deepEqual(hubPlaceScope({ kind: 'bot', nodeId: 'n1', remoteBotId: 'rb1' }),
    { kind: 'bot', nodeId: 'n1', remoteBotId: 'rb1' })
  // An empty place is the team: the panel opens on it before the user picks anything.
  assert.deepEqual(hubPlaceScope(undefined), { kind: 'team' })
  assert.equal(hubPlaceKey({ kind: 'team' }), 'team')
  assert.equal(hubPlaceKey({ kind: 'node', nodeId: 'n1' }), 'node:n1')
  assert.equal(hubPlaceKey({ kind: 'bot', nodeId: 'n1', remoteBotId: 'rb1' }), 'joined:n1:rb1')
  // The key is never just 'team' for a node: a remote scope keeps its own name.
  assert.notEqual(hubPlaceKey({ kind: 'node', nodeId: 'n1' }), 'team')
})

test('the depth orders the three layers', () => {
  assert.equal(hubPlaceDepth({ kind: 'team' }), 0)
  assert.equal(hubPlaceDepth({ kind: 'node', nodeId: 'n1' }), 1)
  assert.equal(hubPlaceDepth({ kind: 'bot', nodeId: 'n1', remoteBotId: 'rb1' }), 2)
})

test('a Bot is found under its own machine only', () => {
  assert.equal(hubFindBot(SCOPES, 'n1', 'rb1').name, 'One')
  assert.equal(hubFindBot(SCOPES, 'n2', 'rb1'), undefined)
  assert.equal(hubFindBot(SCOPES, 'missing', 'rb1'), undefined)
})
