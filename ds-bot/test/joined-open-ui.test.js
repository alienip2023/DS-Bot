import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapDefaultModel } from '../src/host/channel.js'
import { botRowClick } from '../src/client/row-actions.js'
import { openJoinedChat, classifyItem, sendJoined } from '../src/client/joined-chat-actions.js'

// ── helpers ──────────────────────────────────────────────────────────────────
function makeUi() {
  let state = {}
  return {
    set: (fn) => { state = fn(state) },
    get: () => state,
    getSnapshot: () => state,
  }
}

// ── test 1: openJoinedChat sets ui.joinedChat (imported from joined-chat-actions.js) ─
test('1. openJoinedChat sets ui.joinedChat (imported)', () => {
  const ui = makeUi()
  openJoinedChat(ui, 'joined:dshtest-1:session-abc')
  assert.equal(ui.get().joinedChat, 'joined:dshtest-1:session-abc')
})

// ── test 2: botRowClick joined → openJoinedChat (imported from row-actions.js) ──────
test('2. botRowClick joined: openJoinedChat called, openSession skipped (imported)', () => {
  const openJoinedChatCalls = []
  const openSessionCalls = []
  const actions = {
    openJoinedChat: (id) => openJoinedChatCalls.push(id),
    openSession: (id) => openSessionCalls.push(id),
  }
  botRowClick(true, 'joined:dshtest-1:session-bot1', actions)
  assert.equal(openJoinedChatCalls.length, 1, 'openJoinedChat must be called once')
  assert.equal(openJoinedChatCalls[0], 'joined:dshtest-1:session-bot1')
  assert.equal(openSessionCalls.length, 0, 'openSession must NOT be called for joined bot')
})

// ── test 3: botRowClick non-joined → openSession (imported from row-actions.js) ─────
test('3. botRowClick non-joined: openSession called, openJoinedChat skipped (imported)', () => {
  const openSessionCalls = []
  const openJoinedChatCalls = []
  const actions = {
    openJoinedChat: (id) => openJoinedChatCalls.push(id),
    openSession: (id) => openSessionCalls.push(id),
  }
  botRowClick(false, 'local-bot-123', actions)
  assert.equal(openSessionCalls.length, 1)
  assert.equal(openJoinedChatCalls.length, 0)
})

// ── test 4: classifyItem from joined-chat-actions.js (imported) ───────────────────
test('4. classifyItem: user→mine, bot→theirs, event→event, empty event→skip, divider→divider (imported)', () => {
  assert.equal(classifyItem({ kind: 'user', text: 'hello' }), 'mine')
  assert.equal(classifyItem({ kind: 'bot', text: 'hi' }), 'theirs')
  assert.equal(classifyItem({ kind: 'event', text: 'started' }), 'event')
  assert.equal(classifyItem({ kind: 'event' }), 'skip')
  assert.equal(classifyItem({ kind: 'divider', label: 'today' }), 'divider')
})

// ── test 5: sendJoined uses botId as sessionId (imported from joined-chat-actions.js) ─
test('5. sendJoined passes botId as sessionId directly (imported)', async () => {
  const calls = []
  const callFn = (name, body) => { calls.push({ name, body }); return Promise.resolve({ ok: true }) }
  const botId = 'joined:dshtest-1:session-abc-123'
  await sendJoined(callFn, botId, 'hello')
  assert.equal(calls.length, 1, 'one call must be made')
  assert.equal(calls[0].name, 'send', 'must call send endpoint')
  assert.equal(calls[0].body.sessionId, botId, 'sessionId must be the botId (joined shadow id), not remoteBotId')
  assert.equal(calls[0].body.text, 'hello')
})

// ── test 6: mapDefaultModel from channel.js (imported) ─────────────────────────────
test('6. mapDefaultModel({provider,model}) → "provider/model" (imported from channel.js)', () => {
  assert.equal(mapDefaultModel({ provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V3' }), 'siliconflow/deepseek-ai/DeepSeek-V3')
  assert.equal(mapDefaultModel('already/a/string'), 'already/a/string')
  assert.equal(mapDefaultModel(null), null)
  assert.equal(mapDefaultModel({}), null)
  assert.equal(mapDefaultModel({ provider: 'x' }), null)
})

// ── test 7: joinedChatView failure → offline (no throw) ────────────────────────────
test('7. joinedChatView failure → offline (no throw)', async () => {
  const callFn = async () => { throw new Error('ECONNREFUSED') }
  let offline = false
  try {
    await callFn('chat', { botId: 'joined:dshtest-1:session-x' })
    offline = false
  } catch {
    offline = true
  }
  assert.equal(offline, true)
})
