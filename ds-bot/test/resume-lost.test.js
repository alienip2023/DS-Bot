// fork.126: a resume marked as sent whose message never reached the conversation (DSH refused the write) left its
// work waiting forever. At start it is sent again; one that is in the conversation is not sent twice.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { threadWorld } from './thread-t2-world.js'

const bot = (id, name) => ({ id, sessionId: id, name, role: 'Bot', instructions: '', createdAt: 1 })
async function world(t, { inSession, marked = true, batch = false, partial = false }) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-resume-lost-'))
  const open = batch ? ['r1', 'r2'] : ['r1']
  const results = [{ id: 'r1', name: 'Writer', from: 'writer', text: 'the plan', at: 1, resume: true }]
  if (batch && !partial) results.push({ id: 'r2', name: 'Reviewer', text: 'review failed', outcome: 'failed', at: 2, resume: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, whaleStored: true, mainBotIds: [], revision: 1, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
    bots: { chief: bot('chief', 'Chief'), writer: bot('writer', 'Writer') },
    works: {
      w1: { to: 'chief', origin: 'person', part: 'chief', open, results, ...(marked ? { resume: open } : {}), at: 1 },
      ...(partial ? { r2: { to: 'writer', from: 'chief', parent: 'w1', open: [], results: [], at: 1 } } : {}),
    },
  }))
  const w = threadWorld({ home })
  t.after(async () => { await w.ctx.dispose?.(); rmSync(home, { force: true, recursive: true }) })
  if (inSession) w.agentOf('chief').session.log.push({ type: 'user/message', seq: 1, data: { content: [], source: { kind: 'bot', role: 'results', work: 'w1', results: inSession } } })
  await w.rt.load()
  for (let i = 0; i < 100 && ![...w.followups, ...w.steers].some(d => d.sessionId === 'chief'); i += 1) await new Promise(r => setTimeout(r, 10))
  return w
}

test('a resume that never reached the conversation is sent again at start, once', async t => {
  const w = await world(t, { inSession: false })
  const sent = [...w.followups, ...w.steers].filter(d => d.sessionId === 'chief')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].message.source.role, 'results')
  assert.match(sent[0].message.content[0].text, /Writer:\nthe plan/)
})

test('a resume that is in the conversation is not sent again', async t => {
  const w = await world(t, { inSession: ['r1'] })
  assert.equal([...w.followups, ...w.steers].some(d => d.sessionId === 'chief'), false)
})

test('startup resumes a batch whose last result was saved before the resume marker', async t => {
  const w = await world(t, { batch: true, marked: false })
  const sent = [...w.followups, ...w.steers].filter(d => d.sessionId === 'chief')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].message.source.results, ['r1', 'r2'])
  assert.match(sent[0].message.content[0].text, /Reviewer:\nreview failed/)
})

test('a past batch in the same conversation does not hide a lost current resume', async t => {
  const w = await world(t, { batch: true, inSession: ['previous'] })
  const sent = [...w.followups, ...w.steers].filter(d => d.sessionId === 'chief')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].message.source.results, ['r1', 'r2'])
})

test('the matching batch already in the conversation is not resent if its marker was lost', async t => {
  const w = await world(t, { batch: true, marked: false, inSession: ['r1', 'r2'] })
  assert.equal([...w.followups, ...w.steers].some(d => d.sessionId === 'chief'), false)
  assert.deepEqual(w.rt.state.works.w1.resume, ['r1', 'r2'])
})

test('startup does not wake a parent whose batch still has an outstanding result', async t => {
  const w = await world(t, { batch: true, partial: true, marked: false })
  assert.equal([...w.followups, ...w.steers].some(d => d.sessionId === 'chief'), false)
  assert.equal(w.rt.state.works.w1.results.length, 1)
  assert.equal(w.rt.state.works.w1.open.length, 2)
})
