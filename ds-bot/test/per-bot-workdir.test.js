import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { applyRosterReport } from '../src/host/roster-join.js'
import { checkWorkDirRoots } from '../src/host/joined-create.js'
import { install as installWorkerBridge } from '../src/host/worker-bridge.js'
import { fakeContext } from './fake-ctx.js'

const drain = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve))
}

test('roster mirrors assign an isolated default workDir and preserve an existing one', () => {
  const state = {
    bots: {
      'joined:node-a:existing': {
        id: 'joined:node-a:existing',
        workDir: '/already/configured',
        origin: 'joined',
        worker: { nodeId: 'node-a', remoteBotId: 'existing', home: 'remote' },
      },
    },
  }

  applyRosterReport(state, {
    nodeId: 'node-a',
    bots: [{ id: 'new-bot', name: 'New' }, { id: 'existing', name: 'Existing' }],
  })

  assert.equal(state.bots['joined:node-a:new-bot'].workDir, 'bots/new-bot')
  assert.equal(state.bots['joined:node-a:existing'].workDir, '/already/configured')
})

test('worker bridge passes a relative workDir unchanged to dispatch.execute', async t => {
  const registry = new EventEmitter()
  const dispatched = []
  const tools = new Map([
    ['remote_task', { execute: async args => { dispatched.push(args); return { value: { accepted: true } } } }],
    ['remote_status', { execute: async () => { throw new Error('should not poll') } }],
    ['remote_handoff', { execute: async () => ({ value: { text: 'done' } }) }],
  ])
  const replies = []
  const bot = {
    id: 'worker',
    name: 'Worker',
    type: 'remote-worker',
    workDir: 'bots/remote-bot',
    worker: { nodeId: 'node-a' },
  }
  const rt = {
    ctx: fakeContext({ services: { tools, 'remote-agent:registry': registry } }),
    botOf: id => id === bot.id ? bot : undefined,
    deliver: async message => { replies.push(message) },
    warn() {},
  }
  installWorkerBridge(rt)
  t.after(() => {
    const task = dispatched[0]
    if (task) registry.emit('taskEnd', { taskId: task.taskId, nodeId: task.nodeId, status: 'COMPLETED' })
  })

  assert.equal(await rt.handleRemoteTurn({ fromId: 'sender', toId: bot.id, text: 'work', exchangeId: 'ex-1' }), 'ex-1')
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].workDir, 'bots/remote-bot')

  registry.emit('taskEnd', { taskId: dispatched[0].taskId, nodeId: dispatched[0].nodeId, status: 'COMPLETED' })
  await drain()
  assert.deepEqual(replies, [{ fromId: 'worker', toId: 'sender', text: 'done', role: 'reply', replyTo: 'ex-1' }])
})

test('checkWorkDirRoots accepts a relative per-Bot workDir without local root policy', () => {
  const rt = { ctx: { get: () => undefined } }
  assert.equal(checkWorkDirRoots(rt, 'bots/remote-bot'), null)
})

test('checkWorkDirRoots keeps absolute paths subject to the existing root policy', () => {
  const root = resolve('work-root')
  const rt = { ctx: { get: key => key === 'remote-agent:node-policy' ? { roots: [root] } : undefined } }
  assert.equal(checkWorkDirRoots(rt, root), null)
  assert.equal(checkWorkDirRoots(rt, resolve(root, 'bots/remote-bot')), null)
  assert.equal(checkWorkDirRoots(rt, `${root}-outside`), 'bot-create-workdir-denied')
  assert.equal(checkWorkDirRoots({ ctx: { get: () => undefined } }, root), 'bot-create-workdir-denied')
  assert.equal(checkWorkDirRoots({ ctx: { get: () => ({ roots: [] }) } }, root), 'bot-create-workdir-denied')
})

