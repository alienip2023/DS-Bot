// A node has no Main Bot: all of its Bots are ordinary, and the hub's Main Bot is the only one that runs the team.
// The hub's Main Bot also changes and deletes the Bots of a node with its tools (not only from the page).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NODE_NO_MAIN, demoteNodeMains, install, isNodeRole } from '../src/host/node-team.js'
import { deleteBotTool, isNodeBot, updateNodeBot } from '../src/host/node-bot-tools.js'

const rtOf = ({ role, mains = ['m1'], extra = {} } = {}) => {
  const saves = []
  const warns = []
  const rt = {
    ctx: { get: name => (name === 'remote-agent:role' ? role : undefined), effect: (fn) => { rt.disposers.push(fn()) } },
    disposers: [],
    state: { mainBotIds: [...mains], bots: { m1: { id: 'm1', name: 'DeepSeek' }, b2: { id: 'b2', name: 'Helper' } } },
    load: async () => {}, save: async () => { saves.push(1) }, warn: (...args) => warns.push(args.join(' ')),
    setMain: async (id, main) => ({ id, main }),
    createBot: async (options) => ({ id: 'new', ...options }),
    saves, warns, ...extra,
  }
  return rt
}

test('NT-1: a worker node loses its Main Bot at start; the Bots stay, as ordinary ones', async () => {
  const rt = rtOf({ role: 'worker' })
  assert.equal(isNodeRole(rt), true)
  assert.equal(await demoteNodeMains(rt), 1)
  assert.deepEqual(rt.state.mainBotIds, [])
  assert.deepEqual(Object.keys(rt.state.bots), ['m1', 'b2'], 'no Bot is removed')
  assert.equal(rt.saves.length, 1)
  assert.equal(await demoteNodeMains(rt), 0, 'nothing left to do')
})

test('NT-2: a hub, a machine that is both, and a machine whose role is not known (yet) keep their Main Bot', async () => {
  for (const role of ['hub', 'both', undefined]) {
    const rt = rtOf({ role })
    assert.equal(await demoteNodeMains(rt), 0, String(role))
    assert.deepEqual(rt.state.mainBotIds, ['m1'])
  }
})

test('NT-3: on a node nothing can make a Bot Main; on a hub it still can', async () => {
  const node = rtOf({ role: 'worker', mains: [] })
  install(node)
  await assert.rejects(node.setMain('b2', true), error => error.code === 'E_NODE_NO_MAIN' && error.message === NODE_NO_MAIN)
  await assert.rejects(node.createBot({ name: 'X', main: true }), error => error.code === 'E_NODE_NO_MAIN')
  assert.deepEqual(await node.setMain('b2', false), { id: 'b2', main: false }, 'taking the role away is always fine')
  assert.equal((await node.createBot({ name: 'Y' })).name, 'Y', 'an ordinary Bot can be created')
  const hub = rtOf({ role: 'hub', mains: ['m1'] })
  install(hub)
  assert.deepEqual(await hub.setMain('b2', true), { id: 'b2', main: true })
  assert.equal((await hub.createBot({ name: 'Z', main: true })).main, true)
  for (const rt of [node, hub]) for (const dispose of rt.disposers) dispose?.()
})

test('NT-4: the check runs by itself after start (a node nobody opened a page on)', async () => {
  const rt = rtOf({ role: 'worker' })
  install(rt)
  const until = Date.now() + 3000
  while (rt.state.mainBotIds.length > 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(rt.state.mainBotIds, [])
  for (const dispose of rt.disposers) dispose?.()
})

// ── the hub's Main Bot changes and deletes a node Bot ───────────────────────────────────────────

const shadow = { id: 'joined:n1:b1', name: 'Worker', origin: 'joined', worker: { home: 'remote', nodeId: 'n1', remoteBotId: 'b1' } }

test('NT-5: update_bot on a node Bot sends bot/update and reports what the node said; a refusal is a refusal', async () => {
  const sent = []
  const rt = { joinedUpdateBot: async (id, patch) => { sent.push([id, patch]); return { ok: true } }, updateBot: async () => ({}) }
  assert.equal(isNodeBot(shadow), true)
  const text = await updateNodeBot(rt, shadow, { name: 'Renamed', role: 'Dev', model: 'p/m', work_dir: '/srv/x', effort: 'high' })
  assert.deepEqual(sent, [['joined:n1:b1', { name: 'Renamed', role: 'Dev', model: 'p/m', workDir: '/srv/x', effort: 'high' }]])
  assert.match(text, /^Updated Worker on node n1: name, role, model, effort, workDir\./)
  const down = await updateNodeBot({ joinedUpdateBot: async () => ({ ok: false, error: 'node-offline' }) }, shadow, { name: 'X' })
  assert.match(down, /Could not change Worker on its node: the node is offline\. Nothing was changed\./)
  assert.match(await updateNodeBot({ joinedUpdateBot: async () => ({ ok: false, error: 'bot-update-profile-unsupported' }) }, shadow, { color: 'blue' }), /too old to change a name, role or colour/)
  assert.match(await updateNodeBot(rt, shadow, { avatar: '/x.png' }), /profile picture/)
  assert.match(await updateNodeBot(rt, shadow, { type: 'normal' }), /type cannot be changed/)
  assert.match(await updateNodeBot(rt, shadow, {}), /Nothing to change/)
  // a section is this hub's own arrangement: applied here, not sent
  const local = []
  const onlySection = await updateNodeBot({ joinedUpdateBot: async () => assert.fail('nothing for the node'), updateBot: async (id, patch) => { local.push([id, patch]) } }, shadow, { section: 'Ops' })
  assert.deepEqual(local, [['joined:n1:b1', { section: 'Ops' }]])
  assert.match(onlySection, /section/)
})

const execOf = () => ({ agent: { id: 'agent-1' } })
function deleteRt({ main = true, bots = {} } = {}) {
  const deleted = []
  const all = { main: { id: 'main', name: 'Chief' }, other: { id: 'other', name: 'Helper' }, 'joined:n1:b1': shadow, ...bots }
  return {
    deleted, load: async () => {}, selfOf: () => (main ? 'main' : 'other'), isMain: id => id === 'main',
    findBot: name => Object.values(all).find(bot => bot.name === name),
    deleteBot: async (id) => { deleted.push(id) },
  }
}

test('NT-6: delete_bot: Main only, never a Main Bot or itself, and only with the Bot\'s exact name as confirmation', async () => {
  const rt = deleteRt()
  const first = await deleteBotTool(rt, execOf(), { bot: 'Worker' }, { nodeRole: false })
  assert.match(first, /permanent and removes it from its node too \(n1\)/)
  assert.deepEqual(rt.deleted, [], 'nothing is deleted without the confirmation')
  assert.match(await deleteBotTool(rt, execOf(), { bot: 'Worker', confirm: 'worker' }, { nodeRole: false }), /call delete_bot again with confirm/)
  assert.equal(await deleteBotTool(rt, execOf(), { bot: 'Worker', confirm: 'Worker' }, { nodeRole: false }), 'Deleted Worker, on node n1 too.')
  assert.deepEqual(rt.deleted, ['joined:n1:b1'])
  assert.equal(await deleteBotTool(rt, execOf(), { bot: 'Helper', confirm: 'Helper' }, { nodeRole: false }), 'Deleted Helper.')
  assert.match(await deleteBotTool(rt, execOf(), { bot: 'Chief', confirm: 'Chief' }, { nodeRole: false }), /Main Bot and cannot be deleted/)
  assert.match(await deleteBotTool(rt, execOf(), { bot: 'Nobody', confirm: 'Nobody' }, { nodeRole: false }), /No Bot named Nobody/)
  assert.match(await deleteBotTool(deleteRt({ main: false }), execOf(), { bot: 'Worker', confirm: 'Worker' }, { nodeRole: false }), /Only a Main Bot can delete Bots/)
  assert.match(await deleteBotTool(rt, execOf(), { bot: 'Helper', confirm: 'Helper' }, { nodeRole: true }), new RegExp(NODE_NO_MAIN))
  const peer = deleteRt({ bots: { p: { id: 'p', name: 'Peer', origin: 'peer' } } })
  assert.match(await deleteBotTool(peer, execOf(), { bot: 'Peer', confirm: 'Peer' }, { nodeRole: false }), /read-only/)
})

test('NT-7: a node that does not confirm the delete keeps the Bot, and the reason is said', async () => {
  const rt = deleteRt()
  rt.deleteBot = async () => { throw new Error('Worker was not deleted: the node did not confirm it (node-offline). Delete it again when the node is online') }
  assert.match(await deleteBotTool(rt, execOf(), { bot: 'Worker', confirm: 'Worker' }, { nodeRole: false }), /was not deleted: .*node did not confirm/)
})
