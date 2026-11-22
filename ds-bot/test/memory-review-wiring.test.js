// memory-review.js destructures its inputs from the object memory.js hands to installReview.
// A key missing there (fork.86–92 dropped backendOf) makes every joined turn's memory review
// throw "backendOf is not a function" at run time, where no other test looks.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = name => readFileSync(new URL(`../src/host/${name}`, import.meta.url), 'utf8')

test('memory.js passes installReview every key memory-review.js reads from it', () => {
  const review = read('memory-review.js')
  const wanted = /const \{([^}]+)\} = memory\n/.exec(review)
  assert.ok(wanted, 'memory-review.js destructures its inputs from `memory`')
  const keys = wanted[1].split(',').map(key => key.trim()).filter(Boolean)
  const call = /installReview\(rt, \{([^}]+)\}\)/.exec(read('memory.js'))
  assert.ok(call, 'memory.js calls installReview with an object literal')
  const given = new Set(call[1].split(',').map(key => key.trim().split(':')[0].trim()).filter(Boolean))
  const missing = keys.filter(key => !given.has(key))
  assert.deepEqual(missing, [], `installReview is not given: ${missing.join(', ')}`)
})
