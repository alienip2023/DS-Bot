import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { install as installRoster } from '../src/host/roster.js'
import { install as installTools } from '../src/host/tools.js'
import { fakeContext } from './fake-ctx.js'

function roleContext(t, role, { missing = false } = {}) {
  const ctx = fakeContext()
  t.mock.method(ctx, 'get', key => {
    if (key !== 'remote-agent:role') return undefined
    if (missing) throw new Error('Role service is missing')
    return role
  })
  return ctx
}

function rosterWorld(t, role, options) {
  const ctx = roleContext(t, role, options)
  const state = { bots: {}, mainBotIds: [], workspaceId: 'team' }
  ctx.workspaceRegistry = { get: () => ({ id: 'team' }) }
  ctx.sessionController = { create: t.mock.fn(async () => ({ sessionId: 'new-bot' })) }
  ctx.sessionTitle = { rename: async () => {} }
  const rt = {
    ctx, state,
    defaults: { mainName: 'Main Bot', mainRole: 'Coordinator' },
    load: async () => {},
    syncModels: async () => {},
    save: t.mock.fn(async () => {}),
    warn: t.mock.fn(),
    botOf: id => state.bots[id],
    findBot: name => Object.values(state.bots).find(bot => bot.name === name),
    readOnly: () => undefined,
    teamFolder: () => undefined,
    resolveAgent: async () => ({ session: {} }),
  }
  installRoster(rt)
  return { rt, state, createSession: ctx.sessionController.create }
}

function toolsWorld(t, role, options) {
  const caller = { id: 'caller', name: 'Caller' }
  const other = { id: 'other', name: 'Other' }
  const state = { bots: { caller, other }, mainBotIds: role === 'worker' ? [] : [caller.id], rooms: {}, prefs: {} }
  const rt = {
    ctx: roleContext(t, role, options), state,
    teamTools: [],
    load: async () => {},
    selfOf: id => id,
    botOf: id => state.bots[id],
    findBot: name => Object.values(state.bots).find(bot => bot.name === name),
    isMain: id => state.mainBotIds.includes(id),
    approveFolder: async () => {},
    catalog: async () => [],
    createBot: t.mock.fn(async bot => ({ id: 'new-bot', ...bot })),
    updateBot: t.mock.fn(async (id, patch) => Object.assign(state.bots[id], patch)),
    createRoom: t.mock.fn(async room => ({ id: 'new-room', ...room })),
  }
  installTools(rt)
  const execute = (name, args) => rt.teamTools.find(tool => tool.name === name)
    .execute(args, { agent: { id: caller.id } })
  return { rt, caller, other, execute }
}

describe('L2 worker role permissions', () => {
  it('bootstrap skips createBot when role is worker', async t => {
    const { rt, state, createSession } = rosterWorld(t, 'worker')
    await rt.bootstrap()
    assert.equal(createSession.mock.callCount(), 0)
    assert.deepEqual(state.bots, {})
    assert.deepEqual(state.mainBotIds, [])
    assert.equal(rt.save.mock.callCount(), 0)
  })

  it('bootstrap downgrades mainBotIds to empty on worker without deleting the bot', async t => {
    const { rt, state, createSession } = rosterWorld(t, 'worker')
    const bot = { id: 'existing', name: 'Former Main', sessionId: 'existing-session' }
    state.bots[bot.id] = bot
    state.mainBotIds = [bot.id]
    const before = structuredClone(state.bots)
    let finishSave
    t.mock.method(rt, 'save', () => new Promise(resolve => { finishSave = resolve }))
    try {
      const completed = await Promise.race([
        rt.bootstrap().then(() => true),
        new Promise(resolve => setImmediate(() => resolve(false))),
      ])
      assert.equal(completed, true, 'bootstrap must not wait for the downgrade save')
      assert.deepEqual(state.mainBotIds, [])
      assert.deepEqual(state.bots, before)
      assert.equal(state.bots[bot.id], bot)
      assert.equal(createSession.mock.callCount(), 0)
      assert.equal(rt.save.mock.callCount(), 1)
      assert.deepEqual(rt.warn.mock.calls[0].arguments, [
        'ds-bot: worker node — clearing mainBotIds (Bots and sessions preserved)',
      ])
      await rt.bootstrap()
      assert.equal(rt.save.mock.callCount(), 1)
      assert.equal(rt.warn.mock.callCount(), 1)
    } finally {
      finishSave?.()
    }
  })

  it('bootstrap creates Main Bot when role is both', async t => {
    const { rt, state, createSession } = rosterWorld(t, 'both')
    await rt.bootstrap()
    assert.equal(createSession.mock.callCount(), 1)
    assert.deepEqual(state.mainBotIds, ['new-bot'])
    assert.equal(state.bots['new-bot'].name, 'Main Bot')
  })

  it('bootstrap creates Main Bot when role service is missing (fail-open)', async t => {
    const { rt, state, createSession } = rosterWorld(t, undefined, { missing: true })
    await rt.bootstrap()
    assert.equal(createSession.mock.callCount(), 1)
    assert.deepEqual(state.mainBotIds, ['new-bot'])
  })

  it('bootstrap creates Main Bot when role is undefined (fail-open)', async t => {
    const { rt, state, createSession } = rosterWorld(t, undefined)
    await rt.bootstrap()
    assert.equal(createSession.mock.callCount(), 1)
    assert.deepEqual(state.mainBotIds, ['new-bot'])
  })

  it('create_bot returns E_WORKER_READONLY for remote-worker on worker node', async t => {
    const { rt, execute } = toolsWorld(t, 'worker')
    t.mock.method(rt, 'isMain', () => false)
    assert.equal(await execute('create_bot', { name: 'New Bot', role: 'Writer', instructions: 'Write reports.', type: 'remote-worker', worker: { hubUrl: 'wss://hub.example.com' } }), 'E_WORKER_READONLY')
    assert.equal(rt.createBot.mock.callCount(), 0)
  })

  it('create_bot on worker does not return E_WORKER_READONLY for local bot', async t => {
    const { rt, execute } = toolsWorld(t, 'worker')
    const result = await execute('create_bot', { name: 'New Bot', role: 'Writer', instructions: 'Write reports.' })
    assert.match(result, /^Created /)
    assert.equal(rt.createBot.mock.callCount(), 1)
  })

  it('create_bot on hub returns isMain error when caller is not main', async t => {
    const { rt, execute } = toolsWorld(t, 'hub')
    t.mock.method(rt, 'isMain', () => false)
    const result = await execute('create_bot', { name: 'New Bot', role: 'Writer', instructions: 'Write reports.' })
    assert.match(result, /Only the Main Bot/)
    assert.equal(rt.createBot.mock.callCount(), 0)
  })

  it('create_bot succeeds when role is undefined (fail-open)', async t => {
    const { rt, execute } = toolsWorld(t, undefined)
    assert.match(await execute('create_bot', { name: 'New Bot', role: 'Writer', instructions: 'Write reports.' }), /^Created New Bot/)
    assert.equal(rt.createBot.mock.callCount(), 1)
  })

  it('create_bot succeeds when role service throws (fail-open)', async t => {
    const { rt, execute } = toolsWorld(t, undefined, { missing: true })
    assert.match(await execute('create_bot', { name: 'New Bot', role: 'Writer', instructions: 'Write reports.' }), /^Created New Bot/)
    assert.equal(rt.createBot.mock.callCount(), 1)
  })

  it('update_bot returns E_WORKER_READONLY when changing a joined bot on worker', async t => {
    const { rt, other, execute } = toolsWorld(t, 'worker')
    other.origin = 'joined'
    other.worker = { nodeId: 'n2' }
    assert.equal(await execute('update_bot', { bot: 'Other', name: 'Changed' }), 'E_WORKER_READONLY')
    assert.equal(rt.updateBot.mock.callCount(), 0)
  })

  it('update_bot on worker does not return E_WORKER_READONLY for local bot', async t => {
    const { rt, execute } = toolsWorld(t, 'worker')
    const result = await execute('update_bot', { bot: 'Other', name: 'Changed' })
    assert.match(result, /^Updated /)
    assert.equal(rt.updateBot.mock.callCount(), 1)
  })

  it('update_bot allows self-update on worker', async t => {
    const { rt, caller, execute } = toolsWorld(t, 'worker')
    t.mock.method(rt, 'isMain', () => false)
    assert.equal(await execute('update_bot', { name: 'Changed' }), 'Updated Changed.')
    assert.equal(rt.updateBot.mock.callCount(), 1)
    assert.equal(caller.name, 'Changed')
  })

  it('update_bot reports an unknown bot on worker', async t => {
    const { rt, execute } = toolsWorld(t, 'worker')
    assert.equal(await execute('update_bot', { bot: 'Unknown' }), 'No Bot named Unknown.')
    assert.equal(rt.updateBot.mock.callCount(), 0)
  })

  it('create_group returns E_WORKER_READONLY on worker', async t => {
    const { rt, execute } = toolsWorld(t, 'worker')
    t.mock.method(rt, 'isMain', () => false)
    assert.equal(await execute('create_group', { name: 'Team', members: ['Other'] }), 'E_WORKER_READONLY')
    assert.equal(rt.createRoom.mock.callCount(), 0)
  })

  it('create_group succeeds when role is both', async t => {
    const { rt, execute } = toolsWorld(t, 'both')
    assert.match(await execute('create_group', { name: 'Team', members: ['Other'] }), /^Created group "Team"/)
    assert.equal(rt.createRoom.mock.callCount(), 1)
  })
})
