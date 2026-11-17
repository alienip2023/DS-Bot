import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'

const ROOT = join(import.meta.dirname, '..')
const OLD_NAME = 'dsh-remote-agent'
const WORKER_KEY = 'A Worker Bot runs tasks on a remote machine via AI Unified (dsh-ai-cluster).'

test('i18n.js and locales/*.js never mention the old package name', () => {
  const dir = join(ROOT, 'src/client/locales')
  const files = [join(ROOT, 'src/client/i18n.js'), ...readdirSync(dir).filter(f => f.endsWith('.js')).map(f => join(dir, f))]
  assert.ok(files.length > 2)
  const hits = files.filter(f => readFileSync(f, 'utf8').includes(OLD_NAME))
  assert.deepEqual(hits, [])
})

test('remote-agent:* service names stay frozen in src/host', () => {
  const dir = join(ROOT, 'src/host')
  const source = readdirSync(dir, { recursive: true })
    .filter(f => String(f).endsWith('.js'))
    .map(f => readFileSync(join(dir, String(f)), 'utf8'))
    .join('\n')
  for (const name of ['registry', 'role', 'node-policy', 'config-sync', 'bot-create', 'bot-message']) {
    assert.ok(source.includes(`remote-agent:${name}`), `missing literal remote-agent:${name}`)
  }
})

test('worker-bridge.js keeps exactly one remote-agent:registry lookup (per-file freeze)', () => {
  const src = readFileSync(join(ROOT, 'src/host/worker-bridge.js'), 'utf8')
  const count = src.split("'remote-agent:registry'").length - 1
  assert.equal(count, 1, `worker-bridge.js: expected 1 'remote-agent:registry' literal, found ${count}`)
})

test('the Worker Bot key exists in every locale and carries the new name', () => {
  for (const loc of ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de']) {
    const value = DICTIONARY[loc]?.[WORKER_KEY]
    assert.equal(typeof value, 'string', `${loc}: missing key`)
    assert.ok(value.includes('dsh-ai-cluster'), `${loc}: package name must stay untranslated`)
  }
  assert.equal(DICTIONARY.zh[WORKER_KEY], '执行机通过 AI 集群控制（dsh-ai-cluster）在远程机器上跑任务。')
  assert.ok(DICTIONARY['zh-TW'][WORKER_KEY].includes('AI 集群控制'))
})
