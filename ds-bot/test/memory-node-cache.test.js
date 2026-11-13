import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SNAPSHOT_TRUNCATED } from '../src/host/memory-entries.js'
import { fakeLink, settle, snapshot, startNode } from './memory-node-ctx.js'

const freshHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-m4node-'))

test('a snapshot is applied, acked, and rendered from the cache', async (t) => {
  const link = fakeLink()
  const { rt, section, stop } = startNode({ link })
  t.after(() => stop())
  await rt.load()

  const result = await rt.memoryNode.apply(snapshot(5, {
    team: '- team prefers pnpm',
    node: '- node runs Node 24',
    bots: { b1: { text: '- one writes short replies' } },
  }))
  assert.deepEqual(result, { applied: true, seq: 5 })
  assert.equal(rt.memoryNode.cached(rt.state.bots.b1).seq, 5)

  const text = section('b1')
  assert.match(text, /^# Your memory/)
  assert.ok(text.includes('- team prefers pnpm'), text)
  assert.ok(text.includes('- node runs Node 24'), text)
  assert.ok(text.includes('- one writes short replies'), text)
  // The three segments are the hub's text, unchanged; the headings are ours.
  assert.ok(text.includes('## Team memory, shared by every Bot\n- team prefers pnpm'))
  assert.ok(text.includes("## Your node's memory (node:n1)\n- node runs Node 24"))
  assert.ok(text.includes('## Your memory (MEMORY.md)\n- one writes short replies'))

  const acks = link.sent.filter(frame => frame.type === 'mem/ack')
  assert.equal(acks.length, 1)
  assert.equal(acks[0].payload.seq, 5)
})

test('an older snapshot never rewinds the cache, while the same seq may refresh it', async (t) => {
  const { rt, section, stop } = startNode({ link: fakeLink() })
  t.after(() => stop())
  await rt.load()

  await rt.memoryNode.apply(snapshot(5, { team: '- five' }))
  assert.deepEqual(await rt.memoryNode.apply(snapshot(4, { team: '- four' })), { applied: false, reason: 'old' })
  assert.equal(rt.memoryNode.cached(rt.state.bots.b1).seq, 5)
  assert.match(section('b1'), /- five/)
  assert.doesNotMatch(section('b1'), /- four/)

  // The hub may push the same seq again after a reconnect: the text is refreshed, the
  // applied seq does not move. A Session that has not rendered yet sees the new text.
  assert.deepEqual(await rt.memoryNode.apply(snapshot(5, { team: '- five again' })), { applied: true, seq: 5 })
  assert.equal(rt.memoryNode.cached(rt.state.bots.b1).seq, 5)
  assert.match(section('b2'), /- five again/)
})

test('a truncated segment keeps the hub marker at its end', async (t) => {
  const { rt, section, stop } = startNode({ link: fakeLink() })
  t.after(() => stop())
  await rt.load()

  await rt.memoryNode.apply(snapshot(3, {
    team: '- team',
    node: '- node',
    bots: { b1: { text: '- a long entry', truncated: true } },
    truncated: true,
  }))
  const text = section('b1')
  assert.ok(text.includes(`- a long entry\n${SNAPSHOT_TRUNCATED}`), text)
  // A section the hub did not cut does not get a marker just because the whole snapshot
  // was truncated.
  assert.ok(text.includes("## Your node's memory (node:n1)\n- node\n"), text)
  assert.equal(text.split(SNAPSHOT_TRUNCATED).length - 1, 1)
})

test('the cache, the outbox and the applied seq survive a restart', async (t) => {
  const home = freshHome()
  const first = startNode({ home, link: fakeLink({ online: false }) })
  await first.rt.load()
  await first.rt.memoryNode.apply(snapshot(9, { team: '- kept over restart' }))
  await first.tool('remember', { text: '- queued while offline' })
  assert.equal(first.rt.memoryNode.status().queued, 1)
  const seq = first.rt.memoryNode.status().seq
  await first.stop({ keep: true })

  const second = startNode({ home, link: fakeLink({ online: false }) })
  t.after(() => second.stop())
  await second.rt.load()
  const status = second.rt.memoryNode.status()
  assert.equal(status.seq, seq)
  assert.equal(status.seq, 9)
  assert.equal(status.queued, 1)
  assert.match(second.section('b1'), /- kept over restart/)
  assert.equal(second.rt.memoryNode.outbox()[0].text, 'queued while offline')
})

test('a federated section is frozen for the Session and refreshed for the next one', async (t) => {
  const { rt, section, stop } = startNode({ link: fakeLink() })
  t.after(() => stop())
  await rt.load()

  await rt.memoryNode.apply(snapshot(1, { bots: { b1: { text: '- first' }, b2: { text: '- first' } } }))
  assert.match(section('b1'), /- first/)
  await rt.memoryNode.apply(snapshot(2, { bots: { b1: { text: '- second' }, b2: { text: '- second' } } }))
  // The same Session keeps the text it was frozen with; a new one sees the newer cache.
  assert.match(section('b1'), /- first/)
  assert.doesNotMatch(section('b1'), /- second/)
  assert.match(section('b2'), /- second/)
})

test('applying a snapshot persists it by itself, so a crash right after keeps it', async (t) => {
  const home = freshHome()
  const first = startNode({ home, link: fakeLink() })
  await first.rt.load()
  await first.rt.memoryNode.apply(snapshot(6, { team: '- survived the crash' }))

  // No further write happens here: the state on disk must already carry the cache.
  // Without its own save, the next queue write would be what persists it, and a
  // process that dies first would come back at the old seq and the old text.
  const disk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(disk.memoryCache.seq, 6)
  assert.match(disk.memoryCache.team, /- survived the crash/)

  await first.stop({ keep: true })
  const second = startNode({ home, link: fakeLink({ online: false }) })
  t.after(() => second.stop())
  await second.rt.load()
  assert.equal(second.rt.memoryNode.status().seq, 6)
  assert.match(second.section('b1'), /- survived the crash/)
})

test('a restarted node tells the hub the applied seq it has on disk', async (t) => {
  const home = freshHome()
  const first = startNode({ home, link: fakeLink() })
  await first.rt.load()
  await first.rt.memoryNode.apply(snapshot(7, { team: '- seven' }))
  await first.stop({ keep: true })

  const link = fakeLink({ online: true })
  const second = startNode({ home, link })
  t.after(() => second.stop())
  await second.rt.load()
  await settle()

  const hello = link.sent.filter(frame => frame.type === 'mem/hello').at(-1)
  assert.equal(hello.payload.appliedSeq, 7)
})
