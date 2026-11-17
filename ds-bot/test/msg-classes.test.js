import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify } from '../src/host/msg-classes.js'

test('control and visible classes', () => {
  const classes = Object.fromEntries(
    ['kickoff', 'continue', 'update', 'reply', 'report', 'default', 'mystery', undefined]
      .map(r => [String(r), classify(r)]))
  assert.equal(classes.kickoff, 'control')
  assert.equal(classes.continue, 'control')
  assert.equal(classes.update, 'control')
  assert.equal(classes.reply, 'visible')
  assert.equal(classes.report, 'visible')
  assert.equal(classes.default, 'visible')
  assert.equal(classes.mystery, 'visible')
  assert.equal(classes.undefined, 'visible')
})
