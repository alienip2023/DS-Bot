// s50 / merge plan I12, ruling D1=A: upstream's `state.sections` is the one sidebar grouping model of the merged
// plugin; this fork's `state.groups` (+ bot.groupId) data is kept exactly as saved — no migration, no deletion —
// and keeps working through its own endpoints. Real createRuntime, real route, real store load/save.
// Pre-merge the groups cases are green (they pin what must survive) and the sections cases are red (no sections
// in fork.76); after the merge both must be green.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRuntime } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const GROUPS = {
  g1: { id: 'g1', name: '执行机', color: null, order: 0, collapsed: false, botIds: ['b1', 'b2'] },
  g2: { id: 'g2', name: 'Research', color: 'blue', order: 1, collapsed: true, botIds: ['b3'] },
}
const saved = () => ({
  version: 1, mainBotIds: ['main'],
  bots: {
    main: { id: 'main', name: 'Main', capabilities: [] },
    b1: { id: 'b1', name: 'B1', groupId: 'g1', capabilities: [], sectionId: 's1' },
    b2: { id: 'b2', name: 'B2', groupId: 'g1', capabilities: [] },
    b3: { id: 'b3', name: 'B3', groupId: 'g2', capabilities: [] },
    b4: { id: 'b4', name: 'B4', capabilities: [] },
  },
  rooms: {}, agents: {},
  groups: GROUPS,
  sections: [{ id: 's1', name: 'Workflow', color: 'blue' }],
})

function world() {
  const ctx = fakeContext({})
  const routes = []
  ctx.connection.fetch.register = route => { routes.push(route); return () => {} }
  ctx.sessionController = { prompt: async () => ({ accepted: true }), list: async () => ({ items: [] }), cancel: async () => ({ accepted: true }) }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-groups-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved()))
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload = {}) => {
    const route = routes.find(r => r.path === ROUTE)
    const response = await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })
    return JSON.parse(await response.text())
  }
  const onDisk = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  return { rt, call, onDisk }
}

describe('S50-groups: state.groups survives the merge and the introduction of sections', () => {
  it('G-load: a saved team with groups AND sections loads with every group exactly as saved, and the groupId of every Bot', async () => {
    const w = world()
    await w.rt.load()
    assert.deepEqual(w.rt.state.groups, GROUPS)
    assert.equal(w.rt.state.bots.b1.groupId, 'g1')
    assert.equal(w.rt.state.bots.b3.groupId, 'g2')
    assert.equal(w.rt.state.bots.b4.groupId, undefined)
  })

  it('G-view: the roster view carries the groups untouched (the sidebar renders them from here)', async () => {
    const w = world()
    await w.rt.load()
    const view = await w.call('state')
    assert.equal(view.ok, true, JSON.stringify(view).slice(0, 200))
    assert.deepEqual(view.value.groups, GROUPS)
  })

  it('G-endpoints: the group endpoints are still routed to the group handlers — create, rename, toggle, move, delete (none is swallowed by a section branch)', async () => {
    const w = world()
    const toggled = await w.call('toggle-bot-group', { id: 'g1' })
    assert.equal(toggled.ok, true, JSON.stringify(toggled))
    assert.equal(toggled.value.groups.g1.collapsed, true, 'toggled')
    assert.equal(w.onDisk().groups.g1.collapsed, true, 'and saved')
    const renamed = await w.call('rename-group', { id: 'g2', name: 'Renamed' })
    assert.equal(renamed.value.groups.g2.name, 'Renamed')
    const created = await w.call('create-bot-group', { name: 'Fresh', botIds: ['b4'] })
    assert.equal(created.ok, true)
    const freshId = Object.keys(created.value.groups).find(id => !(id in GROUPS))
    assert.equal(created.value.groups[freshId].name, 'Fresh')
    const moved = await w.call('move-bot-to-group', { botId: 'b4', groupId: 'g2' })
    assert.equal(moved.ok, true)
    assert.deepEqual(moved.value.groups.g2.botIds.sort(), ['b3', 'b4'])
    assert.equal(w.onDisk().bots.b4.groupId, 'g2')
    const deleted = await w.call('delete-bot-group', { id: freshId })
    assert.equal(freshId in deleted.value.groups, false)
    assert.equal((await w.call('toggle-bot-group', { id: 'nope' })).error.code, 'bot/not-found')
  })

  it('G-section-ops-leave-groups: saving, ordering and deleting a section never touches groups or any Bot\'s groupId', async () => {
    const w = world()
    const made = await w.call('section-save', { name: 'Second' })
    assert.equal(made.ok, true, JSON.stringify(made).slice(0, 300))
    assert.ok(w.onDisk().sections.some(sec => sec.name === 'Second'))
    const second = w.onDisk().sections.find(sec => sec.name === 'Second').id
    assert.equal((await w.call('section-order', { ids: [second, 's1'] })).ok, true)
    assert.equal((await w.call('section-delete', { id: 's1' })).ok, true)
    const disk = w.onDisk()
    assert.deepEqual(disk.groups, GROUPS, 'the groups are byte for byte what was saved')
    assert.equal(disk.bots.b1.groupId, 'g1')
    assert.equal(disk.bots.b1.sectionId, undefined, 'the deleted section is let go of by the Bot')
    assert.equal(disk.sections.some(sec => sec.id === 's1'), false)
  })

  it('G-both-on-a-bot: a Bot with a groupId and a sectionId keeps both through a save', async () => {
    const w = world()
    await w.rt.load()
    await w.rt.save()
    const disk = w.onDisk()
    assert.equal(disk.bots.b1.groupId, 'g1')
    assert.equal(disk.bots.b1.sectionId, 's1')
    assert.deepEqual(disk.sections, [{ id: 's1', name: 'Workflow', color: 'blue' }])
  })
})
