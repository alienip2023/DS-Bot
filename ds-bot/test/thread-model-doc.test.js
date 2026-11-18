// DS-3: docs/thread-model.md exists, every section cited from source resolves, and every
// path:line it cites names an existing file with that many lines.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const docPath = join(root, 'docs', 'thread-model.md')
const walk = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})

// Sections the doc must carry because source comments cite them. §10 A2 is cited by
// joined-prompt.js and is reported absent, not invented.
const SECTIONS = ['1.1', '1.2', '1.3', '4.5', '5']
const headings = text => [...text.matchAll(/^#{2,4} (\d+(?:\.\d+)*)\b/gm)].map(match => match[1])

test('12 doc exists and every cited thread-model section resolves', () => {
  assert.ok(existsSync(docPath), 'docs/thread-model.md exists')
  const have = new Set(headings(readFileSync(docPath, 'utf8')))
  const cited = new Set()
  for (const file of walk(join(root, 'src')).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/thread-model(?:\.md)?\s*§\s*(\d+(?:\.\d+)*)/g)) cited.add(match[1])
  }
  for (const section of SECTIONS) assert.ok(have.has(section), `section ${section} present`)
  const missing = [...cited].filter(section => !have.has(section) && !have.has(section.split('.')[0]))
  // §10 is cited by joined-prompt.js and is documented as absent; nothing else may be missing.
  assert.deepEqual(missing.filter(section => section !== '10'), [])
})

test('13 doc path:line citations resolve', () => {
  const text = readFileSync(docPath, 'utf8')
  const cites = [...text.matchAll(/`((?:src|test|docs)\/[\w./-]+\.(?:js|md|mjs)):(\d+)(?:-(\d*))?`/g)]
  assert.ok(cites.length >= 20, `found ${cites.length} citations`)
  for (const [, file, from, to] of cites) {
    const path = join(root, file)
    assert.ok(existsSync(path), `${file} exists`)
    const lines = readFileSync(path, 'utf8').split('\n').length
    assert.ok(Number(from) <= lines && Number(to || from) <= lines, `${file}:${from}-${to ?? ''} within ${lines} lines`)
  }
})
