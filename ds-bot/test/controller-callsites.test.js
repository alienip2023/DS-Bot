// s50 / merge plan I4 (R6) — a STRUCTURAL test, by design a source scan (the plan prescribes it; it is not a
// behaviour test and says so): every place the plugin calls ctx.sessionController.<method>( directly, and every
// place it wraps one with wrapControllerMethod. The behaviour of the wraps is covered by controller-restore-real /
// joined-prompt / joined-stop-real; what no behaviour test can see is a NEW call that bypasses the wrap
// (a prompt that skips the joined takeover) or a wrap that silently disappeared in a merge. Upstream v0.3.2 adds
// no call site (measured), so after the merge this table must still hold; a deliberate change updates it here.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function sources(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'client' ? [] : sources(path)
    return name.endsWith('.js') ? [path] : []
  })
}
// Code only: line comments and block comments are not call sites.
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1')

function scan() {
  const direct = {}
  const wraps = {}
  for (const path of [join(ROOT, 'index.js'), ...sources(join(ROOT, 'src'))]) {
    const text = code(readFileSync(path, 'utf8'))
    const file = relative(ROOT, path)
    for (const match of text.matchAll(/sessionController\??\.([A-Za-z]+)\(/g)) (direct[`${file} ${match[1]}`] ??= []).push(match.index)
    for (const match of text.matchAll(/wrapControllerMethod\(\s*[^,]+,\s*[^,]+,\s*'([A-Za-z]+)'/g)) (wraps[`${file} ${match[1]}`] ??= []).push(match.index)
  }
  const count = table => Object.fromEntries(Object.entries(table).map(([key, hits]) => [key, hits.length]).sort(([a], [b]) => a.localeCompare(b)))
  return { direct: count(direct), wraps: count(wraps) }
}

// Measured on fa93fd30 (fork.76): page 4, create 2, selectModel 1, resolveAgent 1, prompt 1, projections 1, list 1 (the wrapped cancel is no direct call).
// P1-T2 adds one direct page read: channel.js serves a non-Main Thread's own Session history.
const DIRECT = {
  'src/host/agents.js create': 1,
  'src/host/channel.js page': 1,
  'src/host/channel.js prompt': 1,
  'src/host/chat-index.js page': 1,
  'src/host/delivery.js resolveAgent': 1,
  'src/host/models.js selectModel': 1,
  'src/host/parts.js page': 2,
  'src/host/roster.js create': 1,
  'src/host/usage.js list': 1,
  'src/host/usage.js page': 1,
  'src/host/usage.js projections': 1,
}
// The takeovers of this fork: the joined page's prompt/cancel/list, and the Bot-turn prompt wrapper.
const WRAPS = {
  'src/host/joined-prompt.js cancel': 1,
  'src/host/joined-prompt.js prompt': 1,
  'src/host/joined-running.js list': 1,
  'src/host/turns.js prompt': 1,
}

test('M-callsites-direct: every direct ctx.sessionController.<method>( call of the plugin is a known one', () => {
  assert.deepEqual(scan().direct, DIRECT)
})

test('M-callsites-wraps: the prompt/cancel/list takeovers are all still installed, once each', () => {
  assert.deepEqual(scan().wraps, WRAPS)
})

test('M-callsites-prompt-covered: a direct prompt( call exists only where a wrapper of the same Session path is installed (channel.js sends Bot turns through the wrapped turns.js path)', () => {
  const { direct, wraps } = scan()
  const prompts = Object.keys(direct).filter(key => key.endsWith(' prompt'))
  assert.deepEqual(prompts, ['src/host/channel.js prompt'])
  assert.ok(Object.keys(wraps).some(key => key.endsWith(' prompt')), 'and a prompt wrap is installed')
})
