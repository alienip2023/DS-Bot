import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'

const codex = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const options = (messages) => ({ provider: 'local-codex-cli', model: 'default', sessionId: 's1', messages, signal: AbortSignal.timeout(60_000) })

function makeAdapter({ cwd, records, presetFor, codexArgs }) {
  return new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [],
    findExecutable: path => path,
    spawnEngine: (_kind, route, spec) => new CodexEngine(route, { ...spec, command: process.execPath, args: [codex, ...codexArgs] }, { findExecutable: path => path }),
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    presetFor,
    cwdFor: async () => cwd,
    toolsFor: () => [],
  })
}

async function collect(stream) {
  let finish
  for await (const chunk of stream) {
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return finish
}

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dsb-sandbox-verify-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const records = {}
  const recordPath = name => join(cwd, `${name}.jsonl`)
  const messages = [user('m1', 'hello')]
  return {
    records,
    async turn(name, { resolvedSandbox, presetFor = () => 'workspace-write', history = messages } = {}) {
      const codexArgs = ['--record', recordPath(name)]
      if (resolvedSandbox !== undefined) codexArgs.push('--resolved-sandbox', JSON.stringify(resolvedSandbox))
      const adapter = makeAdapter({ cwd, records, presetFor, codexArgs })
      try {
        return await collect(adapter.stream(options(history)))
      } finally {
        await adapter.dispose()
      }
    },
    methods: name => readFileSync(recordPath(name), 'utf8').trim().split('\n').map(line => JSON.parse(line).method),
  }
}

const missingSandbox = { code: 'bot/sandbox-unverified', message: /did not return its resolved sandbox/ }

test('SANDBOX-MATCH', async (t) => {
  const { turn, methods } = setup(t)
  assert.equal((await turn('start')).kind, 'stop')
  assert.deepEqual(methods('start'), ['thread/start', 'turn/start'])
})

test('SANDBOX-MISSING', async (t) => {
  const { turn, methods } = setup(t)
  await assert.rejects(turn('start', { resolvedSandbox: null }), missingSandbox)
  assert.deepEqual(methods('start'), ['thread/start'])
})

test('SANDBOX-MISMATCH', async (t) => {
  const { turn, methods } = setup(t)
  await assert.rejects(turn('start', { resolvedSandbox: { type: 'dangerFullAccess' } }), {
    code: 'bot/sandbox-unverified',
    message: /did not apply the requested sandbox/,
  })
  assert.deepEqual(methods('start'), ['thread/start'])
})

test('SANDBOX-RESUME', async (t) => {
  const { turn, methods, records } = setup(t)
  const history = [user('m1', 'hello'), user('m2', 'again')]
  assert.equal((await turn('first', { history: history.slice(0, 1) })).kind, 'stop')
  assert.ok(records.s1?.cliSessionId)
  await assert.rejects(turn('second', { resolvedSandbox: null, history }), missingSandbox)
  assert.deepEqual(methods('second'), ['thread/resume'])
})

test('SANDBOX-SKIP', async (t) => {
  const { turn, methods } = setup(t)
  assert.equal((await turn('start', { resolvedSandbox: null, presetFor: () => undefined })).kind, 'stop')
  assert.deepEqual(methods('start'), ['thread/start', 'turn/start'])
})
