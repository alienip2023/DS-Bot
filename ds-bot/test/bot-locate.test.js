import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { botsRoot } from '../src/host/bots-root.js'
import { AC_NEEDED } from '../src/host/node-compat.js'
import { applyRosterReport, shadowId } from '../src/host/roster-join.js'
import { TEAM_TOOLS } from '../src/host/constants.js'

const ADA_ID = '0123456789abcdef'

test('preload keeps Bot state out of ~/.dsh', () => {
  assert.ok(process.env.DSH_BOTS_DIR, 'harness-resolve.mjs sets DSH_BOTS_DIR')
  assert.equal(botsRoot(), process.env.DSH_BOTS_DIR)
})

test('the separate skill system is gone: skills are capabilities (docs/plans/2026-11-16-team-skills.md)', () => {
  assert.equal(TEAM_TOOLS.includes('create_skill'), false)
  assert.equal(TEAM_TOOLS.includes('list_skills'), false)
  assert.ok(TEAM_TOOLS.includes('save_capability'))
  assert.ok(TEAM_TOOLS.includes('locate_bot'))
})

test('a roster report stores the Bot identity on the joined Bot; a report without one keeps it', () => {
  const state = { bots: {}, rooms: {} }
  applyRosterReport(state, { nodeId: 'n1', hostname: 'h', bots: [{ id: 'ada', name: 'Ada', identityId: ADA_ID }] }, 1)
  const id = shadowId('n1', 'ada')
  assert.equal(state.bots[id].worker.identityId, ADA_ID)
  applyRosterReport(state, { nodeId: 'n1', hostname: 'h', bots: [{ id: 'ada', name: 'Ada' }] }, 2)
  assert.equal(state.bots[id].worker.identityId, ADA_ID)
  applyRosterReport(state, { nodeId: 'n1', hostname: 'h', bots: [{ id: 'ada', name: 'Ada', identityId: 'not-hex!' }] }, 3)
  assert.equal(state.bots[id].worker.identityId, ADA_ID)
})

const joined = (id, name, worker) => ({ id, sessionId: id, name, role: 'Dev', instructions: '', createdAt: 2, type: 'remote-worker', origin: 'joined', worker: { home: 'remote', online: true, ...worker } })
const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    ada: joined('ada', 'Ada', { nodeId: 'n1', remoteBotId: 'ada', identityId: ADA_ID }),
    old: joined('old', 'Oldie', { nodeId: 'n9', remoteBotId: 'old' }),
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function start(t, registry) {
  const before = process.env.DSH_BOTS_DIR
  const ownRoot = mkdtempSync(join(tmpdir(), 'ds-bot-locate-bots-'))
  process.env.DSH_BOTS_DIR = ownRoot
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-locate-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services: registry ? { 'remote-agent:registry': registry } : {} })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  t.after(async () => {
    await ctx.dispose()
    process.env.DSH_BOTS_DIR = before
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(ownRoot, { recursive: true, force: true })
  })
  const call = (name, args, as = 'chief') => rt.teamTools.find(def => def.name === name)
    .execute(args, { agent: { id: as }, callId: 'c', signal: new AbortController().signal })
  return { rt, call }
}

const fakeRegistry = (answer) => {
  const asked = []
  return {
    asked,
    on() {}, off() {}, send: () => true, getNode: () => undefined, onlineNodes: () => [],
    locateBot: async (id) => { asked.push(id); return { botId: id, locations: [], notHere: [], silent: [], unsupported: [], unsent: [], rejected: [], ...answer } },
  }
}

test('locate_bot asks the hub by the Bot identity and reports the proven location', async (t) => {
  const registry = fakeRegistry({ locations: [{ nodeId: 'n1', machineId: 'm1' }], notHere: ['n2'], unsupported: ['n3'] })
  const { call } = await start(t, registry)
  const out = await call('locate_bot', { bot: 'Ada' })
  assert.deepEqual(registry.asked, [ADA_ID])
  assert.match(out, new RegExp(`Ada \\(${ADA_ID}\\) runs on n1 \\(proven by the Bot's own key\\)`))
  assert.match(out, /Not on: n2\./)
  assert.match(out, new RegExp(`Cannot answer \\(AC older than ${AC_NEEDED.replace(/\./g, '\\.')}\\): n3\\.`))
  assert.doesNotMatch(out, /still lists it/)
})

test('locate_bot says when the Bot answered from elsewhere, twice, or with a rejected answer', async (t) => {
  const registry = fakeRegistry({ locations: [{ nodeId: 'n2', machineId: '' }, { nodeId: 'n3', machineId: '' }], silent: ['n4'], rejected: [{ nodeId: 'evil', reason: 'key-does-not-match-bot' }] })
  const { call } = await start(t, registry)
  const out = await call('locate_bot', { bot: 'Ada' })
  assert.match(out, /runs on n2, n3/)
  assert.match(out, /more than one node/)
  assert.match(out, /The team still lists it on n1\./)
  assert.match(out, /No answer in time from: n4\./)
  assert.match(out, /Rejected an answer from evil: key-does-not-match-bot\./)
})

test('locate_bot by raw identity id; not found anywhere', async (t) => {
  const registry = fakeRegistry({})
  const { call } = await start(t, registry)
  assert.match(await call('locate_bot', { bot: 'fedcba9876543210' }), /fedcba9876543210 was not found on any node that answered/)
  assert.deepEqual(registry.asked, ['fedcba9876543210'])
})

test('locate_bot: local Bot, Bot without identity, unknown Bot, old hub AC', async (t) => {
  const { call } = await start(t, { on() {}, off() {}, send: () => true, getNode: () => undefined })
  assert.match(await call('locate_bot', { bot: 'Chief' }), /Chief runs on this machine/)
  assert.match(await call('locate_bot', { bot: 'Oldie' }), /no portable identity yet: its node \(n9\) needs AC/)
  assert.match(await call('locate_bot', { bot: 'Nobody' }), /No Bot named "Nobody"/)
  assert.match(await call('locate_bot', { bot: 'Ada' }), /This hub's AC cannot locate Bots/)
})

test('bot_journal reads the caller\'s journal and flags an unfinished turn', async (t) => {
  const { call } = await start(t)
  assert.match(await call('bot_journal', {}, 'chief'), /Chief has no journal entries yet/)
  const dir = join(botsRoot(), 'chief')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'journal.jsonl'), [
    { seq: 1, type: 'turn/start', exchangeId: 'ex-done-1' },
    { seq: 2, type: 'turn/end', exchangeId: 'ex-done-1' },
    { seq: 3, type: 'turn/start', exchangeId: 'ex-crash-2' },
    { seq: 4, type: 'step/tool', exchangeId: 'ex-crash-2', name: 'shell' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  const out = await call('bot_journal', {}, 'chief')
  assert.match(out, /Chief journal \(last 4 of 4 entries\)/)
  assert.match(out, /Incomplete turns.*ex-crash-2/)
  assert.doesNotMatch(out, /Incomplete turns.*ex-done-1/)
})

test('pair_node lists where machines can join, never the pairing code or token', async (t) => {
  const pairInfo = () => ({
    tokenSet: true,
    codes: [
      { hubUrl: 'ws://192.168.1.5:19387/api/remote-agent/node', usable: true, private: true, pairCode: 'cluster1://SECRET', includesToken: false },
      { hubUrl: 'ws://10.0.0.9:19387/api/remote-agent/node', usable: false, private: true, pairCode: 'cluster1://SECRET2' },
    ],
    listener: { hint: '' },
    firewallHint: 'netsh advfirewall firewall add rule name="dsh-ai-cluster" dir=in action=allow protocol=TCP localport=19387',
  })
  const { call } = await start(t, { on() {}, off() {}, send: () => true, getNode: () => undefined })
  // Service registered after start: the tool looks it up per call.
  const { rt } = await start(t, { on() {}, off() {}, send: () => true, getNode: () => undefined })
  rt.ctx.provide('remote-agent:pair-info', pairInfo)
  const out = await rt.teamTools.find(def => def.name === 'pair_node').execute({}, { agent: { id: 'chief' }, callId: 'c', signal: new AbortController().signal })
  assert.match(out, /✓ ws:\/\/192\.168\.1\.5:19387/)
  assert.match(out, /✗ ws:\/\/10\.0\.0\.9:19387.*not usable now/)
  assert.match(out, /netsh advfirewall/)
  assert.doesNotMatch(out, /SECRET|cluster1:\/\//)
  assert.match(await call('pair_node', {}), /not a hub, or its AC is older/)
})

test('pair_node says when the hub has no node token or no usable address', async (t) => {
  const { rt } = await start(t)
  rt.ctx.provide('remote-agent:pair-info', () => ({ tokenSet: false, codes: [], listener: { hint: '独立监听尚未就绪' } }))
  const out = await rt.teamTools.find(def => def.name === 'pair_node').execute({}, { agent: { id: 'chief' }, callId: 'c', signal: new AbortController().signal })
  assert.match(out, /no node token yet/)
  assert.match(out, /Listener: 独立监听尚未就绪/)
  assert.match(out, /No address is usable/)
})
