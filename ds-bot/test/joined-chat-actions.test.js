import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendFromDialog, sendJoined } from '../src/client/joined-chat-actions.js'

// The dialog's real `actions` object has no `_call` and `joinedChatView` has no `__call`:
// the only wired entry is `actions.sendJoined(botId, text)`.
function makeActions(result) {
  const calls = []
  return {
    calls,
    sendJoined: (botId, text) => { calls.push([botId, text]); return Promise.resolve(result) },
  }
}

test('FD-1 sendFromDialog calls actions.sendJoined exactly once with (botId, text) and passes the result through', async () => {
  const value = { ok: true, value: { sent: true } }
  const actions = makeActions(value)
  const out = await sendFromDialog(actions, 'joined:n1:rb1', 'ping')
  assert.deepEqual(actions.calls, [['joined:n1:rb1', 'ping']])
  assert.equal(out, value)
})

test('FD-2 ok:false with error.message throws that message', async () => {
  const actions = makeActions({ ok: false, error: { code: 'x', message: 'node offline' } })
  await assert.rejects(() => sendFromDialog(actions, 'b', 't'), (e) => { assert.equal(e.message, 'node offline'); return true })
  assert.equal(actions.calls.length, 1)
})

test('FD-3 ok:false with string error throws the string; with none throws Failed to send (or the given fallback)', async () => {
  await assert.rejects(() => sendFromDialog(makeActions({ ok: false, error: 'plain' }), 'b', 't'), (e) => { assert.equal(e.message, 'plain'); return true })
  await assert.rejects(() => sendFromDialog(makeActions({ ok: false }), 'b', 't'), (e) => { assert.equal(e.message, 'Failed to send'); return true })
  await assert.rejects(() => sendFromDialog(makeActions({ ok: false }), 'b', 't', '发送失败'), (e) => { assert.equal(e.message, '发送失败'); return true })
})

test('FD-4 end to end with the real sendJoined: host call receives send {sessionId: botId, text}', async () => {
  const hostCalls = []
  const call = (name, body) => { hostCalls.push([name, body]); return Promise.resolve({ ok: true }) }
  const actions = { sendJoined: (botId, text) => sendJoined(call, botId, text) }
  await sendFromDialog(actions, 'joined:n1:rb1', 'hello')
  assert.deepEqual(hostCalls, [['send', { sessionId: 'joined:n1:rb1', text: 'hello' }]])
})
