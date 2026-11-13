// M2 item 2: a node-owned Bot row must behave like another machine's row — opening it
// goes through openJoinedHome, never a local openSession. The sidebar itself needs a DOM;
// the decision it makes is the shared predicate, so the predicate and the wiring are both
// asserted here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { botRowClick, remoteHomeOf } from '../src/client/row-actions.js'

const nodeRow = {
  id: 'node:n1:b1', origin: 'node', type: 'remote-worker',
  worker: { home: 'node', nodeId: 'n1', remoteBotId: 'b1', hostname: 'box-1' },
}
const joinedRow = { id: 'joined:n1:rb1', origin: 'joined', worker: { home: 'remote', nodeId: 'n1' } }
const peerRow = { id: 'peer:hub:b1', origin: 'peer', worker: { home: 'hub' } }
const localRow = { id: 'local-1', origin: 'local', sessionId: 'local-1' }

test('U1 remoteHomeOf: node and joined rows are remote, local and peer are not', () => {
  assert.equal(remoteHomeOf(nodeRow), true)
  assert.equal(remoteHomeOf(joinedRow), true)
  assert.equal(remoteHomeOf(localRow), false)
  assert.equal(remoteHomeOf(peerRow), false)
  assert.equal(remoteHomeOf({ origin: 'joined', worker: { home: 'hub' } }), false)
  assert.equal(remoteHomeOf(undefined), false)
})

test('U2 a node BotRow click opens the joined home, not a local Session', () => {
  const calls = []
  const actions = {
    openJoinedHome: id => calls.push(['openJoinedHome', id]),
    openSession: id => calls.push(['openSession', id]),
  }
  botRowClick(remoteHomeOf(nodeRow), nodeRow.id, actions)
  assert.deepEqual(calls, [['openJoinedHome', 'node:n1:b1']])
})

test('U3 the sidebar BotRow uses the shared predicate for its click', () => {
  const source = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ botRowClick, remoteHomeOf \} from '\.\/row-actions\.js'/)
  assert.match(source, /const remoteHome = remoteHomeOf\(bot\)/)
  assert.match(source, /botRowClick\(remoteHome, id, actions\)/)
})
