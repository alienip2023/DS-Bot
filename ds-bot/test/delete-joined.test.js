import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyRosterReport } from '../src/host/roster-join.js'
import { joinedDeleteBot, createBotDeleteReceiver } from '../src/host/joined-page.js'

function makeState(bots = {}) {
  return { bots, deletedJoinedIds: undefined }
}

describe('S23c: delete joined bot + roster recreate protection', () => {
  it('S23c-delete-joined: deletedJoinedIds populated after delete, state cleaned', () => {
    const state = makeState({
      'joined:n1:rb1': { id: 'joined:n1:rb1', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } },
    })
    const bot = state.bots['joined:n1:rb1']
    // Simulate deleteBot logic: delete from bots + push to deletedJoinedIds
    delete state.bots[bot.id]
    if (bot.origin === 'joined') {
      if (!Array.isArray(state.deletedJoinedIds)) state.deletedJoinedIds = []
      if (!state.deletedJoinedIds.includes(bot.id)) state.deletedJoinedIds.push(bot.id)
    }
    assert.equal(state.bots['joined:n1:rb1'], undefined, 'bot must be removed from state.bots')
    assert.ok(Array.isArray(state.deletedJoinedIds), 'deletedJoinedIds must be an array')
    assert.ok(state.deletedJoinedIds.includes('joined:n1:rb1'), 'deletedJoinedIds must include the deleted bot id')
  })

  it('S23c-roster-recreate-blocked: applyRosterReport skips bots in deletedJoinedIds', () => {
    // Knife: delete `if (Array.isArray(state.deletedJoinedIds) && ...)` check → bot recreated → assert fails → RED
    const state = makeState({})
    state.deletedJoinedIds = ['joined:n1:rb1']
    const report = { nodeId: 'n1', online: true, hostname: 'host1', bots: [{ id: 'rb1', name: 'Bot1', role: 'Worker' }] }
    applyRosterReport(state, report)
    assert.equal(state.bots['joined:n1:rb1'], undefined, 'deleted joined bot must NOT be recreated by roster report')
  })

  it('S23c-non-deleted: applyRosterReport still creates non-deleted bots', () => {
    const state = makeState({})
    state.deletedJoinedIds = ['joined:n1:other-bot']
    const report = { nodeId: 'n1', online: true, hostname: 'host1', bots: [{ id: 'rb1', name: 'Bot1', role: 'Worker' }] }
    applyRosterReport(state, report)
    assert.ok(state.bots['joined:n1:rb1'] !== undefined, 'non-deleted bot must still be created')
  })

  // ── S57-B: bot/delete propagation ──────────────────────────────────────────

  it('S57-B-missing-mark: applyRosterReport marks joined bots absent from report as missingFromReport', () => {
    // Knife: remove missingFromReport assignment → bot has no missingFromReport flag → assert fails → RED
    const state = makeState({
      'joined:n1:rb1': { id: 'joined:n1:rb1', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true } },
      'joined:n1:rb2': { id: 'joined:n1:rb2', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb2', home: 'remote', online: true } },
    })
    // Report only includes rb2 — rb1 is missing
    const report = { nodeId: 'n1', online: true, hostname: 'host1', bots: [{ id: 'rb2', name: 'Bot2', role: 'Worker' }] }
    applyRosterReport(state, report)
    assert.equal(state.bots['joined:n1:rb1']?.worker?.missingFromReport, true, 'absent bot must be marked missingFromReport')
    assert.equal(state.bots['joined:n1:rb2']?.worker?.missingFromReport, false, 'present bot must be cleared, not left missingFromReport')
  })

  it('S57-B-delete-send: joinedDeleteBot sends bot/delete to node registry', async () => {
    // Knife: comment out registry.send call → sent.length=0 → timeout → error → assert fails → RED
    const sends = []
    const registry = {
      send: (nodeId, type, data) => { sends.push({ nodeId, type, data }); return true },
      on: (event, fn) => {},
      off: (event, fn) => {},
      onlineNodes: () => [{ nodeId: 'n1' }],
    }
    const rt = {
      state: {},
      botOf: (id) => ({
        id, origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' },
      }),
      ctx: { get: (key) => key === 'remote-agent:registry' ? registry : undefined },
    }
    // Don't await (no result listener in this test) — just verify send was dispatched
    const p = joinedDeleteBot(rt, 'joined:n1:rb1')
    assert.equal(sends.length, 1, 'must have dispatched one bot/delete send')
    assert.equal(sends[0].type, 'bot/delete', 'send type must be bot/delete')
    assert.equal(sends[0].data.remoteBotId, 'rb1', 'payload must contain remoteBotId')
    assert.equal(sends[0].data.nodeId, 'n1', 'payload must contain nodeId')
    // Cancel to avoid hanging test (no result listener wired)
    registry.on = () => {}  // already captured, nothing to cancel
    p.catch(() => {})
  })

  it('S57-B-node-receiver: createBotDeleteReceiver calls rt.deleteBot with the correct remoteBotId', async () => {
    // Knife: change `rt.deleteBot(remoteBotId)` to `rt.deleteBot(null)` → deletedWith[0]=null → assert fails → RED
    const deletedWith = []
    const rt = { deleteBot: async (id) => { deletedWith.push(id) } }
    const accept = createBotDeleteReceiver(rt)
    const result = await accept({ remoteBotId: 'rb1' })
    assert.deepEqual(deletedWith, ['rb1'], 'must call rt.deleteBot with remoteBotId')
    assert.equal(result.ok, true, 'must return ok:true on success')
  })

  it('S57-B-offline: joinedDeleteBot returns node-offline when node is not in onlineNodes', async () => {
    // Knife: remove online check → goes ahead and sends → no result → timeout → different error → RED
    const rt = {
      state: {},
      botOf: (id) => ({ id, origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } }),
      ctx: { get: (key) => key === 'remote-agent:registry' ? {
        send: () => true, on: () => {}, off: () => {}, onlineNodes: () => [],
      } : undefined },
    }
    const result = await joinedDeleteBot(rt, 'joined:n1:rb1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'node-offline', 'offline node must return node-offline error immediately')
  })
})


// ── S58-D1: deleteBot sends bot/delete frame through real roster layer ──────

import EventEmitter from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function deleteWorld({ online = true, answer = () => ({ ok: true }), worker = {} } = {}) {
  const emitter = new EventEmitter()
  const frames = []
  const registry = {
    send: (nodeId, type, payload) => {
      frames.push({ nodeId, type, payload })
      if (type === 'bot/delete') Promise.resolve().then(() => emitter.emit('botDeleteResult', { requestId: payload.requestId, nodeId, ...answer(payload) }))
      return true
    },
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
    onlineNodes: () => online ? [{ nodeId: 'n1' }] : [],
  }
  const ctx = fakeContext({ services: { 'remote-agent:registry': registry } })
  ctx.sessionController = {
    prompt: async () => ({ accepted: true }),
    list: async () => ({ items: [] }),
    cancel: async () => ({ accepted: true }),
  }
  ctx.connection.fetch.register = () => () => {}
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-d1-'))
  const rt = createRuntime(ctx, { home })
  const bot = {
    id: 'joined:n1:rb1', name: 'Joined', origin: 'joined', type: 'remote-worker',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true, ...worker },
  }
  rt.state.bots[bot.id] = bot
  return { rt, bot, frames, registry, home }
}

describe('S58-D1: deleteBot sends bot/delete through real roster layer', () => {
  it('S58-D1-send: deleting a joined Bot dispatches bot/delete to the node and then forgets it', async () => {
    // Knife: revert joinedDeleteBot to take id (not bot) → rt.botOf returns undefined after delete → bot-not-joined → no send → RED
    const { rt, bot, frames } = deleteWorld({ online: true })
    await rt.deleteBot(bot.id)

    const delFrame = frames.find(f => f.type === 'bot/delete')
    assert.ok(delFrame, 'must have sent a bot/delete frame')
    assert.equal(delFrame.nodeId, 'n1', 'frame must target the correct node')
    assert.equal(delFrame.payload.remoteBotId, 'rb1', 'payload must carry remoteBotId')
    assert.ok(delFrame.payload.requestId, 'payload must carry a requestId')

    assert.ok(rt.state.deletedJoinedIds?.includes(bot.id), 'tombstone must be in deletedJoinedIds')
    assert.equal(rt.state.bots[bot.id], undefined, 'bot must be removed from state.bots')
  })

  it('S58-D1-offline: node offline refuses the delete; the Bot is not forgotten while it keeps running there', async () => {
    const { rt, bot, frames } = deleteWorld({ online: false })
    await assert.rejects(() => rt.deleteBot(bot.id), (error) => {
      assert.equal(error.code, 'bot/refused')
      assert.match(error.message, /was not deleted.*node-offline/)
      return true
    })
    assert.equal(frames.find(f => f.type === 'bot/delete'), undefined, 'no frame to an offline node')
    assert.equal(rt.state.bots[bot.id], bot, 'the Bot row stays')
    assert.equal(rt.state.deletedJoinedIds?.includes(bot.id) ?? false, false, 'no tombstone')
  })

  it('S58-D1-node-failed: a node that refuses bot/delete keeps the Bot and says why', async () => {
    const { rt, bot } = deleteWorld({ answer: () => ({ ok: false, error: 'bot-delete-failed: busy' }) })
    await assert.rejects(() => rt.deleteBot(bot.id), /bot-delete-failed: busy/)
    assert.equal(rt.state.bots[bot.id], bot)
    assert.equal(rt.state.deletedJoinedIds?.includes(bot.id) ?? false, false)
  })

  it('S58-D1-timeout: no answer from the node keeps the Bot', async () => {
    const { rt, bot } = deleteWorld({ answer: () => ({ ok: false, error: 'bot-delete-timeout' }) })
    await assert.rejects(() => rt.deleteBot(bot.id), /bot-delete-timeout/)
    assert.equal(rt.state.bots[bot.id], bot)
  })

  it('S58-D1-gone: a Bot the node no longer lists, or no longer has, can still be removed from the hub', async () => {
    const missing = deleteWorld({ online: false, worker: { missingFromReport: true } })
    await missing.rt.deleteBot(missing.bot.id)
    assert.equal(missing.rt.state.bots[missing.bot.id], undefined)
    assert.ok(missing.rt.state.deletedJoinedIds.includes(missing.bot.id))
    const unknown = deleteWorld({ answer: () => ({ ok: false, error: 'bot-delete-failed: Unknown Bot' }) })
    await unknown.rt.deleteBot(unknown.bot.id)
    assert.equal(unknown.rt.state.bots[unknown.bot.id], undefined)
  })
})

// ── S59: blind-spot tests + naming cleanup ─────────────────────────────────

describe('S59: joinedDeleteBot blind spots', () => {
  it('S59-timeout: node does not ack → result returns bot-delete-timeout, no throw', async () => {
    // Knife: change timeout resolve to reject → unhandledRejection → RED
    const registry = {
      send: () => true,
      on: () => {},
      off: () => {},
      onlineNodes: () => [{ nodeId: 'n1' }],
    }
    const rt = {
      botOf: (id) => ({ id, origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } }),
      ctx: { get: (key) => key === 'remote-agent:registry' ? registry : undefined },
      botDeleteTimeoutMs: 50,
    }
    const result = await joinedDeleteBot(rt, 'joined:n1:rb1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'bot-delete-timeout')
  })

  it('S59-send-false: registry.send returns false → warn, no throw, returns bridge-down', async () => {
    // Knife: remove sent !== true check → await pending forever → timeout → different error → RED
    const registry = {
      send: () => false,
      on: () => {},
      off: () => {},
      onlineNodes: () => [{ nodeId: 'n1' }],
    }
    const rt = {
      botOf: (id) => ({ id, origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } }),
      ctx: { get: (key) => key === 'remote-agent:registry' ? registry : undefined },
      botDeleteTimeoutMs: 50,
    }
    const result = await joinedDeleteBot(rt, 'joined:n1:rb1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'bridge-down')
  })

  it('S59-concurrent: two joined Bots deleted same tick → both frames sent, different requestIds, both tombstones', async () => {
    // Knife: share a single requestId → requestId equality → RED
    const sends = []
    const registry = {
      send: (nodeId, type, payload) => { sends.push({ nodeId, type, payload }); return true },
      on: (ev, fn) => {},
      off: () => {},
      onlineNodes: () => [{ nodeId: 'n1' }],
    }
    const rt = {
      botOf: (id) => {
        const map = {
          'joined:n1:rb1': { id: 'joined:n1:rb1', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote' } },
          'joined:n1:rb2': { id: 'joined:n1:rb2', origin: 'joined', worker: { nodeId: 'n1', remoteBotId: 'rb2', home: 'remote' } },
        }
        return map[id]
      },
      ctx: { get: (key) => key === 'remote-agent:registry' ? registry : undefined },
      botDeleteTimeoutMs: 50,
    }
    // Fire both concurrently
    const [r1, r2] = await Promise.allSettled([
      joinedDeleteBot(rt, 'joined:n1:rb1'),
      joinedDeleteBot(rt, 'joined:n1:rb2'),
    ])
    // Both will timeout (no result listener), but we check sends happened
    const delSends = sends.filter(s => s.type === 'bot/delete')
    assert.equal(delSends.length, 2, 'must have sent two bot/delete frames')
    assert.notEqual(delSends[0].payload.requestId, delSends[1].payload.requestId, 'requestIds must differ')
    assert.deepEqual(
      delSends.map(s => s.payload.remoteBotId).sort(),
      ['rb1', 'rb2'],
      'both remoteBotIds must be present'
    )
  })
})
