// s50 / merge plan R3: upstream v0.3.2 adopts the work dsh still runs after a plugin reload
// (turns.js adoptLiveWork → entry.turn = RECOVERED_TURN (-1), activity "thinking"), for every Bot Session whose
// Agent is `running`. A joined (remote) Bot's page turn is OURS: its in-flight state belongs to the page-turn
// tracker and the mirror Session, and a live Agent on a mirror Session is never a turn of this machine.
// The adoption must therefore leave a joined shadow alone, and must still adopt a local Bot (not a global
// switch-off), and must not collide with the turn numbers allocateTurn gives page turns.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const JOINED = 'joined:n1:rb1'

function world(agents) {
  const ctx = fakeContext({ services: { agents: { list: () => agents } } })
  ctx.sessionController = { prompt: async () => ({ accepted: true }), list: async () => ({ items: [] }), cancel: async () => ({ accepted: true }) }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-recover-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['main'], rooms: {}, agents: {},
    bots: {
      main: { id: 'main', name: 'Main', sessionId: 'sess-main', capabilities: [] },
      'local-a': { id: 'local-a', name: 'Local A', sessionId: 'sess-a', capabilities: [] },
      [JOINED]: { id: JOINED, name: 'Joined', origin: 'joined', type: 'remote-worker', sessionId: 'mirror-1', capabilities: [], worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true } },
    },
  }))
  return { ctx, rt: createRuntime(ctx, { home }) }
}

const running = (id, extra = {}) => ({ id, status: 'running', session: { id }, ...extra })

describe('S50-recover: adopting the work dsh still runs', () => {
  it('R3-local: a local Bot whose Agent runs is adopted as mid-turn (the adoption is not switched off)', async () => {
    const { rt } = world([running('sess-a')])
    await rt.load()
    await rt.adoptLiveWork()
    const entry = rt.live.get('sess-a')
    assert.ok(entry, 'adopted')
    assert.equal(entry.turn, -1)
  })

  it('R3-joined: a joined shadow\'s mirror Session is NOT adopted, even when an Agent on it reports running', async () => {
    const { rt } = world([running('mirror-1'), running('sess-a')])
    await rt.load()
    await rt.adoptLiveWork()
    assert.equal(rt.live.get('mirror-1'), undefined, 'the shadow has no live entry made for it')
    assert.equal(rt.live.get('sess-a')?.turn, -1, 'the local Bot beside it is adopted')
  })
})
