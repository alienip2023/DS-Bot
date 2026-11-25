// Capability sharing (docs: ds-bot-cluster/DESIGN-capability-sharing.md, fork.131): the hub's MCP servers on a node, end
// to end. A real ds-bot hub and node joined by AC's real code (the hub's NodeRegistry ingest, the node's frame
// dispatcher, both bot-networks, the reliable link and `team/act`). The MCP client itself is a stand-in that registers
// tools the way @deepseek-ai/dsh-mcp-client does (`mcp__<server>__<tool>`), so what is checked is what ds-bot does.
// Needs the AC repo with the reliable link (REMOTE_AGENT_REPO, or a sibling dsh-ai-cluster).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as realMcp from '@deepseek-ai/dsh-mcp-client'
import { threadWorld } from './thread-t2-world.js'
import { applyCatalog } from '../src/host/capability-share.js'
import { refOf } from '../src/host/bot-link.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = [process.env.REMOTE_AGENT_REPO, resolve(PLUGIN, '../../dsh-ai-cluster'), resolve(PLUGIN, '../../../Projects/dsh-ai-cluster')]
  .filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
  .find(dir => existsSync(join(dir, 'lib/reliable-wire.js')))
const skip = repo === undefined ? 'AC repo with the reliable link not found (set REMOTE_AGENT_REPO)' : false
const load = file => import(pathToFileURL(join(repo, 'lib', file)).href)
const settle = async (n = 24) => { for (let i = 0; i < n; i += 1) await new Promise(r => setImmediate(r)) }
async function until(check, label, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 5)) }
  assert.fail(`timed out: ${label}`)
}

const SECRET = 'erp-key-9f8e7d6c5b4a'
const bot = (id, name) => ({ id, sessionId: id, name, role: 'Exec', instructions: '', createdAt: 1 })
const joined = (nodeId, id, name) => ({ ...bot(`joined:${nodeId}:${id}`, name), type: 'remote-worker', origin: 'joined', worker: { home: 'remote', online: true, nodeId, remoteBotId: id, hostname: `box-${nodeId}` } })
const team = (bots, mainBotIds = []) => ({ version: 1, mainBotIds, revision: 1, whaleStored: true, capabilities: { items: {} }, bots: Object.fromEntries(bots.map(b => [b.id, b])), rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, works: {}, prefs: {} })
const erp = (extra = {}) => ({ name: 'erp', kind: 'mcp', description: 'ERP lookups', transport: 'stdio', command: 'node', args: ['server.mjs'], env: { ERP_KEY: '$DSH_SECRET_ERP_KEY' }, ...extra })

// What the MCP client does: one tool per entry, registered under mcp__<server>__<tool>.
function standIn(hold) {
  return {
    name: 'mcp-client',
    inject: ['tools'],
    apply(c, config) {
      c.effect(() => {
        const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
        const lookup = { name: `mcp__${config.serverName}__lookup`, description: 'Look up an order by id', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, output, execute: async args => `order ${args.id}: paid (key ${config.env?.ERP_KEY ?? 'none'})` }
        const slow = { name: `mcp__${config.serverName}__slow`, description: 'Waits', parameters: { type: 'object', properties: {} }, output, execute: async () => { await hold.promise; return 'late' } }
        const undo = [c.tools.register(lookup), c.tools.register(slow)]
        return () => { for (const un of undo) un() }
      })
    },
  }
}
const withPlugin = ctx => {
  ctx.extend = meta => Object.assign(Object.create(ctx), meta)
  ctx.plugin = function (plugin, config) {
    const disposers = []
    const c = Object.assign(Object.create(this), { effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) } })
    plugin.apply(c, config)
    return { await: async () => {}, dispose: async () => { for (const d of disposers.reverse()) await d() } }
  }
}

async function cluster(t, { secrets = [{ name: 'ERP_KEY', value: SECRET, purpose: '', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1 }], real = false } = {}) {
  const { NodeRegistry } = await load('hub/node-registry.js')
  const { createHubBotNetwork } = await load('hub/bot-network.js')
  const { createBotNetwork } = await load('node/bot-network.js')
  const { createFrameDispatcher } = await load('node/dispatch.js')
  const { attachHubReliable, attachNodeReliable } = await load('reliable-wire.js')
  const registry = new NodeRegistry({ log() {} })
  registry.e2eReady = nodeId => registry.nodes.get(nodeId)?.online === true
  let hubCtx
  const hubNetwork = createHubBotNetwork({ registry, ctx: { get: (name, d) => hubCtx?.get(name, d) } })
  const detachHub = attachHubReliable({ registry, network: hubNetwork })
  const hold = Promise.withResolvers()
  const loader = real ? { import: async () => realMcp, unwrapExports: exports => exports } : { import: async () => ({ default: standIn(hold) }), unwrapExports: exports => exports.default }
  const world = (prefix, state, services, files = {}) => {
    const home = mkdtempSync(join(tmpdir(), prefix))
    writeFileSync(join(home, 'state.json'), JSON.stringify(state))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(home, name), text)
    return threadWorld({ home, services })
  }
  const hub = world('cap-hub-', team([bot('chief', 'Chief'), joined('node010', 'e10', 'Exec10')], ['chief']),
    { 'remote-agent:registry': registry, 'remote-agent:bot-network': hubNetwork, loader }, { 'secrets.json': JSON.stringify({ secrets }) })
  hubCtx = hub.ctx
  withPlugin(hub.ctx)
  let root
  if (real) {
    // The hub's context that mounts the real MCP client: a real cordis context with DSH's test services.
    root = new Context()
    await mountAgentLoopTestDependencies(root)
    hub.ctx.extend = meta => root.extend(meta)
  }
  // The node
  const transport = new EventEmitter()
  transport.online = true
  const send = (type, data) => {
    if (!transport.online) return false
    queueMicrotask(() => registry.handleFrameFor('node010', { v: 1, t: type, id: 'x', d: structuredClone(data) }))
    return true
  }
  const network = createBotNetwork({ nodeId: 'node010', send, sendHub: send })
  const dispatch = createFrameDispatcher({ network, send, sendError() {}, logger: {}, ctx: undefined })
  const detachNode = attachNodeReliable({ nodeId: 'node010', transport, send, network })
  registry.nodes.set('node010', { nodeId: 'node010', online: true, tasks: new Map(), hello: { hostname: 'box-node010', os: 'linux' },
    conn: { closed: false, send: text => { if (!transport.online) throw new Error('closed'); const frame = JSON.parse(text); queueMicrotask(() => dispatch(frame, frame.d)) } } })
  const node = world('cap-node-', team([bot('e10', 'Exec10'), bot('e11', 'Exec11')]), { 'remote-agent:bot-network': network, loader })
  // The node's Agents: what they register is what the Bot could call.
  const registered = new Map()
  const agents = new Map()
  node.rt.resolveAgent = async id => {
    if (!agents.has(id)) {
      const tools = new Map()
      registered.set(id, tools)
      const base = { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
      agents.set(id, { id, session: { id }, status: 'idle', ctx: {
        tools: base,
        extend(meta) { return Object.assign(Object.create(this), meta) },
        effect() {},
        plugin(plugin, config) {
          const disposers = []
          const c = Object.assign(Object.create(this), { effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) } })
          plugin.apply(c, config)
          return { await: async () => {}, dispose: async () => { for (const d of disposers.reverse()) await d() } }
        },
      } })
    }
    return agents.get(id)
  }
  await Promise.all([hub.rt.load(), node.rt.load()])
  await hub.rt.loadSecrets()
  hub.rt.state.federation ??= {}
  hub.rt.state.federation.hubId ??= 'hub-test'
  t.after(async () => {
    hold.resolve()
    await root?.fiber.dispose()
    detachHub(); detachNode()
    for (const w of [hub, node]) await w.ctx.dispose?.()
  })
  return { hub, node, registry, transport, registered, hold, network }
}
const toolOf = (c, botId, name) => c.registered.get(botId)?.get(name)
const pushToNode = async c => { await c.hub.rt.pushSharedCatalog('node010'); await settle() }
const settleNode = async c => { await c.node.rt.reconcileCapabilities(); await settle() }

test('CAPS-1 the catalog tells a node what a shared MCP can do and nothing of how it runs: no command, no secret', { skip }, async t => {
  const c = await cluster(t)
  await c.hub.rt.capabilitySave(erp(), { ui: true })
  const catalog = await c.hub.rt.sharedMcp.catalog()
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].ok, true)
  assert.deepEqual(catalog[0].tools.map(tool => tool.name), ['mcp__erp__lookup', 'mcp__erp__slow'])
  assert.deepEqual(catalog[0].tools[0].inputSchema.required, ['id'])
  const text = JSON.stringify(catalog)
  for (const hidden of [SECRET, 'server.mjs', 'ERP_KEY', 'DSH_SECRET', '"command"', '"env"']) assert.equal(text.includes(hidden), false, `${hidden} is not in the catalog`)
  // and what reaches the node's library is the same
  await pushToNode(c)
  const item = c.node.rt.state.capabilities.items.erp
  assert.equal(item.transport, 'hub-proxy')
  assert.equal(item.sharedFrom, 'hub:hub-test')
  assert.equal(JSON.stringify(item).includes(SECRET), false)
  for (const key of ['command', 'args', 'env', 'url', 'headers']) assert.equal(Object.hasOwn(item, key), false, `${key} is not on the node`)
})

test('CAPS-2 a Bot of the node that attached nothing has the hub\'s tools under the names the hub gives them, and a call runs on the hub', { skip }, async t => {
  const c = await cluster(t)
  await c.hub.rt.capabilitySave(erp(), { ui: true })
  await pushToNode(c)
  await settleNode(c)
  assert.deepEqual(c.node.rt.state.bots.e10.capabilities, [], 'nothing attached')
  const lookup = toolOf(c, 'e10', 'mcp__erp__lookup')
  assert.ok(lookup, 'the tool is there')
  assert.deepEqual(lookup.parameters.required, ['id'])
  const result = await lookup.execute({ id: '42' }, { agent: { id: 'e10' } })
  assert.match(result, /^order 42: paid/)
  assert.equal(result.includes(SECRET), false, 'the hub redacts the secret out of what it sends')
  // the hub logged who called what, and not what was said
  const line = JSON.parse(readFileSync(join(c.hub.home, 'logs/capability-calls.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.deepEqual([line.nodeId, line.bot, line.capability, line.tool, line.ok], ['node010', 'Exec10', 'erp', 'mcp__erp__lookup', true])
  assert.equal(JSON.stringify(line).includes('42'), false)
})

test('CAPS-3 a Bot turns the shared MCP off for itself and on again; the other Bot of the node keeps it', { skip }, async t => {
  const c = await cluster(t)
  await c.hub.rt.capabilitySave(erp(), { ui: true })
  await pushToNode(c)
  await c.node.rt.ensureCapabilities('e10'); await c.node.rt.ensureCapabilities('e11')
  await settleNode(c)
  assert.ok(toolOf(c, 'e11', 'mcp__erp__lookup'))
  await c.node.rt.changeCapabilityAttachment('detach', { name: 'erp' }, 'e10')
  await settleNode(c)
  assert.equal(toolOf(c, 'e10', 'mcp__erp__lookup'), undefined, 'off for e10')
  assert.ok(toolOf(c, 'e11', 'mcp__erp__lookup'), 'on for e11')
  await c.node.rt.changeCapabilityAttachment('attach', { name: 'erp' }, 'e10')
  await settleNode(c)
  assert.ok(toolOf(c, 'e10', 'mcp__erp__lookup'), 'on again')
})

test('CAPS-4 what is not to be shared is not: sharing turned off, a stdio MCP nobody approved, a private Bot\'s MCP', { skip }, async t => {
  const c = await cluster(t)
  c.hub.rt.isPrivate = id => id === 'chief-private'
  await c.hub.rt.capabilitySave(erp({ name: 'off-one', share: false }), { ui: true })
  await c.hub.rt.capabilitySave(erp({ name: 'unapproved' }), { botId: 'chief' })
  assert.equal(c.hub.rt.state.capabilities.items.unapproved.approved, false)
  c.hub.rt.state.capabilities.items['private-one'] = { ...erp({ name: 'private-one' }), approved: true, createdBy: 'chief-private', createdAt: 1, updatedAt: 1 }
  await c.hub.rt.capabilitySave(erp({ name: 'visible' }), { ui: true })
  const names = (await c.hub.rt.sharedMcp.catalog()).map(entry => entry.name)
  assert.deepEqual(names, ['visible'])
  assert.equal(c.hub.rt.state.capabilities.items['off-one'].share, false)
  // an edit that does not mention the switch keeps it
  await c.hub.rt.capabilitySave(erp({ name: 'off-one', description: 'changed' }), { ui: true })
  assert.equal(c.hub.rt.state.capabilities.items['off-one'].share, false)
})

test('CAPS-5 a call for something the hub does not share, from a Bot the hub does not know, or with bad arguments, is refused', { skip }, async t => {
  const c = await cluster(t)
  await c.hub.rt.capabilitySave(erp({ name: 'off-one', share: false }), { ui: true })
  await c.hub.rt.capabilitySave(erp(), { ui: true })
  await pushToNode(c)
  const actor = refOf(c.node.rt, c.node.rt.botOf('e10'))
  const act = body => c.network.teamAct({ requestId: `r-${Math.random()}`, actor, tool: 'cap_call', args: typeof body === 'string' ? body : JSON.stringify(body) })
  assert.deepEqual((await act({ capability: 'off-one', tool: 'mcp__off-one__lookup', arguments: { id: '1' } })).ok, false)
  assert.match((await act({ capability: 'erp', tool: 'mcp__erp__nothing', arguments: {} })).text, /no tool/)
  assert.match((await act('not json')).text, /valid JSON/)
  assert.match((await act({ capability: 'erp', tool: 'mcp__erp__lookup', arguments: [1] })).text, /object of arguments/)
  // a Bot of another machine cannot pass as this node's: the hub finds the shadow by the node the frame came from
  const stranger = await c.network.teamAct({ requestId: 'r-stranger', actor: { id: 'ghost', name: 'Ghost', nodeId: 'node010' }, tool: 'cap_call', args: JSON.stringify({ capability: 'erp', tool: 'mcp__erp__lookup', arguments: { id: '1' } }) })
  assert.equal(stranger.ok, false)
  assert.match(stranger.text, /not known on the hub/)
})

test('CAPS-6 with the hub not connected a call fails at once, and is not kept to run later', { skip }, async t => {
  const c = await cluster(t)
  await c.hub.rt.capabilitySave(erp(), { ui: true })
  await pushToNode(c)
  await settleNode(c)
  c.transport.online = false
  const started = Date.now()
  await assert.rejects(toolOf(c, 'e10', 'mcp__erp__lookup').execute({ id: '7' }, { agent: { id: 'e10' } }), /hub is not connected/)
  assert.ok(Date.now() - started < 1000, 'it did not wait')
  c.transport.online = true
  await settle()
  assert.equal(c.hub.rt.sharedMcp.has('erp'), true)
  const logFile = join(c.hub.home, 'logs/capability-calls.jsonl')
  assert.equal(existsSync(logFile) && readFileSync(logFile, 'utf8').includes('"7"'), false, 'the hub never ran it')
})

test('CAPS-7 no more than four calls of one Bot run at once on the hub', { skip }, async t => {
  const c = await cluster(t)
  await c.hub.rt.capabilitySave(erp(), { ui: true })
  await pushToNode(c)
  await settleNode(c)
  const slow = toolOf(c, 'e10', 'mcp__erp__slow')
  const running = Array.from({ length: 4 }, () => slow.execute({}, { agent: { id: 'e10' } }))
  await until(() => true, 'started')
  await settle(40)
  await assert.rejects(slow.execute({}, { agent: { id: 'e10' } }), /already running/)
  c.hold.resolve()
  assert.deepEqual(await Promise.all(running), ['late', 'late', 'late', 'late'])
  assert.equal(await slow.execute({}, { agent: { id: 'e10' } }), 'late', 'a slot is free again')
})

test('CAPS-8 the hub takes a shared MCP away and the node loses it; an MCP of the node\'s own with the same name stays its own', async t => {
  const w = threadWorld({})
  t.after(async () => { await w.ctx.dispose?.() })
  await w.rt.load()
  w.rt.state.capabilities.items.erp = { name: 'erp', kind: 'mcp', transport: 'stdio', command: 'own', args: [], env: {}, approved: true, createdBy: null, createdAt: 1, updatedAt: 1 }
  w.rt.state.capabilities.items.docs = { name: 'docs', kind: 'mcp', transport: 'hub-proxy', description: 'old', tools: [], ok: true, sharedFrom: 'hub:hub-test', createdBy: null, createdAt: 1, updatedAt: 1 }
  const entry = (name, extra = {}) => ({ name, kind: 'mcp', description: 'd', ok: true, tools: [{ name: `mcp__${name}__t`, description: 't', inputSchema: { type: 'object', properties: {} } }], ...extra })
  assert.equal(await applyCatalog(w.rt, 'hub-test', [entry('erp'), entry('crm')]), true)
  const items = w.rt.state.capabilities.items
  assert.equal(items.erp.command, 'own', 'the node\'s own is not replaced')
  assert.equal(items.crm.transport, 'hub-proxy')
  assert.equal(items.docs, undefined, 'what the hub no longer shares is gone')
  // a malformed entry, a tool outside its server's namespace, and a bad hub id change nothing
  assert.equal(await applyCatalog(w.rt, 'bad id!', [entry('crm')]), false)
  await applyCatalog(w.rt, 'hub-test', [entry('crm'), { ...entry('evil'), tools: [{ name: 'mcp__other__t', description: '', inputSchema: {} }] }, { name: 'Bad Name', tools: [] }])
  assert.deepEqual(items.evil.tools, [], 'a tool outside the server\'s namespace is left out')
  assert.equal(items['Bad Name'], undefined)
})

test('CAPS-9 a skill sync does not take the hub\'s MCP proxies with it, and the push after a roster push sends the catalog', async t => {
  const c = await cluster(t)
  await c.hub.rt.capabilitySave(erp(), { ui: true })
  await pushToNode(c)
  assert.ok(c.node.rt.state.capabilities.items.erp)
  // the hub's skill push (nothing in it) must leave the proxy in place
  const { applySharedSkills } = await import('../src/host/skill-share.js')
  await applySharedSkills(c.node.rt, 'hub:hub-test', { version: 1, items: [] })
  assert.ok(c.node.rt.state.capabilities.items.erp, 'the proxy stays')
  // a catalog the node was already given is not sent again
  const before = c.hub.rt.capsSent.get('node010')
  assert.equal(await c.hub.rt.pushSharedCatalog('node010'), false)
  assert.equal(c.hub.rt.capsSent.get('node010'), before)
})

test('CAPS-10 only the hub says what is shared: a catalog frame that came from another node is ignored', { skip }, async t => {
  const c = await cluster(t)
  const entry = { name: 'planted', kind: 'mcp', description: 'x', ok: true, tools: [{ name: 'mcp__planted__t', description: '', inputSchema: {} }] }
  // As AC delivers a frame another node sent through the hub: the link names the node it came from.
  c.network.receiveReliable('rel/frame', { rid: 'planted-1', type: 'team/caps', data: { hubId: 'hub-test', items: [entry] }, from: 'node011' })
  await settle()
  assert.equal(c.node.rt.state.capabilities.items.planted, undefined)
  c.network.receiveReliable('rel/frame', { rid: 'planted-2', type: 'team/caps', data: { hubId: 'hub-test', items: [entry] } })
  await settle()
  assert.ok(c.node.rt.state.capabilities.items.planted, 'the same frame from the hub is taken')
})

test('CAPS-11 a node Bot that may not manage the team can still call what the hub shares', { skip }, async t => {
  const c = await cluster(t)
  c.hub.rt.state.prefs.nodeManagers = 'none'
  await c.hub.rt.capabilitySave(erp(), { ui: true })
  await pushToNode(c)
  await settleNode(c)
  assert.match(await toolOf(c, 'e10', 'mcp__erp__lookup').execute({ id: '9' }, { agent: { id: 'e10' } }), /^order 9/)
  const actor = refOf(c.node.rt, c.node.rt.botOf('e10'))
  const managed = await c.network.teamAct({ requestId: 'm-1', actor, tool: 'delete_bot', args: '{}' })
  assert.equal(managed.ok, false, 'team management is still refused')
})

const notion = () => [{ name: 'notion', description: 'Notion: pages and databases', config: { transport: 'streamable-http', serverName: 'notion', url: 'http://127.0.0.1:9/mcp?key=gateway-secret', headers: { Authorization: 'Bearer gateway-secret' } } }]

test('CAPS-12 a connector the hub is signed in to is shared too: its tools reach the node, its address and credentials do not', { skip }, async t => {
  const c = await cluster(t)
  c.hub.rt.connectorHosts = async () => notion()
  const catalog = await c.hub.rt.sharedMcp.catalog()
  assert.deepEqual(catalog.map(entry => entry.name), ['notion'])
  assert.equal(JSON.stringify(catalog).includes('gateway-secret'), false)
  assert.equal(JSON.stringify(catalog).includes('127.0.0.1'), false)
  await pushToNode(c)
  await settleNode(c)
  const lookup = toolOf(c, 'e10', 'mcp__notion__lookup')
  assert.ok(lookup, 'the node Bot has the connector\'s tools')
  assert.match(await lookup.execute({ id: '5' }, { agent: { id: 'e10' } }), /^order 5/)
  // the hub signs out of it: the node loses it
  c.hub.rt.connectorHosts = async () => []
  await c.hub.rt.sharedMcp.sync()
  await pushToNode(c)
  await settleNode(c)
  assert.equal(c.node.rt.state.capabilities.items.notion, undefined)
  assert.equal(toolOf(c, 'e10', 'mcp__notion__lookup'), undefined)
})

test('CAPS-13 a connector turned off for a node Bot on the hub is off for it on the node', { skip }, async t => {
  const c = await cluster(t)
  c.hub.rt.connectorHosts = async () => notion()
  c.hub.rt.connectorOffFor = id => (id === 'joined:node010:e10' ? ['mcp__notion__'] : [])
  await pushToNode(c)
  await settleNode(c)
  await assert.rejects(toolOf(c, 'e10', 'mcp__notion__lookup').execute({ id: '5' }, { agent: { id: 'e10' } }), /turned off for Exec10/)
})

test('CAPS-14 a connector the node is signed in to itself is not replaced by the hub\'s', { skip }, async t => {
  const c = await cluster(t)
  c.node.rt.connectorConnected = id => id === 'notion'
  c.hub.rt.connectorHosts = async () => notion()
  await pushToNode(c)
  assert.equal(c.node.rt.state.capabilities.items.notion, undefined)
})

test('CAPS-15 a catalog asked for while a sync is running is built from what is shared now, not from what the running sync read', { skip }, async t => {
  const c = await cluster(t)
  c.hub.rt.connectorHosts = async () => { await settle(10); return [] }
  const running = c.hub.rt.sharedMcp.sync()
  c.hub.rt.connectorHosts = async () => notion()
  const catalog = await c.hub.rt.sharedMcp.catalog()
  assert.deepEqual(catalog.map(entry => entry.name), ['notion'])
  await running
})

test('CAPS-16 save_capability can keep an MCP to the hub, and list_capabilities says what goes to the nodes', { skip }, async t => {
  const c = await cluster(t)
  const tool = name => c.hub.rt.teamTools.find(def => def.name === name)
  const exec = { agent: { id: 'chief' } }
  await tool('save_capability').execute({ name: 'erp', kind: 'mcp', transport: 'streamable-http', url: 'https://erp.example/mcp', description: 'ERP' }, exec)
  await tool('save_capability').execute({ name: 'hub-only', kind: 'mcp', transport: 'streamable-http', url: 'https://hub.example/mcp', share_with_nodes: false }, exec)
  assert.equal(c.hub.rt.state.capabilities.items['hub-only'].share, false)
  assert.equal(c.hub.rt.state.capabilities.items.erp.share, undefined)
  const listed = String(await tool('list_capabilities').execute({}, exec))
  assert.match(listed, /- erp \(mcp\).*shared with every node, called through the hub/)
  assert.match(listed, /- hub-only \(mcp\).*not shared with the nodes \(turned off\)/)
})

const ECHO_SERVER = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url))
test('CAPS-17 with the real MCP client and a real stdio server: a node Bot calls it through the hub, the server gets the secret and the node never sees it', { skip }, async t => {
  const c = await cluster(t, { real: true })
  await c.hub.rt.capabilitySave({ name: 'echo', kind: 'mcp', description: 'Echo', transport: 'stdio', command: process.execPath, args: [ECHO_SERVER], env: { ECHO_KEY: '$DSH_SECRET_ERP_KEY' } }, { ui: true })
  const catalog = await c.hub.rt.sharedMcp.catalog()
  assert.equal(catalog[0].ok, true, JSON.stringify(catalog))
  assert.deepEqual(catalog[0].tools.map(tool => tool.name), ['mcp__echo__echo'])
  assert.deepEqual(catalog[0].tools[0].inputSchema.required, ['text'])
  await pushToNode(c)
  await settleNode(c)
  const echo = toolOf(c, 'e10', 'mcp__echo__echo')
  assert.ok(echo)
  const result = await echo.execute({ text: 'hi' }, { agent: { id: 'e10' } })
  assert.match(result, /^echo: hi \(key /)
  assert.equal(result.includes(SECRET), false, 'the server had the key; the node was not given it')
  assert.equal(JSON.stringify(c.node.rt.state).includes(SECRET), false, 'the key is nowhere on the node')
})
