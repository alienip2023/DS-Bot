import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { hub, rosterFor, writeFrame } from './memory-hub-ctx.js'

const parseLog = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

test('two copies of one request arrive together and still write once', async (t) => {
  const { rt, registry, dir, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  const frame = writeFrame('n1', 'rb1', 'req-same', { text: 'one write under two calls' })
  await Promise.all([registry.emitAsync('memoryWrite', frame), registry.emitAsync('memoryWrite', frame)])

  const answers = registry.frames('mem/write-result').map(item => item.payload)
  assert.equal(answers.length, 2)
  for (const answer of answers) {
    assert.equal(answer.ok, true)
    assert.equal(answer.seq, 1)
    assert.equal(answer.changed, true)
    assert.equal(answer.requestId, 'req-same')
  }
  assert.equal(rt.memoryHub.seq(), 1)
  const body = readFileSync(dir('nodes', 'n1', 'bots', 'rb1', 'MEMORY.md'), 'utf8')
  assert.equal(body.split('one write under two calls').length - 1, 1)
  assert.equal(parseLog(dir('nodes', 'n1', 'journal.jsonl')).length, 1)
})

test('a refused write leaves the sequence and the inbox alone, so the retry runs it', async (t) => {
  const { rt, registry, dir, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'req-long', { text: 'y'.repeat(301) }))
  const refused = registry.frames('mem/write-result').at(-1).payload
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'memory/too-large')
  assert.equal(rt.memoryHub.seq(), 0)
  assert.deepEqual(Object.keys(rt.state.memoryFederation.inbox), [])

  await registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', 'req-long', { text: 'short enough' }))
  const accepted = registry.frames('mem/write-result').at(-1).payload
  assert.equal(accepted.ok, true)
  assert.equal(accepted.seq, 1)
  const body = readFileSync(dir('nodes', 'n1', 'bots', 'rb1', 'MEMORY.md'), 'utf8')
  assert.match(body, /short enough/)
  assert.equal(body.includes('yyyy'), false)
})

test('an inbox answer older than seven days is forgotten when a node says hello', async (t) => {
  const { rt, registry, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  const day = 24 * 60 * 60 * 1000
  rt.state.memoryFederation.inbox = {
    'n1:stale': { at: Date.now() - 8 * day, frame: { requestId: 'stale', ok: true, seq: 1 } },
    'n1:fresh': { at: Date.now() - day, frame: { requestId: 'fresh', ok: true, seq: 1 } },
  }
  await registry.emitAsync('memoryHello', { nodeId: 'n1', appliedSeq: 1 })

  assert.deepEqual(Object.keys(rt.state.memoryFederation.inbox), ['n1:fresh'])
})

test('the inbox keeps a thousand answers, dropping the oldest first', async (t) => {
  const { rt, registry, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  const inbox = {}
  for (let index = 0; index < 1005; index += 1) {
    inbox[`n1:req-${index}`] = { at: Date.now() - 60_000 + index, frame: { requestId: `req-${index}`, ok: true, seq: index } }
  }
  rt.state.memoryFederation.inbox = inbox
  await registry.emitAsync('memoryHello', { nodeId: 'n1', appliedSeq: 0 })

  const left = Object.keys(rt.state.memoryFederation.inbox)
  assert.equal(left.length, 1000)
  assert.equal(left.includes('n1:req-0'), false)
  assert.equal(left.includes('n1:req-4'), false)
  assert.equal(left.includes('n1:req-5'), true)
  assert.equal(left.includes('n1:req-1004'), true)
})

test('five writes from one node queue on the memory writer and leave whole journal lines', async (t) => {
  const { rt, registry, dir, close } = await hub({ roster: [rosterFor('n1', ['rb1'])] })
  t.after(close)

  await Promise.all(Array.from({ length: 5 }, (_, index) => registry.emitAsync('memoryWrite', writeFrame('n1', 'rb1', `req-q-${index}`, { text: `queued fact ${index}` }))))

  const log = parseLog(dir('nodes', 'n1', 'journal.jsonl'))
  assert.equal(log.length, 5)
  assert.equal(new Set(log.map(row => row.id)).size, 5)
  const body = readFileSync(dir('nodes', 'n1', 'bots', 'rb1', 'MEMORY.md'), 'utf8')
  for (let index = 0; index < 5; index += 1) assert.match(body, new RegExp(`queued fact ${index}`))
  assert.equal(rt.memoryHub.seq(), 5)
})

test('the hub writes through the memory module and never opens a file of its own', () => {
  const federation = readFileSync(join(import.meta.dirname, '..', 'src', 'host', 'memory-federation.js'), 'utf8')
  const memory = readFileSync(join(import.meta.dirname, '..', 'src', 'host', 'memory.js'), 'utf8')

  assert.doesNotMatch(federation, /from 'node:fs'/)
  assert.doesNotMatch(federation, /writeFile|appendFile|createWriteStream|renameSync|rename\(/)
  assert.match(federation, /host\.addEntry\(/)
  assert.match(federation, /host\.replaceEntry\(/)
  assert.match(federation, /host\.removeEntry\(/)
  // The single writer (memory.js queued) is what those calls run on.
  assert.match(memory, /memoryHost: Object\.freeze\(\{/)
  assert.match(memory, /const queued = /)
})
