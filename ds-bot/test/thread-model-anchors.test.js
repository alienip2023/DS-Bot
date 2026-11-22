// DS-4: every row of the doc's "Anchors" table must still sit on its line. The older test 13
// in thread-model-doc.test.js only checks a line is inside the file, which let citations drift.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const doc = readFileSync(`${root}docs/thread-model.md`, 'utf8')

function anchors() {
  const section = doc.split(/^## Anchors$/m)[1]
  assert.ok(section, 'the doc has an Anchors section')
  return [...section.matchAll(/^\| `([\w./-]+):(\d+)` \| `([^`]+)` \|$/gm)].map(([, file, line, token]) => ({ file, line: Number(line), token }))
}

test('T2 the Anchors table is present and every anchor line contains its token', () => {
  const rows = anchors()
  assert.ok(rows.length >= 20, `found ${rows.length} anchors`)
  const bad = []
  for (const { file, line, token } of rows) {
    const text = readFileSync(`${root}${file}`, 'utf8').split('\n')[line - 1] ?? ''
    if (!text.includes(token)) bad.push(`${file}:${line} lacks ${token}`)
  }
  assert.deepEqual(bad, [])
})

test('T1 MAX_THREADS_PER_BOT is documented as implemented at its verified anchors', () => {
  assert.doesNotMatch(doc, /enforcement \*\*not verified\*\*|where it is enforced is \*\*not verified\*\*/)
  assert.match(doc, /\*\*IMPLEMENTED\*\*:\s+`createThread` refuses the eleventh Thread[^]*?`src\/host\/roster\.js:350-352`[^]*?`src\/host\/channel\.js:872-874`[^]*?`test\/thread-t2-api\.test\.js:55-65`/)
  const roster = readFileSync(`${root}src/host/roster.js`, 'utf8').split('\n')
  assert.match(roster.slice(349, 352).join('\n'), /rows\.length >= MAX_THREADS_PER_BOT[^]*bot\/refused/)
})
