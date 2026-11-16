import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyRosterReport, reportableBots } from '../src/host/roster-join.js'

describe('joined roster model and missing-flag heal', () => {
  it('reportableBots carries a trimmed model and drops empty or over-long', () => {
    // Knife: drop the model field from reportableBots → the node/only assert fails.
    const out = reportableBots({
      a: { id: 'a', name: 'A', role: 'r', model: '  node/only  ' },
      exact: { id: 'exact', name: 'E', role: 'r', model: 'm'.repeat(128) },
      empty: { id: 'empty', name: 'B', role: 'r', model: '' },
      blank: { id: 'blank', name: 'C', role: 'r', model: '   ' },
      nil: { id: 'nil', name: 'D', role: 'r', model: null },
      num: { id: 'num', name: 'N', role: 'r', model: 12 },
      long: { id: 'long', name: 'L', role: 'r', model: 'm'.repeat(129) },
      bare: { id: 'bare', name: 'G', role: 'r' },
    })
    const byId = Object.fromEntries(out.map((bot) => [bot.id, bot]))
    assert.equal(byId.a.model, 'node/only')
    assert.equal(byId.exact.model.length, 128)
    for (const id of ['empty', 'blank', 'nil', 'num', 'long', 'bare']) {
      assert.equal(Object.hasOwn(byId[id], 'model'), false, `${id} must not carry model`)
      assert.equal(byId[id].id, id)
    }
  })

  it('applyRosterReport writes a reported model and keeps the known one when the next report omits it', () => {
    const state = { bots: {} }
    applyRosterReport(state, {
      nodeId: 'n1',
      hostname: 'host1',
      bots: [{ id: 'rb', name: 'Bot', role: 'r', model: '  node/only  ' }],
    })
    const id = 'joined:n1:rb'
    assert.equal(state.bots[id].model, 'node/only')
    applyRosterReport(state, {
      nodeId: 'n1',
      hostname: 'host1',
      bots: [{ id: 'rb', name: 'Bot', role: 'r' }],
    })
    assert.equal(state.bots[id].model, 'node/only')
    applyRosterReport(state, {
      nodeId: 'n1',
      hostname: 'host1',
      bots: [{ id: 'rb', name: 'Bot', role: 'r', model: '   ' }],
    })
    assert.equal(state.bots[id].model, 'node/only', 'blank model must not clear a known model')
    applyRosterReport(state, {
      nodeId: 'n1',
      hostname: 'host1',
      bots: [{ id: 'rb', name: 'Bot', role: 'r', model: null }],
    })
    assert.equal(state.bots[id].model, 'node/only', 'non-string model must not clear a known model')
    applyRosterReport(state, {
      nodeId: 'n1',
      hostname: 'host1',
      bots: [{ id: 'rb', name: 'Renamed', role: 'r', model: 'other/m' }],
    })
    assert.equal(state.bots[id].model, 'other/m')
    assert.equal(state.bots[id].name, 'Renamed')
  })

  it('a joined bot missing from one report clears missingFromReport when it appears again', () => {
    // Knife: remove `missingFromReport: false` from the seen branch → this stays true.
    const state = { bots: {} }
    applyRosterReport(state, {
      nodeId: 'n1',
      hostname: 'host1',
      bots: [{ id: 'rb', name: 'Bot', role: 'r' }],
    })
    const id = 'joined:n1:rb'
    applyRosterReport(state, { nodeId: 'n1', hostname: 'host1', bots: [] })
    assert.equal(state.bots[id].worker.missingFromReport, true)
    applyRosterReport(state, {
      nodeId: 'n1',
      hostname: 'host1',
      bots: [{ id: 'rb', name: 'Bot', role: 'r' }],
    })
    assert.equal(state.bots[id].worker.missingFromReport, false)
  })
})

  it('applyRosterReport sets homeNodeId at the row top level, outside worker', () => {
    // Knife: remove `homeNodeId: nodeId` from row construction → this test fails.
    const state = { bots: {} }
    applyRosterReport(state, {
      nodeId: 'n1',
      hostname: 'host1',
      bots: [{ id: 'b1', name: 'Bot', role: 'r' }],
    })
    const bot = state.bots['joined:n1:b1']
    assert.equal(bot.homeNodeId, 'n1')
    assert.equal(bot.worker.nodeId, 'n1')
    // homeNodeId must be a sibling of worker, not nested inside it
    assert.equal(Object.hasOwn(bot.worker, 'homeNodeId'), false)
  })

  it('install() backfills homeNodeId for existing joined bots missing it and saves exactly once', async () => {
    // Knife: remove the backfill loop from install() → this test fails.
    const rt = {
      ctx: { get: () => undefined, effect: () => {} },
      state: {
        bots: {
          'joined:n2:b1': { id: 'joined:n2:b1', origin: 'joined', worker: { nodeId: 'n2', home: 'remote' } },
          'joined:n2:b2': { id: 'joined:n2:b2', origin: 'joined', worker: { nodeId: 'n2', home: 'remote' } },
          'local:b3': { id: 'local:b3', origin: 'local', worker: undefined },
          // already has homeNodeId — must not be touched
          'joined:n2:b4': { id: 'joined:n2:b4', origin: 'joined', homeNodeId: 'n2', worker: { nodeId: 'n2', home: 'remote' } },
        },
      },
      saveCount: 0,
    }
    rt.save = () => { rt.saveCount++ }
    const { install } = await import('../src/host/roster-join.js')
    install(rt)
    assert.equal(rt.state.bots['joined:n2:b1'].homeNodeId, 'n2')
    assert.equal(rt.state.bots['joined:n2:b2'].homeNodeId, 'n2')
    assert.equal(rt.state.bots['local:b3'].homeNodeId, undefined)
    assert.equal(rt.state.bots['joined:n2:b4'].homeNodeId, 'n2') // unchanged
    assert.equal(rt.saveCount, 1)
  })

  it('install() backfill saves nothing when no bots need backfilling', async () => {
    // Knife: if the guard `homeNodeId === undefined` is removed the bot would be re-written and
    // an extra save() fired — this test would then fail because saveCount would be > 0.
    const rt = {
      ctx: { get: () => undefined, effect: () => {} },
      state: {
        bots: {
          'joined:n3:b1': { id: 'joined:n3:b1', origin: 'joined', homeNodeId: 'n3', worker: { nodeId: 'n3', home: 'remote' } },
          'local:b2': { id: 'local:b2', origin: 'local', worker: undefined },
        },
      },
      saveCount: 0,
    }
    rt.save = () => { rt.saveCount++ }
    const { install } = await import('../src/host/roster-join.js')
    install(rt)
    assert.equal(rt.saveCount, 0)
  })

  it('local and Worker-type bots are unaffected by applyRosterReport homeNodeId logic', () => {
    // Knife: if homeNodeId were written unconditionally to all bots, local bots would acquire it.
    const state = {
      bots: {
        'local:lb': { id: 'local:lb', origin: 'local', name: 'L', role: 'r' },
      },
    }
    applyRosterReport(state, {
      nodeId: 'n4',
      hostname: 'host4',
      bots: [{ id: 'rb', name: 'Remote', role: 'r' }],
    })
    assert.equal(state.bots['local:lb'].homeNodeId, undefined)
    assert.equal(state.bots['joined:n4:rb'].homeNodeId, 'n4')
  })

  it('joinedMachineLabel renders "Running on {host}" with hostname and falls back to nodeId', async () => {
    // Knife: change joinedMachineLabel to not call tFn → this test fails.
    const { joinedMachineLabel } = await import('../src/client/joined-machine-label.js')
    const calls = []
    const tFn = (key, params) => { calls.push({ key, params }); return `${key}=${JSON.stringify(params)}` }
    const withHostname = joinedMachineLabel({ hostname: 'mac-mini', nodeId: 'n5' }, tFn)
    assert.equal(calls[0]?.key, 'Running on {host}')
    assert.equal(calls[0]?.params?.host, 'mac-mini')
    calls.length = 0
    const withoutHostname = joinedMachineLabel({ hostname: '', nodeId: 'n5' }, tFn)
    assert.equal(calls[0]?.key, 'Running on {host}')
    assert.equal(calls[0]?.params?.host, 'n5')
  })
