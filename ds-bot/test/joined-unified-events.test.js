import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { createBotTurnReceiver, handleJoinedTurn, replyToSender } from '../src/host/joined-turn.js'
import { DICTIONARY, installLocale, language, t } from '../src/client/i18n.js'

const sender = { id: 'sender', name: 'Chief' }
const joined = {
  id: 'joined:n1:remote', name: 'Remote', origin: 'joined', type: 'remote-worker',
  sessionId: 'mirror', worker: { nodeId: 'n1', remoteBotId: 'remote', home: 'remote' },
}
const body = '[Message from Chief]\n\n  Keep the body intact.  '

// Knife 1: restore textWithSender(text, senderName) in openMirrorTurn.
test('textWithSender prefix is NOT injected into openMirrorTurn', async () => {
  for (const text of [body, '', null, undefined]) {
    const session = new Session('mirror')
    const bots = { [sender.id]: sender, [joined.id]: joined }
    const rt = {
      state: { bots }, botOf: id => bots[id],
      resolveAgent: async () => ({ session }),
    }
    // A missing bridge closes the real mirror turn without opening a result waiter.
    assert.deepEqual(await handleJoinedTurn(rt, {
      fromId: sender.id, toId: joined.id, text, exchangeId: 'mirror-exchange',
    }), { ok: false, error: 'bridge-down' })
    const prompts = session.log.filter(event => event.type === 'user/message')
    assert.equal(prompts.length, 1, 'beginJoinedMirror must write the prompt')
    const mirrored = prompts[0].data.content[0].text
    assert.equal(mirrored, text ?? '')
    assert.doesNotMatch(mirrored, /\[来自 /)
    if (text === body) assert.equal(mirrored.split(sender.name).length - 1, 1)
  }
})

// Node injection needs its own sender header; the mirror remains display-only.
test('node injection adds a sender header and preserves the complete body', async () => {
  for (const roomId of [undefined, 'room-1']) {
    for (const text of [body, '', null, undefined]) {
      const sent = []
      const bot = { id: 'local', name: 'Local', origin: 'local' }
      const rt = {
        state: { bots: { [bot.id]: bot } }, chatOf: () => 'local-chat',
        sendUser: async args => {
          sent.push(args)
          rt.settleJoinedTurn(args.requestId, 'Done')
        },
      }
      const accept = createBotTurnReceiver(rt, { timeoutMs: 1000 })
      const result = await accept({
        remoteBotId: bot.id, exchangeId: 'receiver-exchange', text,
        senderName: sender.name, senderBotId: sender.id, roomId, roomName: 'Team',
      })
      assert.equal(result.ok, true)
      assert.equal(result.text, 'Done')
      assert.equal(sent.length, 1)
      assert.equal(sent[0].requestId, 'receiver-exchange')
      const received = sent[0].content[0].text
      assert.equal(received, `${roomId ? '[群 Team]\n' : ''}[Message from Chief]\n${text ?? ''}`)
      assert.doesNotMatch(received, /\[来自 /)
      assert.equal(received.split(sender.name).length - 1, (text === body ? 1 : 0) + 1)
    }
  }
})

// Knife 3: remove joinedTurn: true from both replyToSender deliveries.
test('replyToSender delivers joinedTurn: true', async () => {
  for (const roomId of [undefined, 'room-1']) {
    for (const work of [undefined, { id: 'work-1' }]) {
      const delivered = []
      const bots = { [sender.id]: sender, [joined.id]: joined }
      const rt = {
        state: { bots }, botOf: id => bots[id], roomOf: id => ({ id }),
        deliver: async msg => { delivered.push(msg) },
      }
      await replyToSender(rt, {
        fromId: sender.id, toId: joined.id, exchangeId: 'reply-exchange', text: 'Done', roomId, work,
      })
      assert.deepEqual(delivered, [{
        fromId: joined.id, toId: sender.id, text: 'Done', role: 'reply', replyTo: 'reply-exchange',
        ...(roomId ? { roomId } : {}), ...(work ? { work } : {}), joinedTurn: true,
      }])
    }
  }
})

// Knife 4: remove ReplyFrom from the ZH dictionary; a fallback key is not a translation.
test('ReplyFrom i18n key exists in zh locale', () => {
  const dicts = new Map()
  const off = installLocale({
    getLocale: () => ({ active: 'zh', locales: [] }),
    register: (ns, lang, dict) => {
      dicts.set(`${ns}:${lang}`, dict)
      return () => dicts.delete(`${ns}:${lang}`)
    },
    bind: ns => key => dicts.get(`${ns}:zh`)?.[key] ?? key,
  })
  try {
    assert.equal(language(), 'zh')
    assert.ok(Object.hasOwn(DICTIONARY.zh, 'ReplyFrom'))
    assert.equal(t('ReplyFrom'), '收到来自跨机 Bot 的回复：')
    assert.equal(DICTIONARY['zh-TW'].ReplyFrom, '收到來自跨機 Bot 的回覆：')
  } finally {
    off()
  }
})
