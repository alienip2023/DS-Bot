import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { installLocale, t } from '../src/client/i18n.js'

test('peer group headings follow the Chinese and English locales', () => {
  let active = 'zh'
  const dicts = new Map()
  const off = installLocale({
    register: (ns, lang, dict) => {
      if (!dicts.has(ns)) dicts.set(ns, new Map())
      const map = dicts.get(ns)
      map.set(lang, dict)
      return () => map.delete(lang)
    },
    bind: ns => key => dicts.get(ns)?.get(active)?.[key] ?? key,
    getLocale: () => ({ active }),
  })
  try {
    assert.equal(t('This machine'), '本机')
    assert.equal(t('Other machines'), '其他机器')
    active = 'en'
    assert.equal(t('This machine'), 'This machine')
    assert.equal(t('Other machines'), 'Other machines')
  } finally {
    off()
  }
})

test('sidebar peer group headings use translation keys', () => {
  const source = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  // The headings must be translated at render time, not hardcoded in Chinese.
  assert.doesNotMatch(source, /['"](?:本机|其他机器)['"]/)
  assert.ok(source.includes("t('This machine')"))
  assert.ok(source.includes("t('Other machines')"))
})
