import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyRosterReport, install as installRoster, shadowId } from '../src/host/roster-join.js'
import { install as installSecrets } from '../src/host/secrets.js'
import { install as installSide } from '../src/host/side.js'
import { install } from '../src/host/store.js'

async function runtime(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 })
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-state-save-'))
  const statePath = join(home, 'state.json')
  const disposers = []
  const registry = new EventEmitter()
  const rt = {
    home, statePath,
    ctx: {
      effect(execute) { disposers.push(execute()) },
      get: name => name === 'remote-agent:registry' ? registry : undefined,
      on: () => () => {},
    },
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    warn() {},
    resolveAgent: async () => ({ session: { seq: 0, log: [] } }),
    joinedChatPage: async () => ({ items: [], cursor: null }),
    teamTools: [],
  }
  let disposing
  const dispose = () => disposing ??= (async () => {
    for (const cleanup of disposers.splice(0).reverse()) await cleanup()
  })()
  t.after(async () => {
    await dispose()
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  install(rt)
  await rt.load()
  const reports = Array.from({ length: 8 }, (_, i) => ({
    nodeId: `node00${i}`, hostname: `worker-${i}`, online: true,
    bots: [{ id: `session-${i}`, name: `Bot ${i}`, role: 'Worker', model: 'mock/model' }],
  }))
  for (const report of reports) {
    const [bot] = applyRosterReport(rt.state, report)
    bot.sessionId = `mirror-${report.nodeId}`
  }
  await rt.save({ required: true })
  installRoster(rt)
  const save = rt.save
  let pending = Promise.resolve()
  rt.save = (...args) => (pending = save(...args))
  const rename = fsp.rename
  let writes = 0
  fsp.rename = async (from, to) => {
    const result = await rename(from, to)
    if (to === statePath) writes++
    return result
  }
  syncBuiltinESMExports()
  t.after(() => { fsp.rename = rename; syncBuiltinESMExports() })
  const drain = () => rt.save({ immediate: false })
  return { rt, registry, reports, dispose, drain, idle: () => pending, writes: () => writes, saved: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) }
}

test('8 staggered nodes reporting every 5 seconds for 30 seconds coalesce to at most 8 writes', async t => {
  const { rt, registry, reports, writes, saved, idle } = await runtime(t)
  const lastSeen = new Map()
  const stringify = JSON.stringify
  let serializations = 0
  t.mock.method(JSON, 'stringify', (...args) => {
    if (args[0] === rt.state) serializations++
    return stringify(...args)
  })
  for (let round = 0; round < 6; round++) {
    for (const report of reports) {
      registry.emit('roster', report)
      lastSeen.set(shadowId(report.nodeId, report.bots[0].id), Date.now())
      rt.state.federation.peersAt = Date.now()
      rt.state.federation.seq++
      t.mock.timers.tick(625)
      await idle()
    }
  }
  const heartbeatSerializations = serializations
  await rt.flush()
  assert.ok(writes() <= 8, `48 heartbeat reports caused ${writes()} writes`)
  assert.equal(writes(), 1)
  assert.equal(heartbeatSerializations, 0, 'heartbeats must not serialize the full team before the window expires')
  for (const [id, at] of lastSeen) assert.equal(saved().bots[id].worker.lastSeen, at)
  assert.equal(saved().federation.peersAt, rt.state.federation.peersAt)
  assert.equal(saved().federation.seq, 48)
  t.diagnostic(`48 heartbeats / 30 simulated seconds: ${writes()} write including final flush`)
})

test('immediate saves persist critical data inside the heartbeat window', async t => {
  const { rt, registry, reports, writes, saved } = await runtime(t)
  t.mock.timers.tick(5_000)
  registry.emit('roster', reports[0])
  rt.state.prefs.marker = 'critical configuration'
  await rt.save({ immediate: true })
  assert.equal(writes(), 1)
  assert.equal(saved().prefs.marker, 'critical configuration')
  assert.equal(saved().bots[shadowId('node000', 'session-0')].worker.lastSeen, Date.now())
  await rt.flush()
  assert.equal(writes(), 1, 'the immediate save also consumes the pending heartbeat')
})

test('flush writes pending state once and a second flush does not write', async t => {
  const { rt, writes, saved } = await runtime(t)
  rt.state.federation.peersAt = Date.now() + 5_000
  await rt.save({ immediate: false })
  assert.equal(writes(), 0)
  await rt.flush()
  assert.equal(writes(), 1)
  assert.equal(saved().federation.peersAt, rt.state.federation.peersAt)
  await rt.flush()
  assert.equal(writes(), 1)
})

test('save without any state change does not write or increment revision', async t => {
  const { rt, writes } = await runtime(t)
  const revision = rt.state.revision
  await rt.save()
  await rt.save({ immediate: false })
  await rt.flush()
  assert.equal(writes(), 0)
  assert.equal(rt.state.revision, revision)
})

test('force notifies saved listeners and advances the persisted revision without a state change', async t => {
  const { rt, writes, saved } = await runtime(t)
  const revision = rt.state.revision
  let notified = 0
  rt.onSaved(() => { notified++ })
  await rt.save({ immediate: false, force: true })
  assert.equal(writes(), 1)
  assert.equal(saved().revision, revision + 1)
  assert.equal(notified, 1)
  await rt.save()
  assert.equal(writes(), 1)
  assert.equal(notified, 1)
})

test('side chat file changes refresh revision even when the saved team is unchanged', async t => {
  const { rt, writes, saved } = await runtime(t)
  installSide(rt)
  const revision = saved().revision
  const botId = shadowId('node000', 'session-0')
  const { chatId } = await rt.sideNew({ sessionId: botId })
  assert.equal(saved().revision, revision + 1)
  assert.equal(rt.sideView()[botId][0].id, chatId)
  assert.equal(JSON.parse(fs.readFileSync(join(rt.home, 'side', `${botId}.json`)))[0].id, chatId)
  await rt.sideClose({ chatId })
  assert.equal(saved().revision, revision + 2)
  assert.equal(writes(), 2)
})

test('separately stored secrets and encryption changes explicitly refresh revision', async t => {
  const { rt, saved } = await runtime(t)
  installSecrets(rt)
  await rt.loadSecrets()
  // Settle lazy request tables before testing changes outside state.json.
  await rt.save()
  const before = saved()
  await rt.secretEndpoint('secret-set', { name: 'TEST_KEY', value: 'test-fixture-value', scope: [] })
  assert.equal(saved().revision, before.revision + 1)
  assert.deepEqual({ ...saved(), revision: before.revision }, before)
  const passphrase = 'state-save-test-passphrase'
  await rt.secretEndpoint('secret-encrypt', { passphrase })
  assert.equal(saved().revision, before.revision + 2)
  await rt.secretEndpoint('secret-unlock', { passphrase })
  assert.equal(saved().revision, before.revision + 3)
  await rt.secretEndpoint('secret-decrypt', { passphrase })
  assert.equal(saved().revision, before.revision + 4)
})

test('the heartbeat window expires after 60 seconds even with continuous reports', async t => {
  const { rt, registry, reports, writes, saved } = await runtime(t)
  for (let second = 0; second < 60; second += 5) {
    for (const report of reports) registry.emit('roster', report)
    t.mock.timers.tick(5_000)
    await Promise.resolve()
  }
  await rt.save({ immediate: false })
  assert.equal(writes(), 1)
  assert.equal(saved().bots[shadowId('node007', 'session-7')].worker.lastSeen, Date.now() - 5_000)
})

test('ordinary saves remain immediate and dispose flushes the latest heartbeat before releasing the lock', async t => {
  const { rt, registry, reports, writes, saved, dispose } = await runtime(t)
  rt.state.prefs.marker = 'ordinary critical save'
  await rt.save()
  assert.equal(writes(), 1)
  t.mock.timers.tick(5_000)
  registry.emit('roster', reports[0])
  Object.defineProperty(rt.ctx, 'workspaceRegistry', { get() { throw new Error('context disposed') } })
  await dispose()
  assert.equal(writes(), 2)
  assert.equal(saved().bots[shadowId('node000', 'session-0')].worker.lastSeen, Date.now())
  assert.equal(fs.existsSync(join(rt.home, 'state.lock')), false)
  t.mock.timers.tick(60_000)
  await rt.flush()
  assert.equal(writes(), 2)
})

test('roster membership and configuration changes save immediately', async t => {
  const { rt, registry, reports, writes, saved, drain } = await runtime(t)
  registry.emit('roster', { ...reports[0], bots: [{ ...reports[0].bots[0], name: 'Renamed' }] })
  await drain()
  assert.equal(writes(), 1)
  assert.equal(saved().bots[shadowId('node000', 'session-0')].name, 'Renamed')
  registry.emit('roster', { nodeId: 'new-node', bots: [{ id: 'new-bot', name: 'New Bot' }] })
  await drain()
  assert.equal(writes(), 2)
  assert.ok(saved().bots[shadowId('new-node', 'new-bot')])
  assert.equal(rt.bySessionId('mirror-node000')?.name, 'Renamed')
  let expected = writes()
  for (const patch of [{ role: 'Reviewer' }, { model: 'mock/other' }]) {
    registry.emit('roster', { ...reports[0], bots: [{ ...reports[0].bots[0], ...patch }] })
    await drain()
    assert.equal(writes(), ++expected)
    for (const [key, value] of Object.entries(patch)) assert.equal(saved().bots[shadowId('node000', 'session-0')][key], value)
  }
  for (const patch of [{ hostname: 'new-host' }, { online: false }, { bots: [] }, {}]) {
    registry.emit('roster', { ...reports[0], ...patch })
    await drain()
    assert.equal(writes(), ++expected)
    assert.equal(saved().bots[shadowId('node000', 'session-0')].worker.missingFromReport, patch.bots?.length === 0)
  }
})

test('a heartbeat arriving during a write is flushed afterwards with no overlapping writes', async t => {
  const { rt, registry, reports, writes, saved } = await runtime(t)
  const writeFile = fsp.writeFile
  let entered
  let unblock
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  let active = 0
  let peak = 0
  let paused = false
  fsp.writeFile = async (path, ...args) => {
    if (path !== `${rt.statePath}.${process.pid}.tmp`) return writeFile(path, ...args)
    peak = Math.max(peak, ++active)
    try {
      if (!paused) { paused = true; entered(); await gate }
      return await writeFile(path, ...args)
    } finally { active-- }
  }
  syncBuiltinESMExports()
  try {
    rt.state.prefs.marker = 'critical'
    const critical = rt.save({ immediate: true })
    await started
    t.mock.timers.tick(5_000)
    registry.emit('roster', reports[0])
    const flushed = rt.flush()
    unblock()
    await Promise.all([critical, flushed])
    assert.equal(peak, 1)
    assert.equal(writes(), 2)
    assert.equal(saved().prefs.marker, 'critical')
    assert.equal(saved().bots[shadowId('node000', 'session-0')].worker.lastSeen, Date.now())
  } finally {
    unblock()
    fsp.writeFile = writeFile
    syncBuiltinESMExports()
  }
})

test('a failed flush keeps the pending state for a successful retry', async t => {
  const { rt, writes, saved } = await runtime(t)
  rt.state.federation.peersAt = Date.now() + 5_000
  await rt.save({ immediate: false })
  const rename = fsp.rename
  fsp.rename = async () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' }) }
  syncBuiltinESMExports()
  try {
    await assert.rejects(rt.flush(), { code: 'ENOSPC' })
    assert.equal(writes(), 0)
  } finally {
    fsp.rename = rename
    syncBuiltinESMExports()
  }
  await rt.flush()
  assert.equal(writes(), 1)
  assert.equal(saved().federation.peersAt, rt.state.federation.peersAt)
  await rt.flush()
  assert.equal(writes(), 1)
})
