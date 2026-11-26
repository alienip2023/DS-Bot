// Issue #7 (Windows hub, fork.134): `loader.import('@deepseek-ai/dsh-mcp-client')` threw ERR_INTERNAL_ASSERTION, so every
// MCP the hub shares was `ok:false, tools:[]` for the nodes. Two more faults made it hard to see and expensive: the
// failure kept only `message.slice(0, 300)` (a fixed Node text with no code and no stack), and a failed mount was tried again
// on every pass (1,620 mounts in two minutes) because the failed load was cached and `error !== undefined` never counted as
// mounted. Here the hub's shared mounts are run with a loader that fails as that one did.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const internalAssertion = () => Object.assign(new Error('This is caused by either a bug in Node.js or incorrect usage of Node.js internals. Please open an issue with this stack trace at https://github.com/nodejs/node/issues'), { code: 'ERR_INTERNAL_ASSERTION' })

// A stand-in for the MCP client plugin: registers one tool, the way the real one registers `mcp__<server>__<tool>`.
const standIn = () => ({ name: 'stand-in-mcp', inject: ['tools'], apply(c, config) { c.effect(() => c.tools.register({ name: `mcp__${config.serverName}__ping`, description: 'ping', parameters: { type: 'object', properties: {} }, execute: async () => 'pong' })) } })

async function hub(t, { loader, fallback, now }) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mcp-fail-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, revision: 1, mainBotIds: ['chief'], rooms: {}, threads: {},
    bots: { chief: { id: 'chief', name: 'Chief', sessionId: 'chief', capabilities: [], createdAt: 1 } },
    capabilities: { items: { docs: { name: 'docs', kind: 'mcp', description: 'Docs', transport: 'http', url: 'https://mcp.example.test/mcp', createdBy: null, createdAt: 1, updatedAt: 1 } } },
  }))
  mkdirSync(join(home, 'learning'))
  writeFileSync(join(home, 'learning/state.json'), JSON.stringify({ proposals: {}, pending: {}, learned: {} }))
  const registry = new EventEmitter()
  registry.send = () => true
  const warnings = []
  const ctx = fakeContext({ services: { 'remote-agent:registry': registry, loader } })
  ctx.extend = meta => Object.assign(Object.create(ctx), meta)
  ctx.plugin = function (plugin, config) {
    const disposers = []
    const c = Object.assign(Object.create(this), { effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) } })
    plugin.apply(c, config)
    return { await: async () => {}, dispose: async () => { for (const dispose of disposers.reverse()) await dispose() } }
  }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false, agentsMd: false, learningTimes: { tickMs: 100_000 }, ...(fallback ? { requireMcpClient: fallback } : {}), ...(now ? { now } : {}) })
  rt.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  await rt.load()
  t.after(async () => { await ctx.dispose(); await tick(); rmSync(home, { recursive: true, force: true }) })
  return { rt, warnings }
}

test('MCP-1 a client that cannot be loaded is told with its code and stack, to the nodes and to the log', async (t) => {
  const failure = internalAssertion()
  const { rt, warnings } = await hub(t, { loader: { import: async () => { throw failure }, unwrapExports: e => e }, fallback: () => { throw new Error('require-esm is not available either') } })
  const [entry] = await rt.sharedMcp.catalog()
  assert.equal(entry.ok, false)
  assert.match(entry.reason, /ERR_INTERNAL_ASSERTION/, 'the code is what tells this failure from any other')
  assert.match(entry.reason, /require-esm is not available either/, 'and what the second way said')
  const logged = warnings.join('\n')
  assert.match(logged, /ERR_INTERNAL_ASSERTION/)
  assert.match(logged, /at .*mcp-mount-failure\.test\.js/, 'the stack is in the log, not only the first 300 characters of the message')
})

test('MCP-2 when loader.import fails, the client is taken from require, the failure is still logged, and the tools mount', async (t) => {
  const { rt, warnings } = await hub(t, { loader: { import: async () => { throw internalAssertion() }, unwrapExports: e => e.default ?? e }, fallback: () => ({ default: standIn() }) })
  const [entry] = await rt.sharedMcp.catalog()
  assert.equal(entry.ok, true)
  assert.deepEqual(entry.tools.map(tool => tool.name), ['mcp__docs__ping'])
  assert.match(warnings.join('\n'), /ERR_INTERNAL_ASSERTION/, 'taking the other way is not silent: what loader.import said is in the log')
})

test('MCP-3 a mount that failed is not tried again on every pass: it waits, longer each time, and a changed config tries at once', async (t) => {
  let imports = 0
  let clock = 1_000_000
  const { rt } = await hub(t, { loader: { import: async () => { imports += 1; throw internalAssertion() }, unwrapExports: e => e }, fallback: () => { throw new Error('no') }, now: () => clock })
  for (let pass = 0; pass < 50; pass += 1) await rt.sharedMcp.sync()
  assert.equal(imports, 1, 'fifty passes, one attempt')
  clock += 6_000
  for (let pass = 0; pass < 20; pass += 1) await rt.sharedMcp.sync()
  assert.equal(imports, 2, 'after the first wait, one more')
  clock += 6_000
  for (let pass = 0; pass < 20; pass += 1) await rt.sharedMcp.sync()
  assert.equal(imports, 2, 'the second wait is longer than the first')
  clock += 60_000
  await rt.sharedMcp.sync()
  assert.equal(imports, 3)
  rt.state.capabilities.items.docs.url = 'https://mcp.example.test/other'
  await rt.sharedMcp.sync()
  assert.equal(imports, 4, 'a changed config is not made to wait')
})

test('MCP-4 a failed load is not remembered for good: once the client can be loaded, the next attempt mounts', async (t) => {
  let broken = true
  const { rt } = await hub(t, { loader: { import: async () => { if (broken) throw internalAssertion(); return { default: standIn() } }, unwrapExports: e => e.default ?? e }, fallback: () => { throw new Error('no') }, now: (() => { let at = 1_000_000; return () => (at += 400_000) })() })
  assert.equal((await rt.sharedMcp.catalog())[0].ok, false)
  broken = false
  await rt.sharedMcp.sync()
  assert.equal((await rt.sharedMcp.catalog())[0].ok, true)
})
