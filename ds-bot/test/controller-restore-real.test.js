// fork.71: unloading the plugin puts the core controller methods back — on the REAL cordis.
// A service view in cordis hands out a NEW proxy on every read of a function property, so the old
// "restore only if controller.X === ours" guard never held (fork.69/70 and the older prompt wrapper
// all stayed installed after dispose). These tests run the install code on a real Context with a
// real Service and look at it the way the gateway does (`extend({ invocation }).get(service)`,
// dsh-api-gateway lib/index.js:1242). The pure-object ctx of joined-world.js cannot show it.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { realCordis, REAL_AGENT_SKIP } from './real-agent.js'
import { install } from '../src/host/joined-prompt.js'
import { wrapControllerMethod, rawService } from '../src/host/controller-wrap.js'

const MIRROR = 'mirror-1'
const bot = {
  id: 'joined:n1:rb1', name: 'Joined', origin: 'joined', type: 'remote-worker', sessionId: MIRROR,
  worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true },
}

async function world() {
  const { Context, Service } = await realCordis()
  const calls = { prompt: [], cancel: [], list: [] }
  const listResult = { items: [{ sessionId: MIRROR, running: false }] }
  let raw
  class Controller extends Service {
    constructor(ctx) { super(ctx, 'sessionController') }
    async prompt(request) { calls.prompt.push(request); return { accepted: true, from: 'core-prompt' } }
    async cancel(request) { calls.cancel.push(request); return { accepted: true, from: 'core-cancel' } }
    async list() { calls.list.push(1); return listResult }
  }
  const root = new Context()
  root.plugin(class Boot { constructor(ctx) { raw = new Controller(ctx) } })
  await new Promise(resolve => setTimeout(resolve, 20))
  // how the gateway reaches the service for one call
  const gateway = () => root.extend({ invocation: {} }).get('sessionController')
  const rtFor = ctx => ({
    ctx, warn() {}, botOf: id => (id === bot.id ? bot : undefined),
    bySessionId: sid => (sid === MIRROR ? bot : undefined), chatOf: id => (id === bot.id ? MIRROR : id),
  })
  /** load the plugin (the joined takeover) once; returns its fiber */
  const load = () => {
    return root.plugin({ name: 'ds-bot-under-test', inject: ['sessionController'], apply(ctx) { install(rtFor(ctx)) } })
  }
  return { root, raw: () => raw, calls, listResult, gateway, load }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

describe('S36-real: the controller methods come back after the plugin is disposed (real cordis)', { skip: REAL_AGENT_SKIP }, () => {
  it('S36-real-premise: reading a function property of a service view gives a new function every time (why identity checks cannot work)', async () => {
    const w = await world()
    const view = w.gateway()
    assert.notEqual(view.cancel, view.cancel)
    assert.equal(rawService(view), w.raw(), 'the raw service is reachable through the view')
    await w.root.fiber.dispose()
  })

  it('S36-real-a: while loaded, a Stop for a joined Session is taken over; after dispose the gateway reaches the core methods again — and nothing is left on the service object', async () => {
    const w = await world()
    const fiber = w.load()
    await tick()
    assert.deepEqual(await w.gateway().cancel({ sessionId: MIRROR }), { accepted: true }, 'taken over while loaded')
    assert.equal(w.calls.cancel.length, 0)
    for (const name of ['prompt', 'cancel', 'list']) assert.equal(Object.hasOwn(w.raw(), name), true, `${name} wrapped while loaded`)
    fiber.dispose()
    await tick()
    for (const name of ['prompt', 'cancel', 'list']) assert.equal(Object.hasOwn(w.raw(), name), false, `${name}: no own property left — the prototype method shows again`)
    const result = await w.gateway().cancel({ sessionId: MIRROR })
    assert.equal(result.from, 'core-cancel', 'the Stop reaches the core again')
    assert.equal(w.calls.cancel.length, 1)
    assert.equal(await w.gateway().list({}), w.listResult, 'list is the core\'s own result object')
    assert.equal((await w.gateway().prompt({ sessionId: MIRROR, requestId: 'r' })).from, 'core-prompt')
    await w.root.fiber.dispose()
  })

  it('S36-real-b: loading again after a dispose leaves ONE layer — an ordinary Stop reaches the core once, and the second dispose empties the service object again', async () => {
    const w = await world()
    for (let round = 0; round < 3; round += 1) {
      const fiber = w.load()
      await tick()
      const before = w.calls.cancel.length
      await w.gateway().cancel({ sessionId: 'ordinary-1' })
      assert.equal(w.calls.cancel.length, before + 1, `round ${round}: passed through once`)
      assert.deepEqual(await w.gateway().cancel({ sessionId: MIRROR }), { accepted: true })
      fiber.dispose()
      await tick()
      for (const name of ['prompt', 'cancel', 'list']) assert.equal(Object.hasOwn(w.raw(), name), false, `round ${round}: ${name} restored`)
    }
    await w.root.fiber.dispose()
  })

  it('S36-real-c: a wrapper another plugin put on top is not torn down, and our takeover stops working underneath it', async () => {
    const w = await world()
    const fiber = w.load()
    await tick()
    const view = w.root.sessionController
    const below = view.cancel
    let foreign = 0
    view.cancel = async function (...args) { foreign += 1; return below.apply(this, args) }
    fiber.dispose()
    await tick()
    const result = await w.gateway().cancel({ sessionId: MIRROR })
    assert.equal(foreign, 1, 'the other plugin\'s wrapper is still in place')
    assert.equal(result.from, 'core-cancel', 'our takeover is off: the Stop went down to the core')
    assert.equal(w.calls.cancel.length, 1)
    await w.root.fiber.dispose()
  })

  it('S36-real-d: the helper on its own — a method that was an own property before comes back as that very function', async () => {
    const w = await world()
    const own = async () => ({ own: true })
    Object.defineProperty(w.raw(), 'list', { value: own, writable: true, configurable: true, enumerable: true })
    const fiber = w.root.plugin({ name: 'x', inject: ['sessionController'], apply(ctx) {
      wrapControllerMethod(ctx, ctx.sessionController, 'list', original => async function () { return { wrapped: await original.call(this) } }, 'test')
    } })
    await tick()
    assert.deepEqual(await w.gateway().list(), { wrapped: { own: true } })
    fiber.dispose()
    await tick()
    assert.equal(Object.getOwnPropertyDescriptor(w.raw(), 'list').value, own)
    await w.root.fiber.dispose()
  })
})
