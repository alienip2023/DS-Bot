import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installCapabilities } from '../src/host/capabilities.js'
import { install as installLearning } from '../src/host/learning.js'
import { sharedSkillSnapshot } from '../src/host/skill-share.js'
import { externalFakes } from './ds-w22-memory-nodes.test.js'

const skill = { name: 'release-check', kind: 'skill', description: 'Check a release.', content: 'Run the standard checks.' }

function world(t, { privateBot = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) })
  const home = mkdtempSync(join(tmpdir(), 'ds-w22-learning-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const worker = { id: 'worker', capabilities: [] }
  const rt = {
    // These tests exercise the endpoints only. Background review and mount effects stay idle.
    ctx: { on() {}, effect() {}, systemPrompt: { section() {} } }, config: {}, home,
    state: { bots: { worker }, capabilities: { items: {} } },
    load: async () => {}, loadSecrets: async () => {}, save: async () => {},
    readOnly: () => undefined, isMain: () => false, isPrivate: id => privateBot && id === worker.id,
    botOf: id => id === worker.id ? worker : undefined,
    chatOf: () => undefined, groupSessionsOf: () => [],
    warn: () => assert.fail('unexpected team sharing warning'),
    ...externalFakes(t),
  }
  installCapabilities(rt)
  installLearning(rt)
  return rt
}

test('non-ui-cannot-approve-team-reuse', async t => {
  const rt = world(t)
  await assert.rejects(rt.capabilitySave({ ...skill, teamReusable: true }, { botId: 'worker' }), /Only the user can approve/)
  assert.deepEqual(rt.state.capabilities.items, {})
  await rt.capabilitySave(skill, { botId: 'worker' })
  assert.deepEqual(sharedSkillSnapshot(rt).items, [])
})

test('private-creator-cannot-share-even-with-user-approval', async t => {
  const rt = world(t, { privateBot: true })
  const original = await rt.capabilitySave(skill, { botId: 'worker' })
  await assert.rejects(rt.capabilityEndpoint('capability-save', { ...skill, teamReusable: true }), /A private Bot cannot share/)
  assert.deepEqual(rt.state.capabilities.items[skill.name], original)
  assert.deepEqual(sharedSkillSnapshot(rt).items, [])
})

test('only-unchanged-content-keeps-approval', async t => {
  const rt = world(t)
  const save = body => rt.capabilityEndpoint('capability-save', body)
  const approved = await save({ ...skill, teamReusable: true })
  assert.equal(approved.teamReusable, true)
  assert.equal((await save(skill)).teamReusable, true)
  assert.equal(sharedSkillSnapshot(rt).items[0].id, approved.sharedId)
  const edited = await save({ ...skill, content: 'Run the standard checks before each release.' })
  assert.equal(edited.teamReusable, false)
  assert.deepEqual(sharedSkillSnapshot(rt).items, [])
})

test('learning-proposal-and-local-approval-do-not-publish', async t => {
  const rt = world(t)
  const proposal = { ...skill, id: 'proposal', action: 'create', botId: 'worker', at: 1, teamReusable: true }
  mkdirSync(join(rt.home, 'learning'))
  writeFileSync(join(rt.home, 'learning', 'state.json'), JSON.stringify({ proposals: { proposal } }))
  assert.deepEqual(rt.learningView().worker, [proposal])
  assert.deepEqual(sharedSkillSnapshot(rt).items, [])
  assert.deepEqual(await rt.learningEndpoint('learning-answer', { id: proposal.id, approve: true }), { applied: true })
  assert.deepEqual(rt.state.bots.worker.capabilities, [skill.name])
  assert.equal(rt.state.capabilities.items[skill.name].content, skill.content)
  assert.deepEqual(sharedSkillSnapshot(rt, { forward: true }).items, [])
})
