import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { applyRosterReport } from '../src/host/roster-join.js'
import { checkWorkDirRoots } from '../src/host/joined-create.js'
import { install as installWorkerBridge, perBotWorkDir } from '../src/host/worker-bridge.js'
import { fakeContext } from './fake-ctx.js'

const drain = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve))
}

test('perBotWorkDir rejects missing, non-string and invalid remote Bot ids', () => {
  assert.equal(perBotWorkDir(), undefined)
  assert.equal(perBotWorkDir({ origin: 'local', worker: { remoteBotId: 'session-abc' } }), undefined)
  assert.equal(perBotWorkDir({ origin: 'joined' }), undefined)
  for (const remoteBotId of [undefined, null, 123, '', '.', '..', '-bot', '_bot']) {
    assert.equal(perBotWorkDir({ origin: 'joined', worker: { remoteBotId } }), undefined)
  }
})

test('perBotWorkDir sanitizes traversal into one valid per-Bot path segment', () => {
  const workDir = perBotWorkDir({ origin: 'joined', worker: { remoteBotId: 'a/../../b' } })
  assert.equal(workDir, 'bots/a-..-..-b')
  assert.equal(workDir.split('/').includes('..'), false)
  assert.equal(checkWorkDirRoots({ ctx: { get: () => undefined } }, workDir), null)
})

test('perBotWorkDir accepts valid ids up to 64 characters', () => {
  for (const remoteBotId of ['session-abc', 'a'.repeat(64)]) {
    assert.equal(perBotWorkDir({ origin: 'joined', worker: { remoteBotId } }), `bots/${remoteBotId}`)
  }
})

test('perBotWorkDir rejects ids longer than 64 characters', () => {
  assert.equal(perBotWorkDir({ origin: 'joined', worker: { remoteBotId: 'a'.repeat(65) } }), undefined)
})

test('roster mirrors leave workDir unset and preserve an existing one', () => {
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

  assert.equal(state.bots['joined:node-a:new-bot'].workDir, undefined)
  assert.equal(state.bots['joined:node-a:existing'].workDir, '/already/configured')
})

for (const { name, origin = 'joined', remoteBotId = 'remote-bot', workDir, expected } of [
  { name: 'derives a joined default', expected: 'bots/remote-bot' },
  { name: 'sanitizes a joined remote Bot id', remoteBotId: 'remote/bot:1', expected: 'bots/remote-bot-1' },
  { name: 'rejects a parent-directory remote Bot id', remoteBotId: '..', expected: undefined },
  { name: 'rejects an overlong remote Bot id', remoteBotId: 'a'.repeat(65), expected: undefined },
  { name: 'preserves an explicit workDir', workDir: 'bots/configured', expected: 'bots/configured' },
  { name: 'leaves a non-joined default unset', origin: 'local', expected: undefined },
  { name: 'leaves a default unset without a remote Bot id', remoteBotId: '', expected: undefined },
]) {
  test(`worker bridge ${name} at dispatch.execute`, async t => {
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
      origin,
      workDir,
      worker: { nodeId: 'node-a', remoteBotId },
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
    assert.equal(dispatched[0].workDir, expected)
    assert.equal(bot.workDir, workDir)

    registry.emit('taskEnd', { taskId: dispatched[0].taskId, nodeId: dispatched[0].nodeId, status: 'COMPLETED' })
    await drain()
    assert.deepEqual(replies, [{ fromId: 'worker', toId: 'sender', text: 'done', role: 'reply', replyTo: 'ex-1' }])
  })
}

test('checkWorkDirRoots accepts a relative per-Bot workDir without local root policy', () => {
  const rt = { ctx: { get: () => undefined } }
  assert.equal(checkWorkDirRoots(rt, 'bots/rb1'), null)
  assert.equal(checkWorkDirRoots(rt, 'bots/remote-bot'), null)
})

for (const workDir of ['../../etc', '../../../root/.ssh']) {
  test(`checkWorkDirRoots denies path traversal: ${workDir}`, () => {
    const rt = { ctx: { get: () => undefined } }
    assert.equal(checkWorkDirRoots(rt, workDir), 'bot-create-workdir-denied')
  })
}

test('checkWorkDirRoots keeps absolute paths subject to the existing root policy', () => {
  const root = resolve('work-root')
  const rt = { ctx: { get: key => key === 'remote-agent:node-policy' ? { roots: [root] } : undefined } }
  assert.equal(checkWorkDirRoots(rt, root), null)
  assert.equal(checkWorkDirRoots(rt, resolve(root, 'bots/remote-bot')), null)
  assert.equal(checkWorkDirRoots(rt, `${root}-outside`), 'bot-create-workdir-denied')
  assert.equal(checkWorkDirRoots({ ctx: { get: () => undefined } }, root), 'bot-create-workdir-denied')
  assert.equal(checkWorkDirRoots({ ctx: { get: () => ({ roots: [] }) } }, root), 'bot-create-workdir-denied')
})

