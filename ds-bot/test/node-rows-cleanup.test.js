// The node-inventory feature is gone. A team saved while it was on still carries its
// switch, its error slot and the read-only rows that mirrored Bots on another machine;
// one load drops them, with any Thread filed under them, and leaves joined rows alone.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function runtimeOn(home) {
  const ctx = fakeContext({})
  ctx.connection.fetch.register = () => () => {}
  ctx.sessionController = { prompt: async () => ({ accepted: true }), list: async () => ({ items: [] }), cancel: async () => ({ accepted: true }) }
  return createRuntime(ctx, { home })
}

const seed = () => ({
  version: 2,
  mainBotIds: ['main'],
  bots: { main: { id: 'main', name: 'Main', capabilities: [], color: 'deepseek' } },
  threads: {},
  privateArchives: [],
  rooms: {},
  agents: {},
  sections: [],
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  works: {},
  requests: {},
  questions: {},
  views: {},
  closedCards: {},
  prefs: {},
  switching: {},
  whaleStored: true,
  federation: { version: 1, hubId: null, peersAt: 0, inbox: {}, outbox: {}, seen: {}, seq: 0, allowPeerToMain: false, lastError: null },
  revision: 0,
})

describe('N-cleanup: a team saved with node rows loses them on load', () => {
  it('drops the node rows, their threads and the switch, and keeps joined rows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ds-bot-node-cleanup-'))
    // The team this version writes, then the leftovers of the dropped feature on top.
    writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
    const first = runtimeOn(home)
    await first.load()
    await first.save()
    const canonical = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    canonical.prefs.nodeInventory = true
    canonical.nodeInventory = { lastError: 'boom', appliedAt: 7 }
    canonical.bots['node:n1:b1'] = { id: 'node:n1:b1', name: 'Far', origin: 'node', type: 'remote-worker', managedBy: 'node', readonly: true, dispatchable: true, worker: { home: 'node', nodeId: 'n1', remoteBotId: 'b1', hostname: 'VM-12', online: true }, capabilities: [] }
    canonical.bots['joined:n1:b2'] = { id: 'joined:n1:b2', name: 'Near', origin: 'joined', worker: { home: 'remote', nodeId: 'n1', remoteBotId: 'b2', hostname: 'VM-12', online: true }, capabilities: [] }
    canonical.threads['node:n1:b1:main'] = { id: 'node:n1:b1:main', botId: 'node:n1:b1', title: 'Main', isMain: true, createdAt: 2 }
    canonical.threads['joined:n1:b2:main'] = { id: 'joined:n1:b2:main', botId: 'joined:n1:b2', title: 'Main', isMain: true, createdAt: 3 }
    writeFileSync(join(home, 'state.json'), JSON.stringify(canonical))

    const rt = runtimeOn(home)
    await rt.load()
    const disk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(disk.bots['node:n1:b1'], undefined, 'the node row is gone from the file')
    assert.equal(disk.bots['joined:n1:b2'].name, 'Near', 'a joined row stays')
    assert.equal(disk.threads['node:n1:b1:main'], undefined, 'its thread goes with it')
    assert.equal(disk.threads['joined:n1:b2:main'].isMain, true, 'a joined row keeps its thread')
    assert.equal(disk.prefs.nodeInventory, undefined, 'the switch is gone')
    assert.equal(disk.nodeInventory, undefined, 'the error slot is gone')

    const before = readFileSync(join(home, 'state.json'), 'utf8')
    rt.loaded = undefined
    await rt.load()
    assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), before, 'a clean team is not rewritten again')
  })
})
