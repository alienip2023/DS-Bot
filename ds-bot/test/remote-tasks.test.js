import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { REMOTE_TASK_STATUS, recordRemoteTask, settleRemoteTask, mergeRemoteTasks, listRemoteTasks, formatRemoteTask, humanizeElapsed, install } from '../src/host/remote-tasks.js'
import { install as installWorkerBridge } from '../src/host/worker-bridge.js'
import { fakeContext } from './fake-ctx.js'

const drain = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)) }
const task = (taskId, startedAt = 1000, extra = {}) => ({ taskId, exchangeId: `ex-${taskId}`, nodeId: 'node003', fromId: 'chief', toId: 'worker', goal: 'openapi_v3.py', startedAt, status: 'running', summary: '', ...extra })

function worker(t, { dispatch, handoff = async () => ({ value: { text: 'one\ntwo\nthree\n' } }) } = {}) {
  const registry = new EventEmitter()
  const sent = []
  const replies = []
  const tools = new Map([
    ['remote_task', { execute: async args => { sent.push(args); return dispatch ? dispatch(args, registry) : { value: { accepted: true } } } }],
    ['remote_status', { execute: async () => { throw new Error('must use events') } }],
    ['remote_handoff', { execute: handoff }],
  ])
  const bot = { id: 'worker', name: 'Worker', type: 'remote-worker', worker: { nodeId: 'node003' } }
  const rt = { ctx: fakeContext({ services: { tools, 'remote-agent:registry': registry } }), botOf: () => bot, deliver: async msg => replies.push(msg), warn() {} }
  install(rt)
  installWorkerBridge(rt)
  t.after(async () => { await rt.ctx.dispose(); await drain(); assert.equal(registry.listenerCount('taskEnd'), 0) })
  const send = (text = 'openapi_v3.py') => rt.handleRemoteTurn({ fromId: 'chief', toId: 'worker', text, exchangeId: 'exchange-1' })
  const finish = (status = 'COMPLETED', extra = {}) => registry.emit('taskEnd', { taskId: sent[0].taskId, nodeId: 'node003', status, ...extra })
  return { rt, registry, sent, replies, send, finish }
}

test('dispatch records a running task before sending and completion keeps one record with result lines', async t => {
  const w = worker(t, { dispatch(args) {
    assert.equal(w.rt.remoteTasks.get(args.taskId).status, 'running')
    return { value: { accepted: true } }
  } })
  const prompt = `openapi_v3.py\n\t${'x'.repeat(150)}`
  assert.equal(await w.send(prompt), 'exchange-1')
  const [running] = await w.rt.listRemoteTasks()
  assert.deepEqual(running, {
    ...task(w.sent[0].taskId, running.startedAt), exchangeId: 'exchange-1', goal: `openapi_v3.py ${'x'.repeat(150)}`.slice(0, 120),
  })
  assert.ok(running.startedAt > 0)
  assert.equal(running.goal.length, 120)
  assert.doesNotMatch(running.goal, /[\r\n\t]/)
  w.finish()
  await drain()
  const [completed] = await w.rt.listRemoteTasks()
  assert.equal(w.rt.remoteTasks.size, 1)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.summary, 'one\ntwo\nthree\n')
  assert.match(formatRemoteTask(completed), /状态: 已完成 · 结果: 3 行$/)
  assert.equal(w.replies.length, 1)
})

test('a task ending during dispatch is settled without losing its result', async t => {
  const w = worker(t, { dispatch(args, registry) {
    registry.emit('taskEnd', { taskId: args.taskId, status: 'COMPLETED', summary: { text: 'fast\nresult' } })
    return { value: { accepted: true } }
  } })
  await w.send()
  await drain()
  const [row] = await w.rt.listRemoteTasks()
  assert.equal(row.status, 'completed')
  assert.equal(row.summary, 'fast\nresult')
})

test('completion retains the summary from a hub handoff card', async t => {
  const w = worker(t, { handoff: async () => ({ value: { handoff: { summary: { text: 'card\nsummary' } } } }) })
  await w.send()
  w.finish()
  await drain()
  const [row] = await w.rt.listRemoteTasks()
  assert.equal(row.status, 'completed')
  assert.equal(row.summary, 'card\nsummary')
  assert.match(formatRemoteTask(row), /结果: 2 行$/)
})

for (const status of ['FAILED', 'ABORTED', 'INTERRUPTED', 'REJECTED', 'timeout', 'running', 'queued', 'unknown']) {
  test(`remote terminal status ${status} never invents success`, async t => {
    const w = worker(t)
    await w.send()
    w.finish(status)
    await drain()
    assert.equal((await w.rt.listRemoteTasks())[0].status, 'failed')
  })
}

for (const reject of [false, true]) {
  test(`dispatch ${reject ? 'throw' : 'error result'} records failure and removes its wait`, async t => {
    const w = worker(t, { dispatch() {
      if (reject) throw new Error('node offline')
      return { isError: true, value: 'node offline' }
    } })
    await w.send()
    const [row] = await w.rt.listRemoteTasks()
    assert.equal(row.status, 'failed')
    assert.match(row.summary, /node offline/)
    assert.equal(w.registry.listenerCount('taskEnd'), 0)
  })
}

test('handoff rejection records failure through reportError', async t => {
  const w = worker(t, { handoff: async () => { throw new Error('handoff unavailable') } })
  await w.send()
  w.finish()
  await drain()
  const [row] = await w.rt.listRemoteTasks()
  assert.equal(row.status, 'failed')
  assert.equal(row.summary, 'handoff unavailable')
})

test('timeout records failure instead of completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = worker(t)
  await w.send()
  t.mock.timers.tick(60 * 60 * 1000)
  await drain()
  const [row] = await w.rt.listRemoteTasks()
  assert.equal(row.status, 'failed')
  assert.match(row.summary, /timed out/)
})

test('unloading the bridge fails an unfinished wait', async t => {
  const w = worker(t)
  await w.send()
  await w.rt.ctx.dispose()
  await drain()
  assert.equal((await w.rt.listRemoteTasks())[0].status, 'failed')
})

test('merge dedupes, keeps local identity, uses hub status and summary, and sorts newest first', () => {
  const local = [task('shared', 2000, { summary: 'local', nodeOnline: true }), task('local-only', 1000)]
  const hub = [
    { taskId: 'shared', nodeId: 'node003', status: 'COMPLETED', summary: { text: 'hub\nresult' }, nodeOnline: false, goal: '', startedAt: 0, exchangeId: 'wrong' },
    { taskId: 'hub-only', nodeId: 'node004', status: 'queued', goal: 'hub task', startedAt: 0, createdAt: 3000, summaryText: 'hub-only result', nodeOnline: true },
  ]
  const rows = mergeRemoteTasks(local, hub)
  assert.deepEqual(rows.map(row => row.taskId), ['hub-only', 'shared', 'local-only'])
  assert.equal(rows[1].status, 'completed')
  assert.equal(rows[1].summary, 'hub\nresult')
  assert.equal(rows[1].nodeOnline, false)
  assert.equal(rows[1].exchangeId, 'ex-shared')
  assert.equal(rows[1].goal, 'openapi_v3.py')
  assert.equal(rows[1].startedAt, 2000)
  assert.equal(rows[0].summary, 'hub-only result')
  assert.equal(local[0].status, 'running', 'reading must not rewrite the local ledger')
})

test('list does not re-project rows that already have a string status', async t => {
  const projected = task('projected', 1000, { status: 'completed', summaryText: 'projected result' })
  delete projected.summary
  const service = {
    listTasks() { return [projected] },
    taskView() { throw new Error('already projected') },
  }
  const project = t.mock.method(service, 'taskView')
  const [row] = await listRemoteTasks({ ctx: { get: () => service } })
  assert.equal(project.mock.callCount(), 0)
  assert.equal(row.taskId, projected.taskId)
  assert.equal(row.status, 'completed')
  assert.equal(row.summary, 'projected result')
})

test('list projects a raw record once with its receiver and tolerates an offline node', async t => {
  const raw = { taskId: 'shared' }
  const service = {
    listTasks() { assert.equal(this, service); return [raw] },
    getTask(id) { return id === raw.taskId ? raw : undefined },
    taskView(row) {
      assert.equal(this, service)
      assert.equal(row, raw)
      return { taskId: row.taskId, nodeId: 'node003', status: 'RUNNING', nodeOnline: false, summaryText: 'progress' }
    },
  }
  const project = t.mock.method(service, 'taskView')
  const rt = { ctx: { get: key => { assert.equal(key, 'remote-agent:tasks'); return service } }, remoteTasks: new Map([['shared', task('shared')]]) }
  const [row] = await listRemoteTasks(rt)
  assert.equal(project.mock.callCount(), 1)
  assert.equal(row.exchangeId, 'ex-shared')
  assert.equal(row.summary, 'progress')
  assert.match(formatRemoteTask(row, 13000), /节点离线$/)
})

const brokenServices = [
  ['missing service', () => undefined],
  ['ctx.get throwing', () => { throw new Error('service not injected') }],
  ['junk service', () => 'junk'],
  ['junk list', () => ({ listTasks: () => ({ tasks: [] }) })],
  ['null list', () => ({ listTasks: () => null })],
  ['list rejection', () => ({ listTasks: async () => { throw new Error('unavailable') } })],
  ['junk rows', () => ({ listTasks: () => [null, 42, {}, { taskId: 'x' }, { taskId: 'x', nodeId: 'n', status: 'junk' }] })],
  ['junk projection', () => ({ listTasks: () => [{ taskId: 'shared' }], taskView: () => null })],
  ['projection throw', () => ({ listTasks: () => [{ taskId: 'shared' }], taskView: () => { throw new Error('bad row') } })],
]
for (const [name, get] of brokenServices) {
  test(`${name} falls back to local rows without throwing`, async () => {
    const local = task('shared')
    const rt = { ctx: { get }, remoteTasks: new Map([[local.taskId, local]]) }
    assert.deepEqual(await listRemoteTasks(rt), [local])
  })
}

test('one bad projection does not hide other hub-only tasks', async () => {
  const rt = { ctx: { get: () => ({
    listTasks: async () => [null, { taskId: 'hub' }],
    taskView: async row => { if (!row) throw new Error('bad row'); return task(row.taskId) },
  }) } }
  assert.deepEqual((await listRemoteTasks(rt)).map(row => row.taskId), ['hub'])
})

test('elapsed time is humanized in seconds, minutes, and hours', () => {
  assert.equal(humanizeElapsed(12000), '12 秒')
  assert.equal(humanizeElapsed(4 * 60_000), '4 分钟')
  assert.equal(humanizeElapsed(125 * 60_000), '2 小时 5 分钟')
  assert.equal(humanizeElapsed(120 * 60_000), '2 小时')
  assert.equal(humanizeElapsed(-1000), '0 秒')
})

test('formatting uses Chinese statuses and exact running, completed and offline lines', () => {
  assert.deepEqual(REMOTE_TASK_STATUS, { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败' })
  const running = task('format', 1000, { summary: '1\n2\n3\n4\n5\n6\n7' })
  assert.equal(formatRemoteTask(running, 241000), 'node003 · openapi_v3.py · 已跑 4 分钟 · 状态: 运行中 · 结果: 7 行')
  assert.equal(formatRemoteTask({ ...running, status: 'completed', endedAt: 13000, summary: 'one\r\ntwo\r\n' }, 999000), 'node003 · openapi_v3.py · 已跑 12 秒 · 状态: 已完成 · 结果: 2 行')
  assert.equal(formatRemoteTask({ ...running, nodeOnline: false, summary: '' }, 241000), 'node003 · openapi_v3.py · 已跑 4 分钟 · 状态: 运行中 · 节点离线')
})

test('settling a missing task does not invent a record', () => {
  const rt = {}
  assert.equal(settleRemoteTask(rt, 'missing', { status: 'completed', summary: 'no task' }), undefined)
  assert.equal(rt.remoteTasks, undefined)
})

test('recording keeps the newest 200 settled tasks and every running task', () => {
  const rt = {}
  const record = taskId => recordRemoteTask(rt, { ...task(taskId), prompt: taskId })
  record('running-oldest')
  record('running-older')
  for (let i = 1; i <= 205; i += 1) {
    record(`settled-${i}`)
    settleRemoteTask(rt, `settled-${i}`, { status: i % 2 ? 'completed' : 'failed', summary: '' })
  }
  record('running-newest')
  const rows = [...rt.remoteTasks.values()]
  assert.equal(rt.remoteTasks.size, 203)
  assert.deepEqual(rows.filter(row => row.status === 'running').map(row => row.taskId), ['running-oldest', 'running-older', 'running-newest'])
  assert.deepEqual(rows.filter(row => row.status !== 'running').map(row => row.taskId), Array.from({ length: 200 }, (_, i) => `settled-${i + 6}`))
})

test('list_remote_tasks uses the normal tool shape, formats rows, and defaults to a limit of 20', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 })
  await import('./harness-resolve.mjs')
  const { install: installTools } = await import('../src/host/tools.js')
  const rt = { ctx: fakeContext(), state: {}, teamTools: [] }
  install(rt)
  installTools(rt)
  t.after(() => rt.ctx.dispose())
  const tool = rt.teamTools.find(def => def.name === 'list_remote_tasks')
  assert.ok(tool)
  assert.equal(tool.parameters.properties.limit.type, 'integer')
  assert.equal(tool.parameters.required?.includes('limit') ?? false, false)
  assert.equal(await tool.execute({}), 'No remote tasks.')
  for (let i = 1; i <= 25; i += 1) {
    recordRemoteTask(rt, { ...task(`task-${i}`, Date.now() - i * 1000), prompt: `goal-${i}` })
  }
  const rows = await rt.listRemoteTasks()
  const result = await tool.execute({})
  assert.equal(result.split('\n').length, 20)
  assert.equal(result, rows.slice(0, 20).map(row => formatRemoteTask(row)).join('\n'))
  assert.equal(await tool.execute({ limit: 2 }), rows.slice(0, 2).map(row => formatRemoteTask(row)).join('\n'))
  assert.equal((await tool.execute({ limit: 30 })).split('\n').length, 25)
})

test('the runtime module order wires the ledger and the real store never serializes it', async t => {
  await import('./harness-resolve.mjs')
  const { MODULES } = await import('../index.js')
  const remoteTasks = await import('../src/host/remote-tasks.js')
  const workerBridge = await import('../src/host/worker-bridge.js')
  const store = await import('../src/host/store.js')
  assert.ok(MODULES.indexOf(remoteTasks) >= 0)
  assert.ok(MODULES.indexOf(remoteTasks) < MODULES.indexOf(workerBridge))
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-tasks-'))
  const ctx = fakeContext()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const rt = { ctx, home, statePath: join(home, 'state.json'), warn() {} }
  store.install(rt)
  install(rt)
  assert.ok(rt.remoteTasks instanceof Map)
  recordRemoteTask(rt, { ...task('runtime'), prompt: 'in memory only' })
  assert.equal((await rt.listRemoteTasks())[0].taskId, 'runtime')
  await rt.save()
  const state = readFileSync(join(home, 'state.json'), 'utf8')
  assert.equal(Object.hasOwn(rt.state, 'remoteTasks'), false)
  assert.doesNotMatch(state, /remoteTasks|in memory only/)
  const next = { ctx: fakeContext() }
  install(next)
  assert.deepEqual(await next.listRemoteTasks(), [])
})
