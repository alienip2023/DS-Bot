import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { install as installRoster } from '../src/host/roster.js'
import { clusterBotDirName, install as installMemory, removeBotScopeMount } from '../src/host/memory.js'
import { fakeContext } from './fake-ctx.js'

const botRow = (extra = {}) => ({ id: 'b1', name: 'Writer', instructions: '', createdAt: 1, ...extra })
const texts = files => files.flatMap(file => file.entries.map(entry => entry.text))

async function start(t, { bots, seed } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-identity-'))
  const root = join(home, 'memory')
  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  if (bots !== undefined) {
    put(join(home, 'state.json'), JSON.stringify({ version: 2, revision: 1, whaleStored: true, mainBotIds: [], bots }))
  }
  seed?.(root, put)
  const ctx = fakeContext()
  let sessions = 0
  const workspace = { id: 'workspace', path: join(home, 'workspace') }
  Object.assign(ctx, {
    workspaceRegistry: {
      get: () => workspace,
      resolveByPath: async () => workspace,
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `session-${++sessions}` }),
      resolveAgent: async id => ({ agent: ctx.scopeAgent(id) }),
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const state = { bots: {}, rooms: {}, prefs: {}, mainBotIds: [], threads: {}, sections: [], workspaceId: workspace.id }
  let loading
  const rt = {
    ctx, home, state, defaults: {},
    config: { memoryBackend: 'file', memoryReview: false, memoryTidy: false },
    teamTools: [], chatOwners: new Map(), groupOwners: new Map(), pastOwners: new Map(),
    botOf: id => state.bots[id], roomOf: id => state.rooms[id],
    findBot: name => Object.values(state.bots).find(bot => bot.name === name),
    selfOf: id => state.bots[id]?.id, chatOf: id => id, groupSessionsOf: () => [],
    partsOfThread: id => [{ sessionId: id }], clock: () => '00:00',
    isMain: id => state.mainBotIds.includes(id), isPrivate: id => state.bots[id]?.private === true,
    readOnly: () => undefined, catalog: async () => [], defaultBotModel: async () => undefined,
    resolveAgent: async id => ctx.scopeAgent(id),
    teamFolder: () => workspace.path,
    save: async () => put(join(home, 'state.json'), JSON.stringify(state)),
    load: () => loading ??= Promise.resolve().then(() => {
      if (existsSync(join(home, 'state.json'))) Object.assign(state, JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')))
    }),
    warn: (...args) => assert.fail(`unexpected warning: ${args.join(' ')}`),
  }
  installRoster(rt)
  installMemory(rt)
  t.after(async () => {
    await ctx.dispose()
    for (const bot of Object.values(rt.state.bots)) {
      if (bot.clusterBotId) removeBotScopeMount(root, bot.clusterBotId, bot.id)
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  await rt.memoryHost.readScope(rt.memoryHost.TEAM)
  const tool = (name, args, botId = 'b1') => rt.teamTools.find(tool => tool.name === name).execute(args, { agent: { id: botId } })
  return { rt, ctx, home, root, put, tool }
}

test('createBot and both copy paths give each Bot its own stable cluster identity', async (t) => {
  const { rt, home } = await start(t)
  const first = await rt.createBot({ name: 'First', pickModel: true })
  const second = await rt.createBot({ name: 'Second', pickModel: true })
  const duplicate = await rt.duplicateBot(first.id)
  const copy = await rt.createBot({ name: 'Copy', copyOf: first.id, pickModel: true })
  const bots = [first, second, duplicate, copy]
  for (const bot of bots) {
    assert.equal(bot.clusterBotId, bot.id)
    assert.match(bot.clusterBotId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  }
  assert.equal(new Set(bots.map(bot => bot.clusterBotId)).size, bots.length)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  for (const bot of bots) assert.equal(saved.bots[bot.id].clusterBotId, bot.id)
})

test('own memory writes go to the cluster directory without creating a legacy directory', async (t) => {
  const bot = botRow({ clusterBotId: 'identity-1' })
  const { rt, ctx, root, put, tool } = await start(t, { bots: { b1: bot } })
  await tool('bot_remember', { text: 'Keeps the cluster fact', scope: 'own' })
  const clusterDir = join(root, 'bots', clusterBotDirName(bot.clusterBotId))
  const legacyDir = join(root, 'bots', bot.id)
  assert.ok(existsSync(join(clusterDir, 'MEMORY.md')), 'own memory must create the cluster MEMORY.md')
  assert.match(readFileSync(join(clusterDir, 'MEMORY.md'), 'utf8'), /Keeps the cluster fact/)
  assert.equal(existsSync(legacyDir), false)
  assert.deepEqual(rt.memoryHost.ownScope(bot.id), { kind: 'clusterBot', clusterBotId: bot.clusterBotId })
  assert.match(await tool('bot_recall', { scope: 'own', query: 'cluster fact' }), /Keeps the cluster fact/)
  const section = ctx.sections.get('bot-memory')
  assert.match(section.text({ agent: { id: bot.id } }), /Keeps the cluster fact/)

  // A directory created after install must not turn a skipped mount into a phantom.
  put(join(legacyDir, 'MEMORY.md'), '# Memory\n\n- not mounted after install\n')
  assert.deepEqual(texts(await rt.memoryHost.readScope(rt.memoryHost.ownScope(bot.id))), ['Keeps the cluster fact'])
})

test('install mounts existing legacy data read-only and new own writes use the cluster directory', async (t) => {
  const bot = botRow({ clusterBotId: 'identity-legacy' })
  const marker = '# Memory\n\n- legacy marker [id: old]\n'
  const { rt, root, tool } = await start(t, {
    bots: { b1: bot },
    seed: (root, put) => put(join(root, 'bots', bot.id, 'MEMORY.md'), marker),
  })
  const scope = rt.memoryHost.ownScope(bot.id)
  const files = await rt.memoryHost.readScope(scope)
  const mounted = files.find(file => file.entries.some(entry => entry.text === 'legacy marker'))
  assert.ok(mounted, 'the Bot must still read its legacy marker')
  assert.equal(mounted.mountedFrom, join(root, 'bots', bot.id))
  await tool('bot_remember', { text: 'new cluster marker' })
  assert.match(readFileSync(join(root, 'bots', clusterBotDirName(bot.clusterBotId), 'MEMORY.md'), 'utf8'), /new cluster marker/)
  assert.equal(readFileSync(join(root, 'bots', bot.id, 'MEMORY.md'), 'utf8'), marker)
  assert.deepEqual(texts(await rt.memoryHost.readScope(scope)), ['new cluster marker', 'legacy marker'])
})

test('a Bot without clusterBotId still reads and writes its legacy directory', async (t) => {
  const bot = botRow()
  const { rt, root, tool } = await start(t, {
    bots: { b1: bot },
    seed: (root, put) => put(join(root, 'bots', bot.id, 'MEMORY.md'), '# Memory\n\n- old row marker\n'),
  })
  assert.deepEqual(rt.memoryHost.ownScope(bot.id), { kind: 'bot', botId: bot.id })
  assert.match(await tool('bot_recall', { scope: 'own', query: 'old row marker' }), /old row marker/)
  await tool('bot_remember', { text: 'still legacy' })
  assert.match(readFileSync(join(root, 'bots', bot.id, 'MEMORY.md'), 'utf8'), /still legacy/)
  assert.equal(existsSync(join(root, 'bots', clusterBotDirName(bot.id))), false)
})

test('private cluster memory keeps private reads, its own journal, and restorable history', async (t) => {
  const bot = botRow({ clusterBotId: 'private-identity', private: true })
  const { rt, root, tool } = await start(t, { bots: { b1: bot, b2: botRow({ id: 'b2', name: 'Reader', clusterBotId: 'reader' }) } })
  await tool('bot_remember', { text: 'private cluster fact' })
  const dir = join(root, 'bots', clusterBotDirName(bot.clusterBotId))
  assert.match(readFileSync(join(dir, 'journal.jsonl'), 'utf8'), /private cluster fact/)
  assert.equal(existsSync(join(root, 'journal.jsonl')), false)
  assert.match(await tool('bot_recall', { scope: bot.name }, 'b2'), /That Bot is private/)
  await assert.rejects(tool('bot_remember', { scope: bot.name, text: 'forbidden edit' }, 'b2'), /Only that Bot/)
  const { rows } = await rt.memoryEndpoint('memory-history', { botId: bot.id })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].scope, 'own')
  await rt.memoryEndpoint('memory-restore', { botId: bot.id, id: rows[0].id })
  assert.deepEqual(texts(await rt.memoryHost.readScope(rt.memoryHost.ownScope(bot.id))), [])
})

test('archiving a local cluster Bot moves its cluster directory', async (t) => {
  const bot = botRow({ clusterBotId: 'archive-identity' })
  const { rt, root, tool } = await start(t, { bots: { b1: bot } })
  await tool('bot_remember', { text: 'archive cluster fact' })
  const archiving = rt.archiveBotMemory(bot.id)
  delete rt.state.bots[bot.id]
  const archived = await archiving
  assert.ok(archived)
  assert.match(readFileSync(join(archived, 'MEMORY.md'), 'utf8'), /archive cluster fact/)
  assert.equal(existsSync(join(root, 'bots', clusterBotDirName(bot.clusterBotId))), false)
})
