// test/by-session-id.test.js — behavioral test: bySessionId lookup routes joined bot to handleJoinedTurn, not local prompt
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/joined-turn.js'

// joinedShadow needs: bot.origin === 'joined' && bot.worker && bot.worker.home === 'remote'
function makeJoinedBot(id, sessionId) {
  return {
    id,
    name: id,
    origin: 'joined',
    sessionId,
    worker: { nodeId: 'n1', remoteBotId: 'remote-' + id, hostname: 'h1', home: 'remote', online: true, lastSeen: null },
  }
}

test('bySessionId routes to handleJoinedTurn, not local prompt', async () => {
  const mirrorSid = 'session-mirror-abc'
  const joinedBot = makeJoinedBot('bot-joined-1', mirrorSid)

  let promptCalls = 0
  let dispatchCalls = 0

  const origSendUser = async (args) => {
    promptCalls++
    return { ok: true }
  }

  const ctx = {
    provide() {},
    get() { return undefined },
  }

  const rt = {
    ctx,
    sendUser: origSendUser,
    botOf: () => undefined, // mirror sessionId != bot.id, so botOf returns undefined
    bySessionId: (sid) => (sid === mirrorSid ? joinedBot : undefined),
    state: { bots: {} },
    deliver: async () => {},
    handleJoinedTurn: null, // will be set by install
  }

  install(rt)

  // Override handleJoinedTurn to count dispatches (simulate bot/turn dispatched)
  rt.handleJoinedTurn = async (msg) => {
    dispatchCalls++
    return { ok: true, text: 'reply from node' }
  }

  // Send to mirror sessionId — should go through bySessionId → joinedShadow → handleJoinedTurn
  await rt.sendUser({ sessionId: mirrorSid, content: [{ type: 'text', text: 'hello' }] })

  assert.equal(dispatchCalls, 1, 'handleJoinedTurn should be called once (bot/turn dispatched)')
  assert.equal(promptCalls, 0, 'local prompt (orig sendUser) should NOT be called')
})

test('without bySessionId, local prompt is called (red evidence)', async () => {
  const mirrorSid = 'session-mirror-xyz'
  const joinedBot = makeJoinedBot('bot-joined-2', mirrorSid)

  let promptCalls = 0
  let dispatchCalls = 0

  const ctx = {
    provide() {},
    get() { return undefined },
  }

  const rt = {
    ctx,
    sendUser: async (args) => {
      promptCalls++
      return { ok: true }
    },
    botOf: () => undefined,
    // NO bySessionId — simulates the bug (before fix)
    state: { bots: {} },
    deliver: async () => {},
    handleJoinedTurn: null,
  }

  install(rt)

  rt.handleJoinedTurn = async (msg) => {
    dispatchCalls++
    return { ok: true, text: 'reply' }
  }

  await rt.sendUser({ sessionId: mirrorSid, content: [{ type: 'text', text: 'hello' }] })

  assert.equal(promptCalls, 1, 'without bySessionId, local prompt IS called (the bug)')
  assert.equal(dispatchCalls, 0, 'without bySessionId, handleJoinedTurn is NOT called')
})
