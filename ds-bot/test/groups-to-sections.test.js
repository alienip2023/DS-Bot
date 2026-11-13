// This fork's custom Bot groups (state.groups + bot.groupId) are gone: upstream's
// sections are the one sidebar grouping model. A saved team is migrated once, on adopt,
// into sections, and the old field never comes back. Real createRuntime, real route,
// real store load/save.
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
  empty: { id: 'empty', name: 'Empty', color: null, order: 2, collapsed: false, botIds: [] },
}
const saved = (groups = GROUPS) => ({
  version: 1, mainBotIds: ['main'],
  bots: {
    main: { id: 'main', name: 'Main', capabilities: [] },
    b1: { id: 'b1', name: 'B1', groupId: 'g1', capabilities: [] },
    b2: { id: 'b2', name: 'B2', groupId: 'g1', capabilities: [] },
    b3: { id: 'b3', name: 'B3', groupId: 'g2', capabilities: [] },
    b4: { id: 'b4', name: 'B4', capabilities: [] },
  },
  rooms: {}, agents: {},
  groups,
  sections: [{ id: 's1', name: 'Workflow', color: 'blue' }],
})

function world(groups) {
  const ctx = fakeContext({})
  const routes = []
  ctx.connection.fetch.register = route => { routes.push(route); return () => {} }
  ctx.sessionController = { prompt: async () => ({ accepted: true }), list: async () => ({ items: [] }), cancel: async () => ({ accepted: true }) }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-groups-migrate-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved(groups)))
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload = {}) => {
    const route = routes.find(r => r.path === ROUTE)
    const response = await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })
    return JSON.parse(await response.text())
  }
  const onDisk = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  return { rt, call, onDisk, home }
}

describe('S50-groups-migrate: state.groups becomes sections once, and never comes back', () => {
  it('M-convert: every non-empty group becomes a section in saved order, members move in, groupId and groups are gone', async () => {
    const w = world()
    await w.rt.load()
    assert.equal(w.rt.state.groups, undefined, 'the old field is dropped in memory')
    const ids = w.rt.state.sections.map(sec => sec.id)
    assert.deepEqual(ids, ['s1', 'g1', 'g2'], 'saved sections first, then groups by order; the empty group makes nothing')
    const g1 = w.rt.state.sections.find(sec => sec.id === 'g1')
    assert.equal(g1.name, '执行机')
    assert.equal(g1.collapsed, undefined)
    const g2 = w.rt.state.sections.find(sec => sec.id === 'g2')
    assert.equal(g2.name, 'Research')
    assert.equal(g2.color, 'blue')
    assert.equal(g2.collapsed, true, 'the saved collapsed state carries over')
    assert.equal(w.rt.state.bots.b1.sectionId, 'g1')
    assert.equal(w.rt.state.bots.b2.sectionId, 'g1')
    assert.equal(w.rt.state.bots.b3.sectionId, 'g2')
    assert.equal(w.rt.state.bots.b4.sectionId, undefined, 'a Bot in no group stays ungrouped')
    for (const bot of Object.values(w.rt.state.bots)) assert.equal(bot.groupId, undefined, 'no Bot keeps the old groupId')
    assert.equal(w.rt.state.sections.some(sec => sec.id === 'empty'), false, 'an empty group never becomes an empty section')
    assert.equal(w.rt.state.sections.some(sec => sec.id === 's1'), true, 'an existing section is untouched')

    const disk = w.onDisk()
    assert.equal(disk.groups, undefined, 'the migration is saved to disk')
    assert.deepEqual(disk.sections.map(sec => sec.id), ['s1', 'g1', 'g2'])
    assert.equal(disk.bots.b1.groupId, undefined)
  })

  it('M-view: the roster view has sections and no groups field', async () => {
    const w = world()
    await w.rt.load()
    const view = await w.call('state')
    assert.equal(view.ok, true, JSON.stringify(view).slice(0, 200))
    assert.equal('groups' in view.value, false, 'the groups field is not part of the view any more')
    assert.ok(view.value.sections.some(sec => sec.id === 'g1'))
  })

  it('M-idempotent: loading the migrated team again changes nothing', async () => {
    const w = world()
    await w.rt.load()
    const first = JSON.stringify(w.onDisk())
    w.rt.loaded = undefined
    await w.rt.load()
    const second = JSON.stringify(w.onDisk())
    assert.equal(second, first, 'a second load neither adds a section nor moves a Bot')
    assert.equal(w.rt.state.sections.filter(sec => sec.name === '执行机').length, 1, 'no duplicate section')
  })

  it('M-empty: a team whose groups are all empty loses the field without gaining a section', async () => {
    const w = world({ empty: { id: 'empty', name: 'Empty', order: 0, botIds: [] } })
    await w.rt.load()
    assert.deepEqual(w.rt.state.sections.map(sec => sec.id), ['s1'])
    assert.equal(w.onDisk().groups, undefined)
  })

  it('M-deleted-bot: a group naming a Bot that no longer exists still migrates and simply skips it', async () => {
    const w = world({ g1: { id: 'g1', name: '执行机', order: 0, botIds: ['b1', 'gone'] } })
    await w.rt.load()
    assert.equal(w.rt.state.bots.b1.sectionId, 'g1')
    assert.equal(w.rt.state.sections.find(sec => sec.id === 'g1').name, '执行机')
    assert.equal(w.onDisk().groups, undefined)
  })

  it('M-v2-disk: a canonical v2 team writes the migrated sections to disk on load alone', async () => {
    // A team saved by this version carries capabilities.items, whaleStored and federation, so
    // every other reason to save is already settled on disk. Only the groups migration is
    // left to do, and it has to reach the file by itself: the version 1 seeds above also trip
    // hadCapabilities, which masked a migration that lived in memory only.
    const first = world()
    await first.rt.load()
    await first.rt.save()
    const canonical = first.onDisk()
    assert.equal(canonical.capabilities.items !== undefined, true, 'the seed has canonical capabilities')
    assert.equal(canonical.whaleStored, true, 'the seed has the whale already stored')
    assert.equal(canonical.federation !== undefined, true, 'the seed has federation state')

    canonical.groups = GROUPS
    canonical.sections = [{ id: 's1', name: 'Workflow', color: 'blue' }]
    for (const bot of Object.values(canonical.bots)) delete bot.sectionId
    for (const [id, group] of Object.entries(GROUPS)) {
      for (const botId of group.botIds) canonical.bots[botId].groupId = id
    }
    writeFileSync(join(first.home, 'state.json'), JSON.stringify(canonical))

    const ctx = fakeContext({})
    ctx.connection.fetch.register = () => () => {}
    ctx.sessionController = { prompt: async () => ({ accepted: true }), list: async () => ({ items: [] }), cancel: async () => ({ accepted: true }) }
    const rt = createRuntime(ctx, { home: first.home })
    await rt.load()

    const disk = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8'))
    assert.deepEqual(disk.sections.map(sec => sec.id), ['s1', 'g1', 'g2'], 'the migration is on disk without an explicit save')
    assert.equal(disk.bots.b1.sectionId, 'g1')
    assert.equal(disk.bots.b3.sectionId, 'g2')
    assert.equal(disk.groups, undefined, 'the old field is gone from the file')
    assert.equal(disk.bots.b1.groupId, undefined)

    const before = readFileSync(join(first.home, 'state.json'), 'utf8')
    rt.loaded = undefined
    await rt.load()
    assert.equal(readFileSync(join(first.home, 'state.json'), 'utf8'), before, 'a second load does not touch the file again')
  })

  it('M-old-endpoints: the custom group endpoints are no longer routed', async () => {
    const w = world()
    await w.rt.load()
    for (const [endpoint, payload] of [
      ['create-bot-group', { name: 'Fresh' }],
      ['rename-group', { id: 'g1', name: 'Renamed' }],
      ['toggle-bot-group', { id: 'g1' }],
      ['delete-bot-group', { id: 'g1' }],
      ['move-bot-to-group', { botId: 'b1', groupId: 'g1' }],
    ]) {
      const result = await w.call(endpoint, payload)
      assert.equal(result.ok, false, endpoint)
      assert.equal(result.error.code, 'bot/not-found', endpoint)
    }
  })
})
