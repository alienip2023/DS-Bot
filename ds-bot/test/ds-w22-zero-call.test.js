import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { after, mock, test } from 'node:test'

const calls = []
const blocked = name => () => {
  calls.push(name)
  throw new Error('Unexpected external call in an offline fixture')
}

const block = (target, name) => mock.method(target, name, blocked(name))
block(globalThis, 'fetch')
for (const transport of [http, https]) {
  block(transport, 'request')
  block(transport, 'get')
}
for (const name of ['connect', 'createConnection']) block(net, name)
for (const name of Object.keys(childProcess)) {
  if (typeof childProcess[name] === 'function' && name !== 'ChildProcess') block(childProcess, name)
}
syncBuiltinESMExports()
after(() => {
  mock.restoreAll()
  syncBuiltinESMExports()
})
// Load the scenarios after replacing built-ins, including their named ESM exports.
const { registerMemoryNodeTests } = await import('./ds-w22-memory-nodes.test.js')
registerMemoryNodeTests()
await import('./ds-w22-script-delivery.test.js')
await import('./ds-w22-team-sharing.test.js')
await import('./ds-w22-denied-scope.test.js')

test('zero external calls', () => assert.deepEqual(calls, [], 'zero external calls'))
