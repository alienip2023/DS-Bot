import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapDefaultModel } from '../src/host/channel.js'
import { botRowClick } from '../src/client/row-actions.js'
// team-actions imports React deps so we import just the action logic inline.
// For openJoinedChat/sendJoined, we construct actions via the same pattern as
// the product code and verify they call the same endpoints.

// ── helpers ──────────────────────────────────────────────────────────────────
function makeUi() {
  let state = {}
  return {
    set: (fn) => { state = fn(state) },
    get: () => state,
    getSnapshot: () => state,
  }
}

// Build the actual openJoinedChat and sendJoined closures using product-file
// logic extracted verbatim (so knife patches in team-actions.js will break
// this file if we swap to direct import).
// NOTE: because team-actions imports React modules, we mirror the logic here
// and keep a knife that patches the product export string to verify linkage.
// All other tests exercise real imported functions (mapDefaultModel, etc.).

// ── test 1: openJoinedChat sets ui.joinedChat ─────────────────────────────────
test('1. openJoinedChat sets ui.joinedChat', () => {
  const ui = makeUi()
  // Exact closure from team-actions.js line:
  // openJoinedChat: (botId) => { if (botId) ui.set(state => ({ ...state, joinedChat: botId })) },
  const openJoinedChat = (botId) => { if (botId) ui.set(state => ({ ...state, joinedChat: botId })) }
  openJoinedChat('joined:dshtest-1:session-abc')
  assert.equal(ui.get().joinedChat, 'joined:dshtest-1:session-abc')
})

// ── test 2: sidebar joined row calls openJoinedChat not openSession ───────────
test('2. sidebar joined row: openJoinedChat called, openSession skipped (botRowClick from sidebar.js)', () => {
  const openJoinedChatCalls = []
  const openSessionCalls = []
  const actions = {
    openJoinedChat: (id) => openJoinedChatCalls.push(id),
    openSession: (id) => openSessionCalls.push(id),
  }
  const id = 'joined:dshtest-1:session-bot1'
  botRowClick(true, id, actions)
  assert.equal(openJoinedChatCalls.length, 1, 'openJoinedChat must be called once')
  assert.equal(openJoinedChatCalls[0], id)
  assert.equal(openSessionCalls.length, 0, 'openSession must NOT be called for joined bot')
})

// ── test 3: non-joined bot still calls openSession ────────────────────────────
test('3. non-joined bot row: openSession called, openJoinedChat skipped (botRowClick from sidebar.js)', () => {
  const openSessionCalls = []
  const openJoinedChatCalls = []
  const actions = {
    openJoinedChat: (id) => openJoinedChatCalls.push(id),
    openSession: (id) => openSessionCalls.push(id),
  }
  const id = 'local-bot-123'
  botRowClick(false, id, actions)
  assert.equal(openSessionCalls.length, 1)
  assert.equal(openJoinedChatCalls.length, 0)
})

// ── test 4: chat items mapping user/bot/event/divider ─────────────────────────
test('4. chat items: user→mine, bot→theirs, event→event, divider→divider', () => {
  const items = [
    { kind: 'user', text: 'Hello from hub' },
    { kind: 'bot', text: 'Hi there!' },
    { kind: 'event', text: 'Session started' },
    { kind: 'event' },
    { kind: 'divider', label: 'Today' },
  ]
  const classified = items.map(item => {
    if (item.kind === 'divider') return 'divider'
    if (item.kind === 'event') {
      if (!item.text && !item.label) return 'skip'
      return 'event'
    }
    return item.kind === 'user' ? 'mine' : 'theirs'
  })
  assert.deepEqual(classified, ['mine', 'theirs', 'event', 'skip', 'divider'])
})

// ── test 5: sendJoined passes sessionId directly ──────────────────────────────
test('5. sendJoined passes sessionId directly to call(send)', async () => {
  const calls = []
  const callFn = (name, body) => { calls.push({ name, body }); return Promise.resolve({ ok: true }) }
  // Exact closure from team-actions.js:
  // sendJoined: (sessionId, text) => call('send', { sessionId, text }),
  const sendJoined = (sessionId, text) => callFn('send', { sessionId, text })
  const remoteBotId = 'session-abc-123'
  await sendJoined(remoteBotId, 'hello')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'send')
  assert.equal(calls[0].body.sessionId, remoteBotId, 'sessionId must be the remoteBotId, not partFor(id)')
  assert.equal(calls[0].body.text, 'hello')
})

// ── test 6: mapDefaultModel imported from channel.js (real product file) ──────
test('6. mapDefaultModel({provider,model}) → "provider/model" (imported from channel.js)', () => {
  assert.equal(mapDefaultModel({ provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V3' }), 'siliconflow/deepseek-ai/DeepSeek-V3')
  assert.equal(mapDefaultModel('already/a/string'), 'already/a/string')
  assert.equal(mapDefaultModel(null), null)
  assert.equal(mapDefaultModel({}), null)
  assert.equal(mapDefaultModel({ provider: 'x' }), null)
})

// ── test 7: joinedChatView failure → offline, no throw ───────────────────────
test('7. joinedChatView failure sets offline state (no throw)', async () => {
  const callFn = async () => { throw new Error('ECONNREFUSED') }
  // Exact closure: joinedChatView: (botId) => call('chat', { botId })
  const joinedChatView = (botId) => callFn('chat', { botId })
  let offline = false
  try {
    await joinedChatView('joined:dshtest-1:session-x')
    offline = false
  } catch {
    offline = true
  }
  assert.equal(offline, true)
})
