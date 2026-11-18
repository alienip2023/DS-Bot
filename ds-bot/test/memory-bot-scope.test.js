import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { clusterBotDirName, install as installMemory, registerBotScopeMount, removeBotScopeMount, safeScopeId, scopeDir, scopeKey } from '../src/host/memory.js'
import { install as installFederation } from '../src/host/memory-federation.js'
import { install as installPrivacy } from '../src/host/privacy.js'
import { applyRosterReport, shadowId } from '../src/host/roster-join.js'
import { fakeContext } from './fake-ctx.js'
import { fakeRegistry } from './memory-hub-ctx.js'

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-cluster-scope-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function seed(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-cluster-scope-'))
  // No background task runs: each fake registry frame is awaited directly.
  for (const name of ['setTimeout', 'setInterval']) t.mock.method(globalThis, name, () => ({ unref() {} }))
  for (const name of ['clearTimeout', 'clearInterval']) t.mock.method(globalThis, name, () => {})
  const registry = fakeRegistry()
  const ctx = fakeContext({ services: { 'remote-agent:registry': registry } })
  const state = { bots: {}, rooms: {}, prefs: {} }
  for (const [nodeId, remoteBotId, clusterBotId] of [['n1', 'rb1', 'shared'], ['n2', 'rb2', 'shared'], ['n3', 'rb3', 'other']]) {
    applyRosterReport(state, { nodeId, bots: [{ id: remoteBotId, name: remoteBotId, clusterBotId }] })
  }
  const rt = {
    ctx, home, state,
    config: { memoryReview: false, memoryTidy: false },
    teamTools: [],
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    isMain: () => false,
    isPrivate: id => state.bots[id]?.private === true,
    readOnly: () => undefined,
    load: async () => {},
    save: async () => {},
    warn: (...args) => assert.fail(`unexpected warning: ${args.join(' ')}`),
  }
  installMemory(rt)
  const accesses = []
  const host = rt.memoryHost
  rt.memoryHost = {
    ...host,
    ...Object.fromEntries(['readScope', 'addEntry', 'replaceEntry', 'removeEntry'].map(name => [name, (...args) => {
      accesses.push(name)
      return host[name](...args)
    }])),
  }
  installFederation(rt)
  await rt.memoryMetaReady
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  let request = 0
  const frame = async (event, type, extra) => {
    const requestId = `scope-${++request}`
    await registry.emitAsync(event, { nodeId: 'n1', remoteBotId: 'rb1', requestId, scope: 'bot', ...extra })
    const answer = registry.frames(type).find(item => item.payload.requestId === requestId)?.payload
    assert.ok(answer, 'the hub answered the frame')
    return answer
  }
  return {
    rt, home, root: join(home, 'memory'), accesses,
    write: extra => frame('memoryWrite', 'mem/write-result', { op: 'add', text: 'cluster fact', ...extra }),
    read: extra => frame('memoryRead', 'mem/read-result', extra),
  }
}

const texts = files => files.flatMap(file => file.entries.map(entry => entry.text))

test('clusterBot has its own key and directory, separate from local and node Bot scopes', (t) => {
  const root = join(tempHome(t), 'memory')
  const scope = { kind: 'clusterBot', clusterBotId: 'shared' }
  const dir = scopeDir(root, scope)
  assert.equal(dir, join(root, 'bots', `cluster.${safeScopeId('shared')}`))
  assert.equal(clusterBotDirName('shared'), 'cluster.shared')
  assert.notEqual(dir, scopeDir(root, { kind: 'bot', botId: 'shared' }))
  assert.notEqual(dir, scopeDir(root, { kind: 'bot', nodeId: 'n1', botId: 'shared' }))
  assert.equal(scopeKey(scope), 'clusterBot:shared')
  assert.equal(scopeKey({ kind: 'bot', botId: 'shared' }), 'bot:shared')
  assert.equal(scopeKey({ kind: 'bot', nodeId: 'n1', botId: 'shared' }), undefined)
})

test('clusterBot path names keep their reserved dot and contain hostile ids safely', (t) => {
  const root = join(tempHome(t), 'memory')
  for (const clusterBotId of ['cluster.foo', '../x']) {
    const dir = scopeDir(root, { kind: 'clusterBot', clusterBotId })
    assert.equal(dirname(dir), join(root, 'bots'))
    assert.equal(basename(dir), `cluster.${safeScopeId(clusterBotId)}`)
    assert.match(basename(dir), /^cluster\.[A-Za-z0-9_-]+$/)
    assert.notEqual(dir, scopeDir(root, { kind: 'bot', botId: clusterBotId }))
    assert.equal(scopeKey({ kind: 'clusterBot', clusterBotId }), `clusterBot:${clusterBotId}`)
  }
})

test('bot memory crosses nodes with the same roster identity while own stays on its node', async (t) => {
  const { rt, root, write, read } = await start(t)
  assert.deepEqual(await write({}), { requestId: 'scope-1', ok: true, seq: 1, changed: true })
  assert.ok(existsSync(join(root, 'bots', 'cluster.shared', 'MEMORY.md')))
  assert.equal(existsSync(join(root, 'nodes')), false)
  assert.deepEqual(readdirSync(join(root, 'bots')), ['cluster.shared'])
  assert.equal((await read({ nodeId: 'n2', remoteBotId: 'rb2' })).entries[0].text, 'cluster fact')
  assert.deepEqual((await read({ nodeId: 'n3', remoteBotId: 'rb3' })).entries, [])

  assert.equal((await write({ scope: 'own', text: 'only the first node' })).ok, true)
  const own = join(root, 'nodes', 'n1', 'bots', 'rb1', 'MEMORY.md')
  assert.match(readFileSync(own, 'utf8'), /only the first node/)
  assert.deepEqual((await read({ nodeId: 'n2', remoteBotId: 'rb2' })).entries.map(entry => entry.text), ['cluster fact'])
  assert.deepEqual((await read({ nodeId: 'n2', remoteBotId: 'rb2', scope: 'own' })).entries, [])
  assert.deepEqual((await read({ scope: 'own' })).entries.map(entry => entry.text), ['only the first node'])
  assert.equal(rt.memoryHub.seq(), 2)
})

test('team writes are refused before any memory file is opened or the sequence moves', async (t) => {
  const { rt, root, write, accesses } = await start(t)
  const path = join(root, 'team', 'MEMORY.md')
  seed(path, '# Memory\n\n- keep the team unchanged\n')
  const before = readFileSync(path)
  const seq = rt.memoryHub.seq()
  for (const op of ['add', 'replace', 'forget']) {
    const answer = await write({ scope: 'team', op, replace: 'keep the team unchanged' })
    assert.equal(answer.error, 'memory/team-read-only')
    assert.equal(answer.ok, false)
    assert.equal(answer.seq, seq)
  }
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(accesses, [], 'a team write must not open memory')
  assert.equal(rt.memoryHub.seq(), seq)
  assert.equal(existsSync(join(root, 'bots')), false)
})

test('a frame cannot override the roster clusterBotId', async (t) => {
  const { root, write, read } = await start(t)
  const answer = await write({ clusterBotId: 'forged' })
  assert.equal(answer.ok, true)
  assert.match(readFileSync(join(root, 'bots', 'cluster.shared', 'MEMORY.md'), 'utf8'), /cluster fact/)
  assert.equal(existsSync(join(root, 'bots', 'cluster.forged')), false)
  assert.equal((await read({ clusterBotId: 'forged' })).entries[0].text, 'cluster fact')
})

test('an explicit read-only mount preserves old bot memory and refuses mounted edits', async (t) => {
  const { rt, root, write, read } = await start(t)
  const legacyBotId = 'old/bot'
  const oldDir = scopeDir(root, { kind: 'bot', botId: legacyBotId })
  const oldPath = join(oldDir, 'MEMORY.md')
  const topicPath = join(oldDir, 'notes.md')
  seed(oldPath, '# Memory\n\n- old bot memory [id: old]\n')
  seed(topicPath, '# notes\n\n- old topic memory [id: topic]\n')
  const before = readFileSync(oldPath)
  const topicBefore = readFileSync(topicPath)
  const once = registerBotScopeMount(root, 'shared', legacyBotId)
  t.after(() => removeBotScopeMount(root, 'shared', legacyBotId))
  assert.deepEqual(registerBotScopeMount(root, 'shared', legacyBotId), once)
  assert.deepEqual(once, [oldDir])

  const entries = (await read({})).entries
  const found = entries.find(entry => entry.text === 'old bot memory')
  assert.ok(found, 'old bot memory disappeared')
  assert.equal(found.mountedFrom, oldDir)
  assert.equal(entries.filter(entry => entry.text === 'old bot memory').length, 1)
  const topic = (await read({ topic: 'notes', query: 'old topic' })).entries[0]
  assert.equal(topic.text, 'old topic memory')
  assert.equal(topic.mountedFrom, oldDir)

  const seq = rt.memoryHub.seq()
  for (const op of ['replace', 'forget']) {
    for (const replace of ['old bot memory', 'topic']) {
      const answer = await write({ op, replace, text: 'must not replace mounted memory' })
      assert.equal(answer.ok, false)
      assert.equal(answer.error, 'memory/refused')
      assert.equal(answer.seq, seq)
    }
  }
  assert.equal(existsSync(join(root, 'bots', 'cluster.shared')), false)
  assert.equal((await write({ text: 'new cluster memory' })).ok, true)
  const combined = (await read({})).entries
  assert.deepEqual(combined.map(entry => entry.text), ['new cluster memory', 'old bot memory', 'old topic memory'])
  assert.equal(combined[0].mountedFrom, undefined)
  assert.equal((await write({ op: 'replace', replace: 'new cluster memory', text: 'updated cluster memory' })).ok, true)
  assert.equal((await write({ op: 'forget', replace: 'updated cluster memory' })).ok, true)
  assert.deepEqual(readFileSync(oldPath), before)
  assert.deepEqual(readFileSync(topicPath), topicBefore)

  assert.equal(removeBotScopeMount(root, 'shared', legacyBotId), true)
  assert.equal(removeBotScopeMount(root, 'shared', legacyBotId), false)
  assert.deepEqual((await read({})).entries, [])
  assert.deepEqual(texts(await rt.memoryHost.readScope({ kind: 'bot', botId: legacyBotId })), ['old bot memory', 'old topic memory'])
  assert.deepEqual(readFileSync(oldPath), before)
  assert.deepEqual(readFileSync(topicPath), topicBefore)
})

test('without registration old memory stays visible locally and absent from cluster reads', async (t) => {
  const { rt, root, write, read } = await start(t)
  const scope = { kind: 'bot', botId: 'shared' }
  const path = join(scopeDir(root, scope), 'MEMORY.md')
  seed(path, '# Memory\n\n- unmounted old memory\n')
  const before = readFileSync(path)
  assert.deepEqual((await read({})).entries, [])
  assert.deepEqual(texts(await rt.memoryHost.readScope(scope)), ['unmounted old memory'])
  assert.equal((await write({})).ok, true)
  assert.deepEqual((await read({})).entries.map(entry => entry.text), ['cluster fact'])
  assert.deepEqual(texts(await rt.memoryHost.readScope(scope)), ['unmounted old memory'])
  assert.deepEqual(readFileSync(path), before)
})

test('private regions close that bot cluster directory and leave its neighbour outside the region', async (t) => {
  const home = tempHome(t)
  const ctx = fakeContext()
  const privateId = 'private-session-123'
  const readerId = 'reader-session-456'
  const bot = { id: privateId, name: 'Diary', private: true, clusterBotId: 'private.cluster' }
  const reader = { id: readerId, name: 'Reader', clusterBotId: 'neighbour' }
  const bots = { [privateId]: bot, [readerId]: reader }
  const inspected = []
  const rt = {
    ctx, home, state: { bots },
    botOf: id => bots[id], selfOf: id => id,
    chatOf: id => id, groupSessionsOf: () => [],
    realBeyond: async path => { inspected.push(path); return path },
    teamFolder: () => join(home, 'workspace'), defaultTeamFolder: () => join(home, 'workspace'),
    workDirOf: () => undefined, sessionFolder: () => home,
  }
  installPrivacy(rt)
  const guard = ctx.listeners.get('tools/execute')[0]
  const run = path => guard({ name: 'read', arguments: { file_path: join(path, 'MEMORY.md') }, agent: { id: readerId } }, async () => 'open')
  const own = join(home, 'memory', 'bots', clusterBotDirName(bot.clusterBotId))
  const neighbour = join(home, 'memory', 'bots', clusterBotDirName(reader.clusterBotId))
  await assert.rejects(run(own), /Diary is a private Bot/)
  assert.ok(inspected.includes(own), 'the private cluster directory is a closed region')
  assert.equal(inspected.includes(neighbour), false, 'a neighbour is not a private region')
  assert.ok(inspected.includes(join(home, 'memory', 'bots', bot.id)), 'the existing local region stays closed')
  assert.equal(await run(neighbour), 'open')
  delete bot.clusterBotId
  inspected.length = 0
  await assert.rejects(run(join(home, 'memory', 'bots', bot.id)), /Diary is a private Bot/)
  assert.equal(inspected.includes(own), false, 'a bot without a clusterBotId gains no cluster region')
})

test('a roster row refuses bot writes without a usable clusterBotId and allows them once present', async (t) => {
  const { rt, root, write, read, accesses } = await start(t)
  const bot = rt.botOf(shadowId('n1', 'rb1'))
  let count = 0
  for (const clusterBotId of [undefined, null, '', '  ', 17, {}]) {
    bot.clusterBotId = clusterBotId
    const text = `refused fact ${++count}`
    const answer = await write({ text, clusterBotId: 'forged' })
    assert.equal(answer.ok, false)
    assert.equal(answer.error, 'memory/refused')
    assert.equal(answer.seq, 0)
    assert.deepEqual(accesses.filter(name => name !== 'readScope'), [], 'a refused write must not reach the memory writer')
    assert.deepEqual((await read({ clusterBotId: 'forged' })).entries, [])
    assert.deepEqual((await read({ scope: 'own' })).entries, [])
    assert.equal(existsSync(join(root, 'nodes', 'n1', 'bots', 'rb1')), false)
  }
  assert.equal(existsSync(join(root, 'nodes', 'n1', 'bots', 'rb1', 'MEMORY.md')), false)
  assert.equal(existsSync(join(root, 'bots')), false)
  assert.equal(rt.memoryHub.seq(), 0)

  bot.clusterBotId = 'shared'
  const answer = await write({ text: 'cluster fact after identity', clusterBotId: 'forged' })
  assert.equal(answer.ok, true)
  assert.equal(answer.changed, true)
  assert.equal(answer.seq, 1)
  assert.match(readFileSync(join(root, 'bots', 'cluster.shared', 'MEMORY.md'), 'utf8'), /cluster fact after identity/)
  assert.equal(existsSync(join(root, 'bots', 'cluster.forged')), false)
  assert.deepEqual((await read({})).entries.map(entry => entry.text), ['cluster fact after identity'])
  assert.deepEqual((await read({ nodeId: 'n2', remoteBotId: 'rb2' })).entries.map(entry => entry.text), ['cluster fact after identity'])
  assert.deepEqual((await read({ scope: 'own' })).entries, [])
  assert.equal(existsSync(join(root, 'nodes', 'n1', 'bots', 'rb1')), false)
  assert.equal(rt.memoryHub.seq(), 1)
})
