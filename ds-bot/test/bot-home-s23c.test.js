import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// overlays.js imports react, which a plain node test cannot render, so this one is a
// source assertion by necessity: the dialog must be neither imported, rendered nor shipped.
test('S23c-no-portal: overlays.js and the built client.js no longer reference JoinedChatDialog', () => {
  const overlays = readFileSync(join(root, 'src/client/overlays.js'), 'utf8')
  assert.ok(!overlays.includes('JoinedChatDialog'), 'overlays.js must not import or render JoinedChatDialog')
  assert.ok(!/joinedChat\b/.test(overlays), 'overlays.js must not track ui.joinedChat any more')
  const built = readFileSync(join(root, 'client.js'), 'utf8')
  assert.equal(built.split('JoinedChatDialog').length - 1, 0, 'client.js must contain no JoinedChatDialog')
  assert.ok(existsSync(join(root, 'src/client/joined-chat-dialog.js')), 'joined-chat-dialog.js itself is kept')
})

function runtime(config) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-s23c-'))
  return createRuntime(fakeContext(), { home, ...config })
}

test('S23c-flag-on: createRuntime with features.botHome=true keeps rt.botHomeEnabled true', () => {
  assert.equal(runtime({ features: { botHome: true } }).botHomeEnabled, true)
})

test('S23c-flag-default-on: absent features keeps rt.botHomeEnabled true; only features.botHome:false turns it off', () => {
  assert.equal(runtime({}).botHomeEnabled, true)
  assert.equal(runtime({ features: {} }).botHomeEnabled, true)
  assert.equal(runtime({ features: { botHome: false } }).botHomeEnabled, false)
})
