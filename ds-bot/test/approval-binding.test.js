import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, approvalFingerprint } from '../src/host/approvals.js'
import { pickAllowOption, presetAnswer, isDenyWord } from '../src/host/local-agents/adapter.js'
import { resolveSandbox, CodexEngine } from '../src/host/local-agents/codex.js'

// A minimal rt: one handler registry, one owned session.
function harness({ noteApproval } = {}) {
  const handlers = []
  const warnings = []
  const rt = {
    ctx: { on: (_name, handler) => handlers.push(handler) },
    groupOwners: new Map(), chatOwners: new Map([['sess', 'bot1']]),
    warn: (...args) => warnings.push(args),
    ...(noteApproval ? { noteApproval } : {}),
  }
  install(rt)
  const ask = (extra = {}) => handlers[0]({ agent: { session: { id: 'sess' } }, toolName: 'shell', callId: 'c1', reason: 'r', signal: new AbortController().signal, ...extra }, () => new Promise(() => {}))
  return { rt, ask, warnings }
}
const code = name => error => error.code === name
const bind = ({ sessionId, fingerprint }) => ({ sessionId, fingerprint })

test('the open entry carries a fingerprint over session, tool, callId and time', () => {
  const { rt, ask } = harness()
  ask()
  const [entry] = rt.approvalsView()
  assert.equal(entry.fingerprint, approvalFingerprint('sess', 'shell', 'c1', entry.at))
  assert.notEqual(entry.fingerprint, approvalFingerprint('sess', 'shell', 'c2', entry.at))
})

test('a matching binding answers either choice', async () => {
  const a = harness(); const pa = a.ask(); const [ea] = a.rt.approvalsView()
  a.rt.answerApproval(ea.id, 'allow', bind(ea))
  assert.equal(await pa, 'allowed-once')
  const b = harness(); const pb = b.ask(); const [eb] = b.rt.approvalsView()
  b.rt.answerApproval(eb.id, 'reject', bind(eb))
  assert.equal(await pb, 'rejected')
})

test('a foreign caller session cannot answer an open approval', async () => {
  const { rt, ask } = harness()
  const request = ask()
  const [entry] = rt.approvalsView()
  const binding = bind(entry)
  assert.throws(
    () => rt.answerApproval(entry.id, 'allow', binding, 'other'),
    { code: 'bot/forbidden' },
    'a foreign session must be forbidden even with the current card binding',
  )
  assert.equal(rt.approvalsView()[0]?.answerable, true)
  rt.answerApproval(entry.id, 'reject', binding)
  assert.equal(await request, 'rejected')
})

test('a binding mismatch or a missing binding field is bot/stale and leaves the request open', () => {
  const { rt, ask } = harness()
  ask()
  const [entry] = rt.approvalsView()
  for (const binding of [
    { sessionId: 'other', fingerprint: entry.fingerprint },
    { sessionId: entry.sessionId, fingerprint: 'deadbeef' },
    { sessionId: entry.sessionId },
    { fingerprint: entry.fingerprint },
    {},
  ]) {
    assert.throws(() => rt.answerApproval(entry.id, 'allow', binding), code('bot/stale'))
  }
  assert.equal(rt.approvalsView().length, 1)
})

test('a settled, unknown or missing id is bot/stale, with or without binding', async () => {
  const { rt, ask } = harness()
  const promise = ask()
  const [entry] = rt.approvalsView()
  rt.answerApproval(entry.id, 'reject', bind(entry))
  assert.equal(await promise, 'rejected')
  assert.throws(() => rt.answerApproval(entry.id, 'allow'), code('bot/stale'))
  assert.throws(() => rt.answerApproval(entry.id, 'allow', { sessionId: entry.sessionId, fingerprint: entry.fingerprint }), code('bot/stale'))
  assert.throws(() => rt.answerApproval('nope', 'allow'), code('bot/stale'))
  assert.throws(() => rt.answerApproval(undefined, 'allow'), code('bot/stale'))
})

test('answerApproval accepts only allow|reject; other text is bot/invalid and not answered', () => {
  const { rt, ask } = harness()
  ask()
  const [entry] = rt.approvalsView()
  for (const choice of ['allowed', 'yes', '同意', 'approved', 'ALLOW', undefined, { decision: 'allow' }]) {
    assert.throws(() => rt.answerApproval(entry.id, choice, bind(entry)), code('bot/invalid'))
  }
  assert.equal(rt.approvalsView().length, 1)
})

test('an audit write that throws on open denies and never opens an answerable entry', async () => {
  const { rt, ask, warnings } = harness({ noteApproval: () => { throw new Error('disk full') } })
  assert.equal(await ask(), 'cancelled')
  assert.equal(rt.approvalsView().length, 0)
  assert.equal(warnings.length, 1)
})

test('an audit clear that throws turns an allow into a denial', async () => {
  let calls = 0
  const { rt, ask } = harness({ noteApproval: (_s, value) => { calls += 1; if (value === undefined) throw new Error('unreadable') } })
  const promise = ask()
  const [entry] = rt.approvalsView()
  rt.answerApproval(entry.id, 'allow', bind(entry))
  assert.equal(await promise, 'cancelled')
  assert.equal(calls, 2)
})

const options = [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }]
const result = (text, isError = false) => ({ text, isError })

test('only the structured decision allow selects the allow option', () => {
  assert.equal(pickAllowOption(options, result('{"decision":"allow"}')), 'a')
})

test('text, other decisions and the non-answers never allow', () => {
  for (const text of ['allow', 'yes, allow it', '同意', 'approved', 'Allow once', '{"decision":"approved"}', '{"decision":"ALLOW"}', '{"allow":true}', '"allow"', '',
    'unavailable', 'cancelled', 'expired', '"expired"', '{"decision":"unavailable"}', '{"decision":"cancelled"}', '{"decision":"expired"}',
    '{"decision":"allow","status":"expired"}', '{"decision":"allow","outcome":"cancelled"}', 'not json {']) {
    assert.equal(pickAllowOption(options, result(text)), null, text)
  }
  assert.equal(pickAllowOption(options, result('{"decision":"allow"}', true)), null)
  assert.equal(pickAllowOption(options, undefined), null)
  assert.equal(pickAllowOption([], result('{"decision":"allow"}')), null)
  assert.ok(isDenyWord('Expired') && !isDenyWord('allow'))
})

test('presetAnswer: read-only refuses a change and everything else asks', () => {
  const event = changes => ({ options, changes })
  assert.equal(presetAnswer('danger-full-access', event(false)), undefined)
  assert.equal(presetAnswer('read-only', event(true)), 'r')
  assert.equal(presetAnswer('read-only', { options: [], changes: true }), null)
  for (const [preset, changes] of [['read-only', false], ['workspace-write', true], ['workspace-write', false], [undefined, true], ['unknown', true], ['', false]]) {
    assert.equal(presetAnswer(preset, event(changes)), undefined, `${preset}/${changes}`)
  }
})

test('codex sandbox: the three known modes resolve to themselves, anything else is bot/invalid', () => {
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) assert.equal(resolveSandbox(mode), mode)
  assert.equal(resolveSandbox(undefined), undefined)
  for (const mode of ['full-access', 'DANGER-FULL-ACCESS', ' read-only', 'bypassPermissions', 'none', 1, {}, ['read-only']]) {
    assert.throws(() => resolveSandbox(mode), code('bot/invalid'), String(mode))
  }
})

test('codex open() with an unknown mode throws before the process is ensured or a thread is requested', async () => {
  const engine = Object.create(CodexEngine.prototype)
  let reached = false
  engine.ensure = async () => { reached = true; return { request: async () => { reached = true } } }
  await assert.rejects(engine.open('s1', { cwd: '/tmp', mode: 'full-access' }), code('bot/invalid'))
  assert.equal(reached, false)
})

// Sink check: the request's promise is the approval sink. A denied answer must leave it unsettled.
test('stale, mismatched, incomplete and invalid answers never settle the request', async () => {
  const { rt, ask } = harness()
  let settled
  ask().then(value => { settled = value })
  const [entry] = rt.approvalsView()
  const attempts = [
    () => rt.answerApproval(entry.id, 'allow', { sessionId: 'other', fingerprint: entry.fingerprint }),
    () => rt.answerApproval(entry.id, 'allow', { sessionId: entry.sessionId, fingerprint: 'x' }),
    () => rt.answerApproval(entry.id, 'allow', { sessionId: entry.sessionId }),
    () => rt.answerApproval(entry.id, 'allow', {}),
    () => rt.answerApproval(entry.id, '同意', bind(entry)),
    () => rt.answerApproval('missing-id', 'allow'),
  ]
  for (const attempt of attempts) assert.throws(attempt)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, undefined)
  assert.equal(rt.approvalsView().length, 1)
})

test('presetAnswer asks (undefined) for full access and other presets that do not refuse, so no auto-allow reaches the engine reply sink', () => {
  const replies = []
  const event = { options, changes: true, reply: value => replies.push(value) }
  for (const preset of ['danger-full-access', 'workspace-write', undefined, null, 'x']) {
    const answer = presetAnswer(preset, event)
    if (answer !== undefined) event.reply(answer)
  }
  assert.deepEqual(replies, [])
})
