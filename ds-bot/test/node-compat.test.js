// What a node's AC can do is read from the capabilities it advertises. A node without one is never
// silently half-working: ds-bot falls back to what the node can do, refuses clearly, and the Bot list
// says which node needs an update. Unknown capabilities count as able (nothing is held back on a guess).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AC_NEEDED, NODE_FEATURES, compatOf, nodeCan, nodeCapsOf, nodeMissing, refusalFor } from '../src/host/node-compat.js'
import { sendBotAction } from '../src/host/node-cards.js'
import { makeWorld, textRequest } from './joined-world.js'

const rtWith = (caps) => ({ ctx: { get: name => (name === 'remote-agent:registry' ? { send: () => true, on() {}, off() {}, getNode: () => (caps === undefined ? undefined : { hello: { caps } }) } : undefined) } })
const bot = { id: 'joined:n1:b1', origin: 'joined', type: 'remote-worker', worker: { nodeId: 'n1', remoteBotId: 'b1', home: 'remote', online: true } }
const ALL = Object.values(NODE_FEATURES).map(feature => feature.cap)

test('capabilities: known, missing and unknown', () => {
  assert.deepEqual([...nodeCapsOf(rtWith(['a', 'b']), 'n1')], ['a', 'b'])
  assert.equal(nodeCapsOf(rtWith(undefined), 'n1'), undefined)
  assert.equal(nodeCapsOf({ ctx: { get: () => { throw new Error('no registry') } } }, 'n1'), undefined)
  assert.deepEqual(nodeMissing(rtWith(ALL), bot), [])
  assert.deepEqual(nodeMissing(rtWith(['bot-turn-mode/1']), bot), ['actions', 'cards', 'trace', 'attach', 'models', 'lanDiscovery', 'pairing', 'machineIdentity'])
  assert.deepEqual(nodeMissing(rtWith(undefined), bot), [], 'unknown is not a reason to hold anything back')
  assert.equal(nodeCan(rtWith(undefined), bot, 'steer'), true)
  assert.equal(nodeCan(rtWith([]), bot, 'steer'), false)
  assert.equal(nodeCan(rtWith(ALL), bot, 'actions'), true)
})

test('the Bot list says which node needs an update, only for a node that is up and behind', () => {
  assert.deepEqual(compatOf(rtWith(['bot-turn-mode/1']), bot), { nodeCompat: ['actions', 'cards', 'trace', 'attach', 'models', 'lanDiscovery', 'pairing', 'machineIdentity'], acNeeded: AC_NEEDED })
  assert.deepEqual(compatOf(rtWith(ALL.filter(cap => cap !== 'bot-trace/1')), bot), { nodeCompat: ['trace'], acNeeded: AC_NEEDED }, 'a 0.4.20 node: everything but the thinking and tool steps')
  assert.deepEqual(compatOf(rtWith(ALL), bot), {})
  assert.deepEqual(compatOf(rtWith([]), { ...bot, worker: { ...bot.worker, online: false } }), {}, 'an offline node is just offline')
  assert.deepEqual(compatOf(rtWith([]), { id: 'local', name: 'Local' }), {}, 'a local Bot is never behind')
})

test('an action to a node without bot-action is refused at once, with the reason', async () => {
  await assert.rejects(sendBotAction(rtWith([]), bot, 'task-stop', { taskId: 't1' }), error => error.code === 'bot/refused' && error.message.includes(AC_NEEDED) && error.message === refusalFor('actions'))
})

test('a steer to a node without bot-turn-mode waits on the hub as a queue, honestly', async () => {
  const w = makeWorld({ tracker: true })
  w.rt.ctx.get = name => (name === 'remote-agent:registry' ? { send: (...args) => { w.frames.push({ nodeId: args[0], type: args[1], payload: args[2] }); return true }, on: (n, f) => w.emitter.on(n, f), off: (n, f) => w.emitter.off(n, f), getNode: () => ({ hello: { caps: [] } }) } : undefined)
  await w.prompt(textRequest('first', 'req-1'))
  await w.prompt({ ...textRequest('and this', 'req-2'), mode: 'steer' })
  assert.equal(w.frames.length, 1, 'not sent while the first runs: the node would queue it anyway')
  assert.equal(w.rt.joinedUserQueue.get(w.bot.id).length, 1)
})

test('the Bot list says which AC version the node reported and which one is needed', () => {
  const rtVersion = (caps, acVersion) => ({ ctx: { get: name => (name === 'remote-agent:registry' ? { send: () => true, on() {}, off() {}, getNode: () => ({ hello: { caps, ...(acVersion ? { acVersion } : {}) } }) } : undefined) } })
  assert.deepEqual(compatOf(rtVersion(['bot-turn-mode/1'], '0.4.24'), bot), { nodeCompat: ['actions', 'cards', 'trace', 'attach', 'models', 'lanDiscovery', 'pairing', 'machineIdentity'], nodeAcVersion: '0.4.24', acNeeded: AC_NEEDED })
  assert.equal(compatOf(rtVersion(['bot-turn-mode/1']), bot).nodeAcVersion, undefined, 'an older node reports none: unknown, not guessed')
  assert.deepEqual(compatOf(rtVersion(ALL, '0.4.28'), bot), {}, 'a node that has everything is not flagged, whatever it reports')
  assert.equal(AC_NEEDED, '0.4.32')
})
