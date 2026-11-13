// N-1 I6 (contract §N.4): the frames to a node carry no environment. `bot/turn` has exactly the four
// keys {nodeId, remoteBotId, exchangeId, text}; `bot/create` has no os/host/env/platform key. Both
// turn-sending code paths and the create path are driven for real with a registry that records frames.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeWorld, textRequest } from './joined-world.js'
import { handleJoinedTurn } from '../src/host/joined-turn.js'
import { createBotOnNode } from '../src/host/joined-create.js'

const TURN_KEYS = ['exchangeId', 'nodeId', 'remoteBotId', 'text']
const ENV_KEY = /^(os|host|hostname|env|environment|platform|arch|cpu|memory|kernel|shell|user|account|roots|cwd|home)$/i

describe('N-1 I6: frames carry no environment', () => {
  it('I6-turn-page: a page turn\'s bot/turn has exactly {nodeId, remoteBotId, exchangeId, text}', async () => {
    const w = makeWorld()
    await w.prompt(textRequest('hello node'))
    const turns = w.frames.filter(frame => frame.type === 'bot/turn')
    assert.equal(turns.length, 1)
    assert.deepEqual(Object.keys(turns[0].payload).sort(), TURN_KEYS)
    assert.equal(turns[0].payload.text, 'hello node')
  })

  it('I6-turn-relay: a relayed turn (handleJoinedTurn) has exactly the same four keys', async () => {
    const w = makeWorld()
    await handleJoinedTurn(w.rt, { fromId: 'chief', toId: w.bot.id, text: 'from a teammate', exchangeId: 'x-1', timeoutMs: 5 })
    const turns = w.frames.filter(frame => frame.type === 'bot/turn')
    assert.equal(turns.length, 1)
    assert.deepEqual(Object.keys(turns[0].payload).sort(), TURN_KEYS)
  })

  it('I6-turn-hub-env-not-in-text: whatever the hub knows about itself, the text sent is the user\'s text', async () => {
    const w = makeWorld()
    w.rt.config = { ...w.rt.config, hostContext: 'on' }
    await w.prompt(textRequest('where are you?'))
    const sent = w.frames.find(frame => frame.type === 'bot/turn').payload
    assert.equal(sent.text, 'where are you?')
    assert.equal(JSON.stringify(sent).toLowerCase().includes(process.platform), false, 'no platform of the hub in the frame')
  })

  it('I6-create: bot/create has no environment-shaped key', async () => {
    const frames = []
    const registry = {
      send: (nodeId, type, payload) => { frames.push({ nodeId, type, payload }); return true },
      on() {}, off() {},
      onlineNodes: () => [{ nodeId: 'n1', models: null }],
    }
    const rt = { ctx: { get: name => (name === 'remote-agent:registry' ? registry : undefined) }, botCreateTimeoutMs: 5 }
    await createBotOnNode(rt, { nodeId: 'n1', name: 'Scout', role: 'r', workDir: '/root/work', instructions: 'be brief' })
    const created = frames.filter(frame => frame.type === 'bot/create')
    assert.equal(created.length, 1)
    const keys = Object.keys(created[0].payload)
    // `memoryConfig` is part of the create frame since M4 S6: a joined Bot starts on the
    // hub's federated memory unless its creator picked another backend.
    assert.deepEqual(keys.sort(), ['defaultEffort', 'effort', 'instructions', 'managedBy', 'memoryConfig', 'modelRef', 'name', 'nodeId', 'requestId', 'role', 'workDir'])
    assert.deepEqual(keys.filter(key => ENV_KEY.test(key)), [])
  })
})
