// Tests for exposeBotCreateReceiver() and exposeBotTurnReceiver():
// ctx.set → ctx.provide fix in ds-bot joined-create.js and joined-turn.js.
// Uses a minimal cordis 4.0.2-compatible ctx stub (no cordis dependency).
// Tests import and call the exported product functions directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { exposeBotCreateReceiver, install as installCreate, createBotCreateReceiver } from '../src/host/joined-create.js'
import { exposeBotTurnReceiver, install as installTurn } from '../src/host/joined-turn.js'

// Minimal cordis 4.0.2-compatible ctx stub
function makeCtx() {
  const store = Object.create(null)
  return {
    provide(name, value) {
      if (Object.prototype.hasOwnProperty.call(store, name)) {
        throw new Error(`service "${name}" has been registered`)
      }
      store[name] = { value }
      return () => { delete store[name] }
    },
    set(name, value) {
      if (!Object.prototype.hasOwnProperty.call(store, name)) {
        throw new Error(`cannot set property "${name}" without provide`)
      }
      store[name].value = value
    },
    get(name) {
      return store[name]?.value
    },
  }
}

// Minimal rt for install()
function makeRt(ctx) {
  const created = []
  const rt = {
    ctx,
    state: { bots: {} },
    botCreateTimeoutMs: 500,
    async load() {},
    async save() {},
    async createBot(opts) {
      const id = `local-${opts.name}`
      created.push(opts)
      rt.state.bots[id] = { id, name: opts.name, role: opts.role ?? '' }
      return rt.state.bots[id]
    },
    sendUser() {},
    warn() {},
  }
  // joined-create wires registry; joined-turn needs handleJoinedTurn
  rt.handleJoinedTurn = () => {}
  return { rt, created }
}

// ── Test 1: exposeBotCreateReceiver registers receiver in ctx ──
// Knife: provide→set → ctx.get returns undefined → fails
test('exposeBotCreateReceiver: ctx.get returns the registered receiver', () => {
  const ctx = makeCtx()
  const accept = async () => ({ ok: true })
  exposeBotCreateReceiver(ctx, accept)
  const got = ctx.get('remote-agent:bot-create')
  assert.ok(got !== undefined, 'ctx.get returned undefined — bot-create receiver not registered')
  assert.equal(got, accept, 'got a different function than what was exposed')
})

// ── Test 2: exposeBotTurnReceiver registers receiver in ctx ──
// Knife: provide→set → ctx.get returns undefined → fails
test('exposeBotTurnReceiver: ctx.get returns the registered receiver', () => {
  const ctx = makeCtx()
  const accept = async () => ({ ok: true })
  exposeBotTurnReceiver(ctx, accept)
  const got = ctx.get('remote-agent:bot-turn')
  assert.ok(got !== undefined, 'ctx.get returned undefined — bot-turn receiver not registered')
  assert.equal(got, accept, 'got a different function than what was exposed')
})

// ── Test 3: install(rt) wires both createBotOnNode and exposes the receiver ──
test('install joined-create: rt.createBotOnNode is set AND ctx has bot-create receiver', () => {
  const ctx = makeCtx()
  const { rt, created } = makeRt(ctx)
  installCreate(rt)
  assert.equal(typeof rt.createBotOnNode, 'function', 'createBotOnNode not set on rt')
  const receiver = ctx.get('remote-agent:bot-create')
  assert.ok(typeof receiver === 'function', 'bot-create receiver not in ctx after install')
})

// ── Test 4: the receiver from ctx can actually create a Bot (not an empty shell) ──
test('bot-create receiver from ctx.get creates a local Bot via rt.createBot', async () => {
  const ctx = makeCtx()
  const { rt, created } = makeRt(ctx)
  installCreate(rt)
  const receiver = ctx.get('remote-agent:bot-create')
  // Simulate what remote-agent does after receiving a bot/create frame
  const result = await receiver({ requestId: 'req-1', name: 'RemoteBot', role: '工' })
  assert.equal(result.ok, true, `receiver returned error: ${JSON.stringify(result.error)}`)
  assert.equal(created.length, 1, 'rt.createBot was not called')
  assert.equal(created[0].name, 'RemoteBot')
})

// ── Test 5: install joined-turn: ctx has bot-turn receiver ──
test('install joined-turn: ctx has bot-turn receiver', () => {
  const ctx = makeCtx()
  const { rt } = makeRt(ctx)
  installTurn(rt)
  const receiver = ctx.get('remote-agent:bot-turn')
  assert.ok(typeof receiver === 'function', 'bot-turn receiver not in ctx after install')
})
