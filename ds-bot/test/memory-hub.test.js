import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { SNAPSHOT_TRUNCATED } from '../src/host/memory-entries.js'
import { shadowId } from '../src/host/roster-join.js'
import { hub, rosterFor, writeFrame } from './memory-hub-ctx.js'

const lines = (count, chars) => Array.from({ length: count }, () => `- ${'x'.repeat(chars)}`).join('\n') + '\n'
const parseLog = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

test('a node write lands in its own folder, steps the sequence once, and never the team log', async (t) => {
  const { rt, registry, dir, close } = await hub({ roster: [rosterFor('n1', ['rb1'], 'dshtest-1')] })
  t.after(close)

  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'req-1', { text: 'the port is 4387' }))

  const body = readFileSync(dir('nodes', 'n1', 'bots', 'rb1', 'MEMORY.md'), 'utf8')
  assert.match(body, /the port is 4387/)
  assert.equal(rt.memoryHub.seq(), 1)

  const log = parseLog(dir('nodes', 'n1', 'journal.jsonl'))
  assert.equal(log.length, 1)
  assert.equal(log[0].scope, 'joined:n1:rb1')
  assert.equal(log[0].nodeId, 'n1')
  assert.equal(log[0].remoteBotId, 'rb1')
  assert.equal(log[0].op, 'add')
  // The team journal is for this host's own scopes only: a remote row must never
  // land there, or every Bot's recall would read a node's memory as the team's.
  assert.equal(existsSync(dir('journal.jsonl')), false)

  const answer = registry.frames('mem/write-result').at(-1).payload
  assert.equal(answer.requestId, 'req-1')
  assert.deepEqual({ ok: answer.ok, seq: answer.seq, changed: answer.changed }, { ok: true, seq: 1, changed: true })
})

test('a retried request is answered with the first result and written once', async (t) => {
  const { rt, registry, dir, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  const frame = writeFrame('n1', 'rb1', 'req-retry', { text: 'only once' })
  await registry.emitAsync('memoryWrite', frame)
  await registry.emitAsync('memoryWrite', frame)

  const answers = registry.frames('mem/write-result').map(item => item.payload)
  assert.equal(answers.length, 2)
  assert.deepEqual(
    { ok: answers[1].ok, seq: answers[1].seq, changed: answers[1].changed, requestId: answers[1].requestId },
    { ok: answers[0].ok, seq: answers[0].seq, changed: answers[0].changed, requestId: answers[0].requestId },
  )
  assert.equal(rt.memoryHub.seq(), 1)
  const body = readFileSync(dir('nodes', 'n1', 'bots', 'rb1', 'MEMORY.md'), 'utf8')
  assert.equal(body.split('only once').length - 1, 1)
  assert.equal(Object.keys(rt.state.memoryFederation.inbox).length, 1)
})

test('a node that writes the team memory is refused before a file or the sequence is touched', async (t) => {
  const { rt, registry, dir, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'req-team', { scope: 'team', text: 'a node may not push into the team memory' }))

  const answer = registry.frames('mem/write-result').at(-1).payload
  assert.equal(answer.ok, false)
  assert.equal(answer.error, 'memory/team-read-only')
  assert.equal(answer.seq, 0)
  assert.equal(rt.memoryHub.seq(), 0)
  assert.equal(existsSync(dir('team')), false)
  assert.deepEqual(Object.keys(rt.state.memoryFederation.inbox), [])
})

test('a Bot reads the team, its node and its own memory, and nothing of another Bot', async (t) => {
  const { rt, registry, close } = await hub({ roster: [rosterFor('n1', ['rb1', 'rb2']), rosterFor('n2', ['rb9'])] })
  t.after(close)

  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'rb1-own', { text: 'own note rb1' }))
  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb2', 'rb2-own', { text: 'own note rb2' }))
  await registry.emitAsync('memoryWrite', writeFrame('n2', 'rb9', 'rb9-own', { text: 'own note rb9' }))
  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'n1-node', { scope: 'node', text: 'node note n1' }))
  await registry.emitAsync('memoryWrite', writeFrame('n2', 'rb9', 'n2-node', { scope: 'node', text: 'node note n2' }))
  await rt.memoryHubEndpoint('memory-hub-add', { scope: 'team', text: 'team line' })

  const read = async (remoteBotId, extra) => {
    const before = registry.frames('mem/read-result').length
    await registry.emitAsync('memoryRead', { nodeId: extra.nodeId ?? 'n1', remoteBotId, requestId: `read-${before}`, scope: extra.scope, ...(extra.query ? { query: extra.query } : {}) })
    return registry.frames('mem/read-result').at(-1).payload
  }
  const texts = answer => answer.entries.map(entry => entry.text)

  const team = await read('rb1', { scope: 'team' })
  assert.deepEqual(texts(team), ['team line'])

  const node = await read('rb1', { scope: 'node' })
  assert.deepEqual(texts(node), ['node note n1'])

  const own = await read('rb1', { scope: 'own' })
  assert.deepEqual(texts(own), ['own note rb1'])
  assert.equal(texts(own).includes('own note rb2'), false)

  const other = await read('rb9', { scope: 'own', nodeId: 'n2' })
  assert.deepEqual(texts(other), ['own note rb9'])

  const stranger = await read('ghost', { scope: 'own' })
  assert.equal(stranger.ok, false)
  assert.equal(stranger.error, 'memory/not-on-roster')
})

test('a team change is pushed whole to every node, and an ack moves what that node applied', async (t) => {
  const { rt, registry, close } = await hub({ nodes: [{ nodeId: 'n1' }, { nodeId: 'n2' }], roster: [rosterFor('n1', ['rb1']), rosterFor('n2', ['rb2'])] })
  t.after(close)

  const seq = (await rt.memoryHubEndpoint('memory-hub-add', { scope: 'team', text: 'the team line' })).sizes !== undefined ? rt.memoryHub.seq() : undefined
  assert.equal(typeof seq, 'number')

  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const hit = predicate()
      if (hit) return hit
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return undefined
  }
  const pushed = await waitFor(() => {
    const frames = registry.frames('mem/snapshot').filter(item => item.payload.seq === seq)
    return ['n1', 'n2'].every(nodeId => frames.some(item => item.nodeId === nodeId)) ? frames : undefined
  })
  assert.notEqual(pushed, undefined, 'both nodes get the snapshot within the debounce window')
  for (const nodeId of ['n1', 'n2']) {
    const frame = pushed.find(item => item.nodeId === nodeId)
    assert.match(frame.payload.team, /the team line/)
    assert.equal(rt.state.memoryFederation.nodes[nodeId].sentSeq, seq)
  }

  await registry.emitAsync('memoryAck', { nodeId: 'n1', seq })
  assert.equal(rt.state.memoryFederation.nodes.n1.lastSeq, seq)
  assert.equal(rt.state.memoryFederation.nodes.n2.lastSeq, 0)
})

test('an over-budget snapshot keeps team, then node, then Bots, and says it was cut', async (t) => {
  const { rt, registry, dir, close } = await hub({ roster: [rosterFor('n1', ['rb1', 'rb2', 'rb3', 'rb4'])] })
  t.after(close)

  const seed = (path, text) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  seed(dir('team', 'MEMORY.md'), lines(13, 299))
  seed(dir('nodes', 'n1', 'MEMORY.md'), lines(26, 299))
  for (const id of ['rb1', 'rb2', 'rb3', 'rb4']) seed(dir('nodes', 'n1', 'bots', id, 'MEMORY.md'), lines(26, 299))

  await rt.memoryHub.push('n1')
  const snapshot = registry.frames('mem/snapshot').at(-1).payload
  assert.equal(snapshot.truncated, true)
  assert.match(snapshot.team, /^- x/m)
  assert.equal(snapshot.team.includes(SNAPSHOT_TRUNCATED), false)
  const bots = Object.values(snapshot.bots)
  assert.equal(bots.length, 4)
  assert.equal(bots.some(bot => bot.truncated === true), true)
  assert.equal(bots.some(bot => bot.text === SNAPSHOT_TRUNCATED), true)
  const total = snapshot.team.length + snapshot.node.length + bots.reduce((sum, bot) => sum + bot.text.length, 0)
  assert.ok(total <= 32768 + SNAPSHOT_TRUNCATED.length * 4, `snapshot stayed near its budget (${total})`)
})

test('the panel sees a remote scope in the same shape as the local memory panel', async (t) => {
  const { rt, registry, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'view-1', { text: 'a fact for the panel' }))
  const view = await rt.memoryHubEndpoint('memory-hub-view', { scope: { kind: 'bot', nodeId: 'n1', remoteBotId: 'rb1' } })

  assert.equal(view.scope, 'joined:n1:rb1')
  assert.equal(view.kind, 'bot')
  assert.equal(view.remoteBotId, 'rb1')
  assert.equal(view.entries.length, 1)
  assert.deepEqual(Object.keys(view.entries[0]).sort(), ['added', 'by', 'expired', 'id', 'pinned', 'scope', 'source', 'text', 'topic', 'until'])
  assert.equal(view.entries[0].scope, 'own')
  assert.equal(view.entries[0].topic, null)
  assert.equal(view.entries[0].pinned, false)
  assert.equal(typeof view.sizes.own, 'number')
  assert.equal(view.limits.entry, 300)
  assert.equal(view.limits.bot, 8000)
  // A remote scope has no model summary, and asking for one never calls a model.
  assert.equal(view.summary, null)

  const team = await rt.memoryHubEndpoint('memory-hub-view', { scope: 'team' })
  assert.equal(team.kind, 'team')
  assert.equal(team.scope, 'team')
})

test('a replace that matches more than one entry is refused as ambiguous, not guessed', async (t) => {
  const { rt, registry, dir, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'amb-1', { text: 'alpha shared' }))
  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'amb-2', { text: 'beta shared' }))
  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'amb-3', { op: 'replace', replace: 'shared', text: 'gamma' }))

  const answer = registry.frames('mem/write-result').at(-1).payload
  assert.equal(answer.ok, false)
  assert.equal(answer.error, 'memory/ambiguous')
  assert.equal(answer.seq, 2)
  const body = readFileSync(dir('nodes', 'n1', 'bots', 'rb1', 'MEMORY.md'), 'utf8')
  assert.match(body, /alpha shared/)
  assert.match(body, /beta shared/)
  assert.equal(body.includes('gamma'), false)
})

test('a deleted remote Bot keeps its memory in the archive, and the node log says where', async (t) => {
  const { rt, registry, dir, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'req-arch', { text: 'archive me' }))
  const id = shadowId('n1', 'rb1')
  await rt.archiveBotMemory(id)

  assert.equal(existsSync(dir('nodes', 'n1', 'bots', 'rb1')), false)
  const archives = readdirSync(dir('archive'))
  assert.equal(archives.length, 1)
  assert.equal(archives.length, 1)
  assert.match(readFileSync(dir('archive', archives[0], 'MEMORY.md'), 'utf8'), /archive me/)

  const log = parseLog(dir('nodes', 'n1', 'journal.jsonl'))
  const row = log.at(-1)
  assert.equal(row.op, 'archive')
  assert.equal(row.nodeId, 'n1')
  assert.equal(row.remoteBotId, 'rb1')
  assert.match(row.to, /^archive\//)
  assert.equal(existsSync(dir('journal.jsonl')), false)
})
