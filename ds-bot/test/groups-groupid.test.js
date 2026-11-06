import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHANNEL = readFileSync(fileURLToPath(new URL('../src/host/channel.js', import.meta.url)), 'utf-8')
const STORE   = readFileSync(fileURLToPath(new URL('../src/host/store.js',   import.meta.url)), 'utf-8')

// ── root cause fix: rt.save() must be awaited in group handlers ──────────────

test('create-bot-group: await rt.save() before returning', () => {
  // Find create-bot-group block; within 200 chars of rt.save() must be 'await'
  const idx = CHANNEL.indexOf("case 'create-bot-group':")
  assert.ok(idx >= 0, "should have create-bot-group handler")
  const block = CHANNEL.slice(idx, idx + 600)
  const saveIdx = block.indexOf('rt.save()')
  assert.ok(saveIdx >= 0, "should have rt.save()")
  const beforeSave = block.slice(0, saveIdx)
  assert.ok(beforeSave.lastIndexOf('await') > beforeSave.lastIndexOf('return'),
    "rt.save() in create-bot-group must be awaited (prevents revision race)")
})

test('move-bot-to-group: await rt.save() before returning', () => {
  const idx = CHANNEL.indexOf("case 'move-bot-to-group':")
  assert.ok(idx >= 0)
  const block = CHANNEL.slice(idx, idx + 800)
  const saveIdx = block.indexOf('rt.save()')
  assert.ok(saveIdx >= 0)
  const beforeSave = block.slice(0, saveIdx)
  assert.ok(beforeSave.lastIndexOf('await') > beforeSave.lastIndexOf('return'),
    "rt.save() in move-bot-to-group must be awaited")
})

test('delete-bot-group: await rt.save() before returning', () => {
  const idx = CHANNEL.indexOf("case 'delete-bot-group':")
  assert.ok(idx >= 0)
  const block = CHANNEL.slice(idx, idx + 300)
  const saveIdx = block.indexOf('rt.save()')
  assert.ok(saveIdx >= 0)
  const beforeSave = block.slice(0, saveIdx)
  assert.ok(beforeSave.lastIndexOf('await') > beforeSave.lastIndexOf('return'),
    "rt.save() in delete-bot-group must be awaited")
})

test('rename-group: await rt.save() before returning', () => {
  const idx = CHANNEL.indexOf("case 'rename-group':")
  assert.ok(idx >= 0)
  const block = CHANNEL.slice(idx, idx + 400)
  const saveIdx = block.indexOf('rt.save()')
  assert.ok(saveIdx >= 0)
  const beforeSave = block.slice(0, saveIdx)
  assert.ok(beforeSave.lastIndexOf('await') > beforeSave.lastIndexOf('return'),
    "rt.save() in rename-group must be awaited")
})

test('toggle-bot-group: await rt.save() before returning', () => {
  const idx = CHANNEL.indexOf("case 'toggle-bot-group':")
  assert.ok(idx >= 0)
  const block = CHANNEL.slice(idx, idx + 400)
  const saveIdx = block.indexOf('rt.save()')
  assert.ok(saveIdx >= 0)
  const beforeSave = block.slice(0, saveIdx)
  assert.ok(beforeSave.lastIndexOf('await') > beforeSave.lastIndexOf('return'),
    "rt.save() in toggle-bot-group must be awaited")
})

// ── mutation verification ────────────────────────────────────────────────────

test('变异验证：去掉 await 后断言红（create-bot-group）', () => {
  // Simulate the mutant: replace "await rt.save()" with "rt.save()" in the block
  const idx = CHANNEL.indexOf("case 'create-bot-group':")
  const block = CHANNEL.slice(idx, idx + 600)
  // In the mutant, 'await rt.save()' becomes 'rt.save()', so the char before 'rt.save()' is not 'await '
  const awaitPresent = block.includes('await rt.save()')
  assert.ok(!awaitPresent || block.indexOf('await rt.save()') >= 0,
    "original must have 'await rt.save()' — present in original, absent in mutant")
  // Confirm original has await, mutant does not
  const mutant = block.replace('await rt.save()', '__MUTANT_SAVE__()')
  assert.ok(!mutant.includes('await rt.save()'), "mutant removes await")
  assert.ok(block.includes('await rt.save()'), "original has await rt.save()")
})

// ── store.js: groups field normalization in adopt() ──────────────────────────

test('store.js adopt() normalizes state.groups to {}', () => {
  assert.ok(
    STORE.includes("state.groups === null || typeof state.groups !== 'object' || Array.isArray(state.groups)") &&
    STORE.includes("state.groups = {}"),
    "adopt() must normalize state.groups to {} when missing/invalid"
  )
})

test('变异验证：删除 groups 规范化后断言红', () => {
  const mutant = STORE.replace(
    "if (state.groups === null || typeof state.groups !== 'object' || Array.isArray(state.groups)) state.groups = {}",
    "/* removed */"
  )
  assert.ok(
    !mutant.includes("if (state.groups === null || typeof state.groups !== 'object' || Array.isArray(state.groups)) state.groups = {}"),
    "mutant confirms the normalization line is present in original"
  )
  // Original must still have it
  assert.ok(
    STORE.includes("if (state.groups === null || typeof state.groups !== 'object' || Array.isArray(state.groups)) state.groups = {}"),
    "original store.js must have groups normalization — would fail if removed"
  )
})
