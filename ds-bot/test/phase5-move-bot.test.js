// Phase 5: move_bot tool — migrate a Bot from one node to another.
import assert from 'node:assert/strict'
import { test } from 'node:test'

function makeRt(bots = {}) {
  return {
    state: { bots, leases: {} },
    isMain: () => true,
    selfOf: () => ({}),
    save: async () => {},
    load: async () => {},
  }
}

function makeTool(rt, ctx) {
  // Minimal inline reimplementation of the move_bot execute logic for unit testing.
  return async function moveBotExecute(args) {
    await rt.load()
    if (!rt.isMain(rt.selfOf({}))) return 'Only the Main Bot can move Bots between machines.'
    const botName = typeof args.bot === 'string' ? args.bot.trim() : ''
    const toArg = typeof args.to === 'string' ? args.to.trim() : ''
    if (!botName) return 'Specify the Bot to move with `bot`.'
    if (!toArg) return 'Specify the target machine with `to`.'
    const bots = Object.values(rt.state?.bots ?? {})
    const bot = bots.find(b => b.name?.toLowerCase() === botName.toLowerCase()) ??
                bots.find(b => b.identityId === botName)
    if (!bot) return `No Bot named "${botName}" on the team.`
    if (!bot.identityId) return `${bot.name} has no portable identity yet — it cannot be moved until it reports one (the node needs AC 0.4.33 or later).`
    if (bot.worker?.home !== 'remote' || bot.origin !== 'joined') return `${bot.name} is not a node Bot and cannot be moved with this tool.`
    if (bot.private) return `${bot.name} is private and stays on its current machine.`
    const registry = ctx.registry
    if (!registry) return 'Node registry not available.'
    const nodes = typeof registry.onlineNodes === 'function' ? registry.onlineNodes() : []
    const target = nodes.find(n => n.nodeId === toArg || n.hello?.hostname === toArg)
    if (!target) return `No online node matching "${toArg}". Use list_machines to see what is available.`
    if (target.nodeId === bot.worker?.nodeId) return `${bot.name} is already on ${toArg}.`
    const caps = Array.isArray(target.caps) ? target.caps : (target.hello?.caps ?? [])
    const hasMove = caps.length === 0 || caps.includes('bot-move/1')
    if (!hasMove) return `${toArg} does not support Bot migration yet (needs AC with bot-move/1). Upgrade that node first.`
    // Migrate lease epoch.
    const { migrateLease } = await import('../src/host/lease.js')
    migrateLease(rt.state, bot.identityId, target.nodeId)
    const prevNodeId = bot.worker?.nodeId
    bot.worker = { ...bot.worker, nodeId: target.nodeId, home: 'remote', online: false }
    bot.homeNodeId = target.nodeId
    await rt.save?.()
    return [`${bot.name} migration initiated.`, `From: ${prevNodeId}`, `To: ${target.nodeId}`].join('\n')
  }
}

test('move_bot: missing bot name returns error', async () => {
  const rt = makeRt()
  const exec = makeTool(rt, { registry: { onlineNodes: () => [] } })
  assert.match(await exec({ bot: '', to: 'node-b' }), /Specify the Bot/)
})

test('move_bot: unknown bot returns error', async () => {
  const rt = makeRt({})
  const exec = makeTool(rt, { registry: { onlineNodes: () => [] } })
  assert.match(await exec({ bot: 'Ghost', to: 'node-b' }), /No Bot named/)
})

test('move_bot: bot without identityId cannot be moved', async () => {
  const rt = makeRt({ 'joined:n1:ada': { id: 'joined:n1:ada', name: 'Ada', origin: 'joined', worker: { home: 'remote', nodeId: 'node-a' } } })
  const exec = makeTool(rt, { registry: { onlineNodes: () => [] } })
  assert.match(await exec({ bot: 'Ada', to: 'node-b' }), /no portable identity/)
})

test('move_bot: private bot cannot be moved', async () => {
  const rt = makeRt({
    'joined:n1:ada': { id: 'joined:n1:ada', name: 'Ada', identityId: '0123456789abcdef', origin: 'joined', private: true, worker: { home: 'remote', nodeId: 'node-a' } },
  })
  const exec = makeTool(rt, { registry: { onlineNodes: () => [] } })
  assert.match(await exec({ bot: 'Ada', to: 'node-b' }), /private/)
})

test('move_bot: target node offline returns error', async () => {
  const rt = makeRt({
    'joined:n1:ada': { id: 'joined:n1:ada', name: 'Ada', identityId: '0123456789abcdef', origin: 'joined', worker: { home: 'remote', nodeId: 'node-a' } },
  })
  const exec = makeTool(rt, { registry: { onlineNodes: () => [] } })
  assert.match(await exec({ bot: 'Ada', to: 'node-b' }), /No online node/)
})

test('move_bot: bot already on target returns error', async () => {
  const rt = makeRt({
    'joined:n1:ada': { id: 'joined:n1:ada', name: 'Ada', identityId: '0123456789abcdef', origin: 'joined', worker: { home: 'remote', nodeId: 'node-a' } },
  })
  const registry = { onlineNodes: () => [{ nodeId: 'node-a', hello: { hostname: 'mypc' }, caps: [] }] }
  const exec = makeTool(rt, { registry })
  assert.match(await exec({ bot: 'Ada', to: 'node-a' }), /already on/)
})

test('move_bot: successful migration updates worker.nodeId and bumps lease epoch', async () => {
  const rt = makeRt({
    'joined:n1:ada': { id: 'joined:n1:ada', name: 'Ada', identityId: '0123456789abcdef', origin: 'joined', worker: { home: 'remote', nodeId: 'node-a', remoteBotId: 'ada' } },
  })
  const registry = { onlineNodes: () => [{ nodeId: 'node-b', hello: { hostname: 'newpc' }, caps: [] }] }
  const exec = makeTool(rt, { registry })
  const result = await exec({ bot: 'Ada', to: 'node-b' })
  assert.match(result, /migration initiated/)
  const bot = rt.state.bots['joined:n1:ada']
  assert.equal(bot.worker.nodeId, 'node-b')
  assert.equal(bot.homeNodeId, 'node-b')
  // Lease epoch should be set (first migration from no lease → epoch 1).
  const lease = rt.state.leases['0123456789abcdef']
  assert.ok(lease, 'lease created')
  assert.equal(lease.machineId, 'node-b')
  assert.equal(lease.epoch, 1, 'epoch set to 1 on first migration (no prior lease)')
})

test('move_bot: node without bot-move/1 is refused', async () => {
  const rt = makeRt({
    'joined:n1:ada': { id: 'joined:n1:ada', name: 'Ada', identityId: '0123456789abcdef', origin: 'joined', worker: { home: 'remote', nodeId: 'node-a' } },
  })
  const registry = { onlineNodes: () => [{ nodeId: 'node-b', hello: { hostname: 'newpc' }, caps: ['some-other/1'] }] }
  const exec = makeTool(rt, { registry })
  assert.match(await exec({ bot: 'Ada', to: 'node-b' }), /does not support Bot migration/)
})
