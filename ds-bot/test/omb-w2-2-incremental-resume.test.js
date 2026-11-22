import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { resumeTurn } from '../src/host/resume.js'

const provider = 'local-claude-code'
const message = (id, text, role = 'user', source = { kind: 'user' }) => ({
  id, role, source, content: [{ type: 'text', text }],
})
const recordAt = (handedId, handedCliSessionId = 'A', cliSessionId = 'B') => ({
  route: provider, cliSessionId, handedId, handedCliSessionId,
})

function fixture(record, { death, reportedId = 'B' } = {}) {
  let saved = record
  const submitted = []
  const events = []
  const warnings = []
  const session = { cliSessionId: reportedId, next: () => new Promise(() => {}) }
  const send = (input) => {
    submitted.push(input.map(block => block.text).join('\n'))
    if (death === 'after') {
      session.resumeClass = 'after-accept'
      throw new Error('process exited after accepting the prompt')
    }
    events.push({ type: 'done' })
  }
  const adapter = new LocalAgentAdapter({
    rt: { warn: code => warnings.push(code) },
    customAgents: () => [],
    record: () => saved,
    saveRecord: (_, value) => { saved = value },
    presetFor: () => 'workspace-write',
    cwdFor: async () => '.',
    spawnEngine: () => ({
      open: async () => {
        if (death === 'before') throw new Error('process exited before the prompt')
        return session
      },
      prompt: (_, input) => send(input),
      steer: (_, input) => send(input),
    }),
  })
  adapter.ensureMcp = async () => ({})
  // Since 0.3.10 the loop reads through take(); the fake engine's events come from the live's own next().
  adapter.take = live => ({ event: live.next(), drop: () => {} })
  const liveFor = adapter.liveFor.bind(adapter)
  adapter.liveFor = async (...args) => {
    const live = await liveFor(...args)
    live.push = event => { events.push(event) }
    live.next = async () => {
      assert.ok(events.length > 0, 'the fake engine must supply a terminal event')
      return events.shift()
    }
    return live
  }
  return {
    submitted, warnings, live: () => adapter.live.get('s1'), saved: () => saved,
    async run(messages) {
      const chunks = []
      for await (const chunk of adapter.stream({ sessionId: 's1', provider, model: 'default', messages })) chunks.push(chunk)
      return chunks
    },
  }
}

const background = /Read-only conversation background[\s\S]*old action[\s\S]*old result[\s\S]*End of background[\s\S]*new action/
const prior = [message('m0', 'old action'), message('m1', 'old result', 'assistant')]
const next = message('m2', 'new action')

test('handed-session-mismatch-rebuilds', async () => {
  const why = 'handed-session-mismatch-rebuilds: session mismatch must rebuild whole context'
  for (const record of [recordAt('m1'), recordAt('m1', 'A', 'A')]) {
    const f = fixture(record)
    await f.run([...prior, next])
    assert.match(f.submitted[0], background, why)
    assert.equal(f.saved().handedId, 'm2')
    assert.equal(f.saved().handedCliSessionId, 'B')
    await f.run([...prior, next, message('m3', 'incremental')])
    assert.deepEqual(f.submitted.slice(1), ['incremental'])
  }
})

test('handed-missing-anchor-rebuilds', async () => {
  const why = 'handed-missing-anchor-rebuilds: missing anchor must rebuild whole context'
  for (const record of [recordAt('truncated', 'B'), undefined, { handedId: 'm1', cliSessionId: 'B' }]) {
    const f = fixture(record)
    await f.run([...prior, next])
    assert.match(f.submitted[0], background, why)
  }
})

test('handed-rebuild-never-resubmits-accepted-turn', async () => {
  const why = 'handed-rebuild-never-resubmits-accepted-turn: rebuild must not resubmit accepted or unknown turn'
  for (const death of ['before', 'after']) {
    const f = fixture({ ...recordAt('m1', 'B'), handedCliSessionId: undefined }, { death })
    await assert.rejects(f.run([...prior, next]), /outcome of the previous action is unknown/)
    assert.equal(f.live().resumeClass, death === 'before' ? 'unknown' : 'after-accept')
    assert.equal(f.submitted.length, death === 'before' ? 0 : 1)
    const restarted = fixture(f.saved())
    await restarted.run([...prior, next])
    assert.equal(restarted.submitted.length, 0, why)
    await restarted.run([...prior, next, message('m3', 'separate action')])
    assert.doesNotMatch(restarted.submitted[0], /new action/, why)
    assert.match(restarted.submitted[0], /old result[\s\S]*separate action/)
  }
})

test('peer-text-never-deferred', async () => {
  const why = 'peer-text-never-deferred: peer text must not be deferred'
  const f = fixture(recordAt('m1', 'B'))
  await f.run([...prior, next])
  const live = f.live()
  live.state = 'suspended'
  const answers = []
  live.pending.set('question', { name: 'ask', resolve: answer => answers.push(answer) })
  const peer = message('m3', 'peer arrival', 'user', { kind: 'bot', senderSessionId: 'peer' })
  await f.run([...prior, next, peer, message('m4', 'user answer')])
  assert.equal(f.submitted[1], 'peer arrival', why)
  assert.deepEqual(answers, [{ text: 'user answer' }])
})

test('resume-turn-at-most-once', async () => {
  const why = 'resume-turn-at-most-once: resume must run at most once per turn'
  const deliveries = []
  const rt = {
    botOf: id => ({ id }),
    selfOf: () => 'bot',
    isBotSession: () => true,
    deliver: async args => { deliveries.push(args) },
  }
  const record = {
    botId: 'bot',
    trigger: { role: 'request', senderSessionId: 'peer', exchangeId: 'original', text: 'original action' },
    attempted: true,
    rejected: true,
    promptSubmitted: false,
    producedOutput: false,
  }
  const outcomes = await Promise.all([resumeTurn(rt, 's1', record), resumeTurn(rt, 's1', record)])
  assert.equal(deliveries.length, 1, why)
  assert.ok(deliveries[0].resumed)
  assert.doesNotMatch(deliveries[0].text, /original action/)
  assert.deepEqual(outcomes, ['before-accept', 'unknown'])
})
