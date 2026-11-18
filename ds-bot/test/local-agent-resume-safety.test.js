import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { classifyResumeFailure, mayReplay } from '../src/host/local-agents/resume-safety.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-claude-resume-safety.mjs', import.meta.url))
const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const request = messages => ({ sessionId: 's1', provider: 'local-claude-code', model: 'default', messages, signal: AbortSignal.timeout(5_000) })
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function setup(t, scenario, stderr = '', saved) {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-resume-safety-'))
  const records = saved ?? { s1: { route: 'local-claude-code', cliSessionId: 'stale-session', handedId: 'm0', cwd: dir } }
  const adapters = []
  const children = []
  const sessions = []
  let opened = 0
  const host = () => {
    const adapter = new LocalAgentAdapter({
      rt: { warn() {} },
      customAgents: () => [],
      findExecutable: path => path,
      record: id => records[id],
      saveRecord: (id, record) => { records[id] = record },
      presetFor: () => 'workspace-write',
      cwdFor: async () => dir,
      probeCwd: () => dir,
      toolsFor: () => [],
      spawnEngine: (kind, route, spec) => {
        assert.equal(kind, 'claude')
        const engine = new ClaudeEngine(route, { ...spec, command: process.execPath, args: [fixture, dir, scenario, stderr] }, { findExecutable: path => path })
        const open = engine.open.bind(engine)
        engine.open = async (id, args) => {
          opened += 1
          // A repeated explicit refusal tests the retry guard defensively. The
          // harness supplies the second stale id; production drops the first.
          if (scenario === 'twice') args = { ...args, resumeId: 'stale-again' }
          if (scenario === 'spawn-error' && opened === 1) engine.engine.command = join(dir, 'missing-cli')
          const session = await open(id, args)
          children.push(session.child)
          sessions.push(session)
          if (((scenario === 'before' || scenario === 'unknown') && opened === 1) || (scenario === 'twice' && opened <= 2)) {
            // Deterministically observe protocol/exit before the adapter writes.
            // No production wait or timing heuristic is involved.
            const event = await session.next()
            session.emit(event)
          }
          return session
        }
        return engine
      },
    })
    adapters.push(adapter)
    return adapter
  }
  t.after(async () => {
    for (const adapter of adapters) await adapter.dispose()
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))))
    rmSync(dir, { recursive: true, force: true })
  })
  const events = () => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const spawns = () => events().filter(event => event.type === 'spawn')
  const inputs = () => events().filter(event => event.type === 'stdin')
  return { host, records, spawns, inputs, sessions }
}

for (let mask = 0; mask < 16; mask += 1) {
  const state = Object.fromEntries(['attempted', 'rejected', 'promptSubmitted', 'producedOutput'].map((key, bit) => [key, Boolean(mask & (1 << bit))]))
  test(`resume classification: ${JSON.stringify(state)}`, () => {
    const expected = state.promptSubmitted || state.producedOutput ? 'after-accept' : state.attempted && state.rejected ? 'before-accept' : 'unknown'
    assert.equal(classifyResumeFailure(state), expected)
    assert.equal(mayReplay(expected), expected === 'before-accept')
  })
}

test('resume-before-accept-resubmits-once: explicit refusal before stdin succeeds', async t => {
  const { host, spawns, inputs } = setup(t, 'before')
  const adapter = host()
  const out = await collect(adapter.stream(request([user('m0', 'earlier context'), user('m1', 'new action')])))
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.equal(spawns().length, 2)
  assert.equal(spawns()[0].argv[spawns()[0].argv.indexOf('--resume') + 1], 'stale-session')
  assert.equal(spawns()[1].argv.includes('--resume'), false)
  assert.equal(inputs().some(event => event.run === 1), false)
  assert.match(JSON.stringify(inputs()), /new action/)
  assert.ok(spawns().every(event => event.runtime === process.execPath))
})

test('resume-after-accept-never-replays: stdin written then exit before init', async t => {
  const { host, spawns, inputs, records } = setup(t, 'after')
  const adapter = host()
  await assert.rejects(collect(adapter.stream(request([user('m0', 'earlier context'), user('m1', 'unresolved-action')]))), /outcome.*unknown.*tool results may not be carried over/i)
  assert.equal(adapter.live.get('s1').resumeClass, 'after-accept')
  assert.equal(spawns().length, 1)
  assert.match(JSON.stringify(inputs()), /unresolved-action/)
  assert.equal(records.s1.cliSessionId, undefined)
  assert.equal(records.s1.handedId, 'm0')
})

test('resume-decision-ignores-stderr-text: identical protocol has identical classification', async t => {
  for (const scenario of ['before', 'protocol-after', 'unknown']) {
    const classifications = []
    for (const stderr of ['No conversation found', 'an unrelated diagnostic']) {
      const { host, spawns, sessions } = setup(t, scenario, stderr)
      const adapter = host()
      const stream = collect(adapter.stream(request([user('m1', 'action')])))
      if (scenario === 'before') {
        await stream
        assert.equal(spawns().length, 2)
        classifications.push(sessions[0].resumeClass)
      } else {
        await assert.rejects(stream, /outcome.*unknown/i)
        classifications.push(adapter.live.get('s1').resumeClass)
        assert.equal(spawns().length, 1)
      }
    }
    assert.deepEqual(classifications, scenario === 'before' ? ['before-accept', 'before-accept'] : scenario === 'unknown' ? ['unknown', 'unknown'] : ['after-accept', 'after-accept'])
  }
})

test('resume-unknown-fails-closed: no protocol evidence never resubmits', async t => {
  const { host, spawns, inputs, records } = setup(t, 'unknown')
  const adapter = host()
  await assert.rejects(collect(adapter.stream(request([user('m0', 'earlier context'), user('m1', 'unresolved-action')]))), /outcome.*unknown/i)
  assert.equal(adapter.live.get('s1').resumeClass, 'unknown')
  assert.equal(spawns().length, 1)
  assert.equal(inputs().length, 0)
  assert.equal(records.s1.cliSessionId, undefined)
  assert.equal(records.s1.handedId, 'm0')
})

test('resume-replays-at-most-once: second explicit refusal fails without third spawn', async t => {
  const { host, spawns, inputs } = setup(t, 'twice')
  await assert.rejects(collect(host().stream(request([user('m1', 'action')]))), error => error.code === 'LOCAL_AGENT_EXIT')
  assert.equal(spawns().length, 2)
  assert.equal(inputs().length, 0)
})

for (const scenario of ['unknown', 'after']) test(`resume-context-rebuild-never-resubmits: ${scenario} restart excludes unresolved prompt and its approval`, async t => {
  const { host, spawns, inputs, records } = setup(t, scenario)
  const history = [user('m0', 'earlier context'), user('m1', 'unresolved-action')]
  const first = host()
  await assert.rejects(collect(first.stream(request(history))), /outcome.*unknown/i)
  await first.dispose()
  assert.deepEqual(records.s1.unresolvedMessageIds, ['m1'])
  const restarted = host()
  await collect(restarted.stream(request([...history,
    { id: 'old-approval', role: 'tool', toolCallId: 'old-call', content: [{ type: 'text', text: 'old-approval-result' }] },
    user('m2', 'new-action'),
  ])))
  assert.equal(spawns().length, 2)
  assert.equal(spawns()[1].argv.includes('--resume'), false)
  const rebuilt = JSON.stringify(inputs().filter(event => event.run === 2))
  assert.match(rebuilt, /earlier context/)
  assert.match(rebuilt, /new-action/)
  assert.doesNotMatch(rebuilt, /unresolved-action|old-approval-result/)
})

test('resume-manual-retry-is-new-action: new turn asks again without the previous approval', async t => {
  const { host, spawns, inputs, records } = setup(t, 'permission')
  const adapter = host()
  const history = [user('m0', 'earlier context'), user('m1', 'unresolved-action')]
  const first = await collect(adapter.stream(request(history)))
  const oldCall = first.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call').block
  assert.equal(oldCall.id, 'approval-1-1')
  const oldSession = adapter.live.get('s1').engineSession
  // A real exit is observed before the manual action, while the old card waits.
  const exited = new Promise(resolve => oldSession.child.once('exit', resolve))
  oldSession.kill()
  await exited
  const second = await collect(adapter.stream(request([...history,
    { id: 'old-card', role: 'assistant', content: [{ type: 'tool-call', id: oldCall.id, name: 'approve_agent_action', arguments: {} }] },
    user('m2', 'manual-new-action'),
    { id: 'old-allow', role: 'tool', toolCallId: oldCall.id, content: [{ type: 'text', text: '{"decision":"allow"}' }] },
  ])))
  const newCall = second.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call').block
  assert.equal(newCall.id, 'approval-2-1')
  assert.notEqual(adapter.live.get('s1').engineSession, oldSession)
  assert.deepEqual([...adapter.live.get('s1').pending.keys()], [newCall.id])
  assert.equal(spawns().length, 2)
  assert.equal(spawns()[1].argv.includes('--resume'), false)
  const secondInput = inputs().filter(event => event.run === 2)
  assert.equal(secondInput.length, 1)
  assert.equal(secondInput[0].message.type, 'user')
  assert.match(JSON.stringify(secondInput), /manual-new-action/)
  assert.doesNotMatch(JSON.stringify(secondInput), /unresolved-action|approval-1-1|decision|control_response/)
  assert.deepEqual(records.s1.unresolvedCallIds, [oldCall.id])
})

test('resume-start-failure-fails-closed: an open error persists the unresolved exclusion', async t => {
  const { host, records, inputs } = setup(t, 'spawn-error')
  const history = [user('m0', 'earlier context'), user('m1', 'unresolved-action')]
  await assert.rejects(collect(host().stream(request(history))), /outcome.*unknown/i)
  assert.equal(records.s1.cliSessionId, undefined)
  assert.equal(records.s1.handedId, 'm0')
  assert.deepEqual(records.s1.unresolvedMessageIds, ['m1'])
  await collect(host().stream(request([...history, user('m2', 'manual-new-action')])))
  assert.match(JSON.stringify(inputs()), /earlier context/)
  assert.match(JSON.stringify(inputs()), /manual-new-action/)
  assert.doesNotMatch(JSON.stringify(inputs()), /unresolved-action/)
})
