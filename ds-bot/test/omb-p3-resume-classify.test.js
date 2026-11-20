import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { classifyResume, install, mayReplay, resumeTurn } from '../src/host/resume.js'
import { fakeContext } from './fake-ctx.js'

const rejected = { attempted: true, rejected: true, promptSubmitted: false, producedOutput: false }

function runtime() {
  const delivered = []
  const rt = {
    botOf: id => ({ id }),
    selfOf: () => 'a',
    isBotSession: () => true,
    deliver: async args => { delivered.push(args) },
  }
  return { rt, delivered }
}

test('CLASS-AFTER', () => {
  for (const record of [{ ...rejected, producedOutput: true }, { ...rejected, promptSubmitted: true }]) {
    const cls = classifyResume(record)
    assert.equal(cls, 'after-accept')
    assert.equal(mayReplay(cls), false)
  }
})

test('CLASS-BEFORE', () => {
  const cls = classifyResume(rejected)
  assert.equal(cls, 'before-accept')
  assert.equal(mayReplay(cls), true)
})

test('CLASS-UNKNOWN', () => {
  for (const record of [{}, { attempted: true }, { rejected: true }]) {
    const cls = classifyResume(record)
    assert.equal(cls, 'unknown')
    assert.equal(mayReplay(cls), false)
  }
})

test('REPLAY-SKIP', async () => {
  const { rt, delivered } = runtime()
  const cls = await resumeTurn(rt, 'chat-a', { botId: 'a', producedOutput: true })
  assert.equal(delivered.length, 0)
  assert.equal(cls, 'after-accept')
})

test('REPLAY-ONCE', async () => {
  const { rt, delivered } = runtime()
  const record = { botId: 'a', ...rejected }
  assert.equal(await resumeTurn(rt, 'chat-a', record), 'before-accept')
  assert.equal(delivered.length, 1)
  assert.equal(await resumeTurn(rt, 'chat-a', record), 'unknown')
  assert.equal(delivered.length, 1)
})

function installRuntime(t) {
  const { rt, delivered } = runtime()
  const ctx = fakeContext()
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-resume-classify-'))
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  Object.assign(rt, {
    ctx, home,
    readOnly: () => undefined,
    load: async () => {},
    groupOwners: new Map(),
    chatOwners: new Map([['chat-a', 'a']]),
    live: new Map(),
    noteFailure: failure => failure,
  })
  install(rt)
  const emit = type => ctx.listeners.get('session/event')[0]({ id: 'chat-a' }, { type })
  const readRecord = async () => {
    await ctx.dispose()
    return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')).turns['chat-a']
  }
  return { rt, delivered, emit, readRecord }
}

test('INSTALL-BEFORE', async t => {
  const { rt, delivered, emit, readRecord } = installRuntime(t)
  emit('turn/start')
  const failure = { source: 'prompt', sessionId: 'chat-a' }
  assert.equal(rt.noteFailure(failure), failure)
  const record = await readRecord()
  assert.equal(record.attempted, true)
  assert.equal(record.rejected, true)
  assert.equal(classifyResume(record), 'before-accept')
  assert.equal(await resumeTurn(rt, 'chat-a', record), 'before-accept')
  assert.equal(delivered.length, 1)
  assert.equal(await resumeTurn(rt, 'chat-a', record), 'unknown')
  assert.equal(delivered.length, 1)
})

test('INSTALL-AFTER', async t => {
  const { rt, emit, readRecord } = installRuntime(t)
  emit('turn/start')
  emit('tool/call')
  rt.noteFailure({ source: 'prompt', sessionId: 'chat-a' })
  const record = await readRecord()
  assert.equal(record.promptSubmitted, true)
  assert.equal(record.attempted, undefined)
  assert.equal(record.rejected, undefined)
  assert.equal(classifyResume(record), 'after-accept')
})
