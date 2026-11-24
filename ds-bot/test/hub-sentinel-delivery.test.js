import assert from 'node:assert/strict'
import { test } from 'node:test'
import { directoryOf } from '../src/host/bot-network.js'

function hub() {
  const sends = []
  const delivered = []
  const local = { id: 'cmd', name: 'Commander', role: 'Lead' }
  const rt = {
    state: { bots: { cmd: local } }, load: async () => {}, warn: () => {},
    ctx: { get: name => name === 'remote-agent:registry' ? { send: (...args) => { sends.push(args); return true } } : undefined },
    deliver: async args => { delivered.push(args) },
  }
  return { rt, sends, delivered }
}

test('the directory carries the hub sentinel for every non-joined row', () => {
  const { rt } = hub()
  assert.deepEqual(directoryOf(rt).map(bot => bot.nodeId), ['hub'])
})
