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
