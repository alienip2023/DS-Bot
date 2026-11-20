import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import timers from 'node:timers'
import vm from 'node:vm'
import { applySharedSkills, sharedSkillSnapshot } from '../src/host/skill-share.js'

const skill = (i, fields = {}) => ({
  kind: 'skill', teamReusable: true, name: `fixture-${i}`, description: 'A fixture instruction', content: 'Check the result.',
  sharedId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ...fields,
})
const exportable = (items, isPrivate = () => false) => ({
  state: { capabilities: { items: Object.fromEntries(items.map(item => [item.name, item])) } }, isPrivate,
})

test('snapshot-filters-local-path-and-conversation-text', () => {
  const rt = exportable([
    skill(1, { teamReusable: false }),
    skill(2, { content: 'Read /fixture-only/checks.txt.' }),
    skill(3, { content: 'Step one.\nUser: this was a private chat.' }),
    skill(4),
  ])
  assert.deepEqual(sharedSkillSnapshot(rt).items.map(item => item.name), ['fixture-4'])
})

test('secret-rejected', async () => {
  const secretText = 'Use $DSH_SECRET_FIXTURE for the check.'
  const rt = exportable([skill(1, { content: secretText }), skill(2)])
  const snapshot = sharedSkillSnapshot(rt)
  assert.deepEqual(snapshot.items.map(item => item.name), ['fixture-2'], 'secret text must be rejected')
  assert.equal(await applySharedSkills({ ...exportable([]), state: { bots: {}, capabilities: { items: {} } } }, 'node:fixture', {
    ...snapshot, items: [{ ...snapshot.items[0], content: secretText }],
  }), false, 'secret text must be rejected')
})

test('snapshot-obeys-count-and-utf8-wire-budgets', () => {
  const small = Array.from({ length: 65 }, (_, i) => skill(i + 1))
  const count = sharedSkillSnapshot(exportable(small))
  assert.deepEqual(count.items.map(item => item.name), small.slice(0, 64).map(item => item.name))
  const large = Array.from({ length: 8 }, (_, i) => skill(i + 1, { content: '测'.repeat(4_000) }))
  const snapshot = sharedSkillSnapshot(exportable(large))
  const next = sharedSkillSnapshot(exportable(large.slice(snapshot.items.length))).items[0]
  assert.deepEqual(snapshot.items.map(item => item.name), large.slice(0, 5).map(item => item.name))
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 64 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify({ ...snapshot, items: [...snapshot.items, next] })) > 64 * 1024)
})

test('delivery-saves-text-without-invoking-any-executor', async t => {
  const content = 'globalThis.fixtureDeliveryRan = true;'
  const snapshot = sharedSkillSnapshot(exportable([skill(1, { content })]))
  let saves = 0
  const rt = { state: { bots: {}, capabilities: { items: {} } }, save: async () => { saves++ } }
  const spies = []
  function block(target, name) {
    spies.push(t.mock.method(target, name, () => { throw new Error('Unexpected invocation during skill delivery') }))
  }
  for (const name of Object.keys(childProcess)) {
    if (typeof childProcess[name] === 'function' && name !== 'ChildProcess') block(childProcess, name)
  }
  for (const name of ['compileFunction', 'runInContext', 'runInNewContext', 'runInThisContext', 'Script']) block(vm, name)
  for (const name of ['Function', 'eval']) block(globalThis, name)
  for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
    block(globalThis, name)
    block(timers, name)
  }
  syncBuiltinESMExports()
  let applied
  try {
    applied = await applySharedSkills(rt, 'hub:fixture', snapshot)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(applied, true)
  assert.equal(saves, 1)
  assert.equal(globalThis.fixtureDeliveryRan, undefined)
  const [received] = Object.values(rt.state.capabilities.items)
  assert.equal(received.content, content)
  assert.equal(received.sharedFrom, 'hub:fixture')
  assert.equal(spies.reduce((count, spy) => count + spy.mock.callCount(), 0), 0)
})

test('inactive-apply-noop', async () => {
  const rt = exportable([])
  rt.load = () => assert.fail('inactive apply must not load')
  const snapshot = sharedSkillSnapshot(exportable([skill(1)]))
  assert.equal(await applySharedSkills(rt, 'node:fixture', snapshot, { isActive: () => false }), false, 'inactive apply must not write')
  assert.deepEqual(rt.state.capabilities.items, {})
})

test('failed-save-rolls-back', async () => {
  const previous = skill(1, { sharedFrom: 'node:fixture' })
  const rt = exportable([previous, { kind: 'pack', name: 'pack', items: [previous.name] }])
  rt.state.bots = { worker: { id: 'worker', capabilities: [previous.name] } }
  const before = structuredClone(rt.state)
  const warnings = []
  rt.warn = (...args) => warnings.push(args)
  rt.markPeerRosterDirty = () => assert.fail('a failed save must not publish')
  let saves = 0
  rt.save = async () => { saves++; throw new Error('fixture save unavailable') }
  const incoming = sharedSkillSnapshot(exportable([skill(2)]))
  await assert.rejects(applySharedSkills(rt, 'node:fixture', incoming), { message: 'fixture save unavailable' })
  assert.deepEqual(rt.state, before, 'failed save must restore capabilities')
  assert.equal(saves, 1)
  assert.deepEqual(warnings, [])
  rt.save = async () => { saves++ }
  delete rt.markPeerRosterDirty
  assert.equal(await applySharedSkills(rt, 'node:fixture', incoming), true)
  assert.equal(rt.state.capabilities.items[previous.name], undefined)
  assert.deepEqual(rt.state.bots.worker.capabilities, [])
  assert.deepEqual(rt.state.capabilities.items.pack.items, [])
  assert.equal(saves, 2)
})
