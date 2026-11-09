// R1: no local agent turn on a joined Bot's mirror Session — behaviour on a REAL Agent.
// The trigger is what dsh-client-auto-continue does (engine.ts:1195-1211): agent.followup() of a
// plain user message, outside ctx.sessionController.prompt. On an unguarded mirror Agent the core
// then writes agent/inbox/spliced + a native turn/start (the numbering collision that made the
// stored log unloadable).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { realAgentWorld, REAL_AGENT_SKIP } from './real-agent.js'
import { install, guardAgent } from '../src/host/mirror-guard.js'
import { fakeContext } from './fake-ctx.js'

const MIRROR = 'mirror-1'
const botOf = (sessionId = MIRROR) => ({
  id: 'joined:n1:rb1', origin: 'joined', type: 'remote-worker', sessionId,
  worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true },
})

// rt as the guard sees it: the real ctx, the Bot lookup, a warn that records.
function guardRt(world, { bots = new Map([[MIRROR, botOf()]]) } = {}) {
  const warns = []
  const rt = { ctx: world.ctx, warn: (...args) => warns.push(args.join(' ')), bySessionId: id => bots.get(id) }
  return { rt, warns, bots }
}

const INJECT = ['followup', 'steer', 'inject']

describe('R1-guard: a plugin-injected message cannot start a local turn on a mirror Session', { skip: REAL_AGENT_SKIP }, () => {
  it('R1-a: followup/steer/inject on a mirror Agent created after install are dropped — no splice, no turn, empty inbox', async () => {
    const world = await realAgentWorld()
    try {
      const { rt, warns } = guardRt(world)
      install(rt)
      const agent = await world.create(MIRROR)
      for (const method of INJECT) agent[method](world.message(`via ${method}`))
      await agent.whenIdle()
      const types = world.types(agent)
      assert.equal(types.includes('turn/start'), false, `no native turn: ${types}`)
      assert.equal(types.includes('agent/inbox/spliced'), false, 'the message is refused before it is recorded')
      assert.equal(agent.inbox.hasPending, false)
      assert.equal(agent.status, 'idle')
      assert.equal(rt.mirrorGuardRefused, 3)
      assert.ok(warns.length >= 1)
      for (const line of warns) assert.equal(/via (followup|steer|inject)/.test(line), false, 'the log carries counts, never the message')
    } finally { await world.dispose() }
  })

  it('R1-b: an ordinary Session\'s Agent is untouched — the same followup starts its turn', async () => {
    const world = await realAgentWorld()
    try {
      const { rt } = guardRt(world)
      install(rt)
      const agent = await world.create('ordinary-1')
      assert.equal(Object.hasOwn(agent, 'send'), false, 'not patched')
      agent.followup(world.message())
      await agent.whenIdle()
      assert.ok(world.types(agent).includes('turn/start'), 'a normal Agent still runs its turn')
      assert.equal(rt.mirrorGuardRefused ?? 0, 0)
    } finally { await world.dispose() }
  })

  it('R1-c: a mirror Agent that was already live when the guard installed is guarded too (reload)', async () => {
    const world = await realAgentWorld()
    try {
      const agent = await world.create(MIRROR)
      const { rt } = guardRt(world)
      install(rt)
      agent.followup(world.message())
      await agent.whenIdle()
      assert.equal(world.types(agent).includes('turn/start'), false)
      assert.equal(world.types(agent).includes('agent/inbox/spliced'), false)
    } finally { await world.dispose() }
  })

  it('R1-d: the net — an Agent created before its Session was a known mirror: the first message is removed and no turn starts, later ones are dropped at send', async () => {
    const world = await realAgentWorld()
    try {
      const bots = new Map()
      const { rt } = guardRt(world, { bots })
      install(rt)
      const agent = await world.create(MIRROR)
      assert.equal(Object.hasOwn(agent, 'send'), false, 'not known as a mirror yet: unpatched')
      bots.set(MIRROR, botOf())
      agent.followup(world.message('first'))
      await agent.whenIdle()
      let types = world.types(agent)
      assert.equal(types.includes('turn/start'), false, 'the net stopped the wake of that same send()')
      assert.equal(agent.inbox.hasPending, false, 'and took the message back out')
      const splices = types.filter(type => type === 'agent/inbox/spliced').length
      assert.equal(splices, 2, 'insert + cancel')
      agent.followup(world.message('second'))
      await agent.whenIdle()
      types = world.types(agent)
      assert.equal(types.filter(type => type === 'agent/inbox/spliced').length, splices, 'the guard is on now: nothing more is recorded')
      assert.equal(types.includes('turn/start'), false)
    } finally { await world.dispose() }
  })

  it('R1-e: wakeDriver itself starts nothing on a mirror Agent, even with input already pending', async () => {
    const world = await realAgentWorld()
    try {
      const { rt } = guardRt(world)
      const agent = await world.create(MIRROR)
      // pending input written before the guard exists (a stored inbox from an earlier run)
      agent.inbox.append('next-turn', world.message('left over'))
      assert.equal(agent.inbox.hasPending, true)
      assert.equal(guardAgent(rt, agent), true)
      agent.wakeDriver()
      await agent.whenIdle()
      assert.equal(world.types(agent).includes('turn/start'), false)
      assert.equal(agent.status, 'idle')
    } finally { await world.dispose() }
  })

  it('R1-f: registration order does not matter — a creation listener registered BEFORE the guard that follows up at once is still refused', async () => {
    const world = await realAgentWorld()
    try {
      let eager
      world.ctx.on('agent/created', ({ agent }) => { if (agent.id === MIRROR) { eager = agent; agent.followup(world.message('eager')) } })
      const { rt } = guardRt(world)
      install(rt)
      const agent = await world.create(MIRROR)
      await agent.whenIdle()
      assert.ok(eager, 'the earlier listener did run')
      assert.equal(world.types(agent).includes('turn/start'), false, 'the prepended guard ran first')
      assert.equal(world.types(agent).includes('agent/inbox/spliced'), false, 'refused at send, not rescued by the net after the splice')
    } finally { await world.dispose() }
  })

  it('R1-g: auto-continue style — a followup three seconds after a mirror turn was written does not open a native turn', async () => {
    const world = await realAgentWorld()
    try {
      const { rt } = guardRt(world)
      install(rt)
      const agent = await world.create(MIRROR)
      // what the plugin wrote: the page turn, numbered by allocateTurn
      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'E_TIMEOUT' } } })
      agent.followup(world.message('继续'))
      await agent.whenIdle()
      const turns = agent.session.log.filter(event => event.type === 'turn/start').map(event => event.data.turn)
      assert.deepEqual(turns, [1], 'no second, natively numbered turn')
    } finally { await world.dispose() }
  })

  it('R1-h: a Bot that stops being a joined mirror gets its Agent back (the wrappers ask at every call)', async () => {
    const world = await realAgentWorld()
    try {
      const bots = new Map([[MIRROR, botOf()]])
      const { rt } = guardRt(world, { bots })
      install(rt)
      const agent = await world.create(MIRROR)
      agent.followup(world.message('while mirror'))
      await agent.whenIdle()
      assert.equal(world.types(agent).includes('turn/start'), false)
      bots.delete(MIRROR)
      agent.followup(world.message('after'))
      await agent.whenIdle()
      assert.ok(world.types(agent).includes('turn/start'), 'plain again')
    } finally { await world.dispose() }
  })
})

describe('R1-unload: the guard hands the methods back when the plugin unloads', () => {
  it('R1-i: after ctx.dispose() a guarded Agent has its own send/wakeDriver again', async () => {
    const ctx = fakeContext()
    const calls = []
    const agent = { id: MIRROR, session: { id: MIRROR }, send: (...a) => { calls.push(['send', ...a]); return 'orig-send' }, wakeDriver: () => { calls.push(['wake']) }, inbox: { remove() {} } }
    ctx.get = name => (name === 'agents' ? { list: () => [agent] } : undefined)
    const original = { send: agent.send, wake: agent.wakeDriver }
    const rt = { ctx, warn() {}, bySessionId: id => (id === MIRROR ? botOf() : undefined) }
    install(rt)
    assert.notEqual(agent.send, original.send, 'guarded')
    agent.send('m')
    assert.equal(calls.length, 0, 'dropped while guarded')
    await ctx.dispose()
    assert.equal(agent.send, original.send)
    assert.equal(agent.wakeDriver, original.wake)
    assert.equal(agent.send('m'), 'orig-send')
    assert.equal(calls.length, 1)
  })
})
