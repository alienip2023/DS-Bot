// Peer roster rows: another machine's Bots mirrored read-only. The real runtime is
// installed (index.js order) over an in-memory Session host, so the store, the
// migrations and the channel are the product's own.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MISSING_FRAMES, applyPeerRoster, handlePeerRoster, peerId, sanitizePeerRoster } from '../src/host/federation.js'
import { toBotRecord, threadsOfBot } from '../src/host/bot-store.js'
import { makeBot, threadWorld } from './thread-t2-world.js'

const report = (overrides = {}) => ({
  hubId: 'hub-a',
  level: 'roster',
  hostname: 'mac-b',
  bots: [
    { id: 'b1', name: 'Bravo', role: 'Engineer', main: true, model: 'deepseek-chat' },
    { id: 'b2', name: 'Charlie', role: 'Reviewer' },
  ],
  ...overrides,
})

test('a peer row is a read-only shadow with no Session, Thread or Main Thread', async () => {
  const w = threadWorld()
  await w.rt.load()
  await w.rt.setFederationLevel('roster')
  assert.equal(await applyPeerRoster(w.rt, report()), true)
  const bot = w.rt.state.bots[peerId('hub-a', 'b1')]
  assert.equal(bot.id, peerId('hub-a', 'b1'))
  assert.equal(bot.origin, 'peer')
  assert.equal(bot.type, 'remote-worker')
  assert.equal(bot.readonly, true)
  assert.equal(bot.worker.home, 'hub')
  assert.equal(bot.worker.hubId, 'hub-a')
  assert.equal(bot.worker.botId, 'b1')
  assert.equal(bot.worker.online, true)
  assert.equal(bot.worker.hostname, 'mac-b')
  // No Session of its own: the shadow must not be named as one.
  assert.equal(bot.sessionId, undefined)
  assert.equal(w.rt.chatOf(bot.id), bot.id)
  // No Main Thread, no thread list: migrateThreads skipped it.
  assert.equal(bot.threadIds, undefined)
  assert.deepEqual(threadsOfBot(w.rt.state, bot.id), [])
  assert.equal(Object.values(w.rt.state.threads).some(thread => thread.botId === bot.id), false)
  // The channel view names it read-only and gives it no Session id.
  const view = await w.call('state')
  const seen = view.value.bots.find(row => row.id === bot.id)
  assert.equal(seen.sessionId, null)
  assert.equal(seen.origin, 'peer')
  assert.equal(seen.worker.online, true)
})

test('the same report twice keeps one row and its createdAt', async () => {
  const w = threadWorld()
  await w.rt.load()
  await applyPeerRoster(w.rt, report())
  const first = w.rt.state.bots[peerId('hub-a', 'b1')]
  const createdAt = first.createdAt
  await new Promise(resolve => setTimeout(resolve, 5))
  await applyPeerRoster(w.rt, report())
  const again = w.rt.state.bots[peerId('hub-a', 'b1')]
  assert.equal(again.createdAt, createdAt)
  assert.equal(again.worker.lastSeen >= first.worker.lastSeen, true)
  const peers = Object.values(w.rt.state.bots).filter(bot => bot.origin === 'peer')
  assert.equal(peers.length, 2)
})

test('a Bot missing from one report is offline at once, kept for eleven reports, gone on the twelfth', async () => {
  const w = threadWorld()
  await w.rt.load()
  await applyPeerRoster(w.rt, report())
  const id = peerId('hub-a', 'b2')
  // b2 is not named from here on; it must not vanish on one lost frame.
  for (let frame = 1; frame < MISSING_FRAMES; frame += 1) {
    await applyPeerRoster(w.rt, report({ bots: [{ id: 'b1', name: 'Bravo', role: 'Engineer' }] }))
    assert.equal(w.rt.state.bots[id] !== undefined, true, `still there after ${frame} missing reports`)
    assert.equal(w.rt.state.bots[id].worker.online, false)
    assert.equal(w.rt.state.bots[id].worker.missingFromReport, true)
    assert.equal(w.rt.state.bots[id].worker.missingFrames, frame)
  }
  await applyPeerRoster(w.rt, report({ bots: [{ id: 'b1', name: 'Bravo', role: 'Engineer' }] }))
  assert.equal(w.rt.state.bots[id], undefined)
})

test('a Bot that comes back resets its missing count', async () => {
  const w = threadWorld()
  await w.rt.load()
  await applyPeerRoster(w.rt, report())
  const id = peerId('hub-a', 'b2')
  for (let frame = 0; frame < 5; frame += 1) {
    await applyPeerRoster(w.rt, report({ bots: [{ id: 'b1', name: 'Bravo', role: 'Engineer' }] }))
  }
  assert.equal(w.rt.state.bots[id].worker.missingFrames, 5)
  await applyPeerRoster(w.rt, report())
  assert.equal(w.rt.state.bots[id].worker.online, true)
  assert.equal(w.rt.state.bots[id].worker.missingFrames, 0)
  assert.equal(w.rt.state.bots[id].worker.missingFromReport, false)
})

test('a malformed report is dropped whole, never half applied', async () => {
  const w = threadWorld()
  await w.rt.load()
  const before = Object.keys(w.rt.state.bots).length
  // One bad Bot invalidates the frame: no row from this report is mirrored.
  const ok = await handlePeerRoster(w.rt, {
    hubId: 'hub-a', level: 'roster', bots: [{ id: 'b1', name: 'Bravo', role: 'Engineer' }, { id: '', name: 'X', role: 'Y' }],
  })
  assert.equal(ok, false)
  assert.equal(Object.keys(w.rt.state.bots).length, before)
  assert.equal(Object.values(w.rt.state.bots).filter(bot => bot.origin === 'peer').length, 0)
})

test('the validator keeps the agreed limits and drops duplicate ids after the first', () => {
  assert.equal(sanitizePeerRoster({ hubId: 'hub-a', level: 'roster', bots: [] }).ok, true)
  assert.equal(sanitizePeerRoster({ hubId: '', level: 'roster', bots: [] }).ok, false)
  assert.equal(sanitizePeerRoster({ hubId: 'has space', level: 'roster', bots: [] }).ok, false)
  assert.equal(sanitizePeerRoster({ hubId: 'hub-a', level: 'nope', bots: [] }).ok, false)
  assert.equal(sanitizePeerRoster({ hubId: 'hub-a', level: 'roster', bots: 'x' }).ok, false)
  const many = Array.from({ length: 65 }, (_, index) => ({ id: `b${index}`, name: 'B', role: 'R' }))
  assert.equal(sanitizePeerRoster({ hubId: 'hub-a', level: 'roster', bots: many }).ok, false)
  const checked = sanitizePeerRoster({
    hubId: ' hub-a ',
    level: 'groups',
    hostname: 'h'.repeat(100),
    bots: [
      { id: 'b1', name: 'First', role: 'R' },
      { id: 'b1', name: 'Second', role: 'R' },
      { id: 'b2', name: 'N'.repeat(60), role: 'R'.repeat(80), model: 'm'.repeat(200) },
    ],
  })
  assert.equal(checked.ok, true)
  assert.equal(checked.value.hubId, 'hub-a')
  assert.equal(checked.value.hostname.length, 80)
  assert.equal(checked.value.bots.length, 2)
  assert.equal(checked.value.bots[0].name, 'First')
  assert.equal(checked.value.bots[1].name.length, 40)
  assert.equal(checked.value.bots[1].role.length, 24)
  assert.equal(checked.value.bots[1].model.length, 120)
})

test('a shadow is never treated as a local Bot by the team surfaces', async () => {
  const w = threadWorld()
  await w.rt.load()
  await makeBot(w, 'Alpha')
  await applyPeerRoster(w.rt, report())
  const id = peerId('hub-a', 'b1')
  // The data layer says peer, not local: joinedShadow() and kind checks agree.
  assert.equal(toBotRecord(w.rt.state.bots[id]).kind, 'peer')
  assert.equal(w.rt.isMain(id), false)
  // Not a Main Bot in the view, and the team tool names it read-only on its machine.
  const view = await w.call('state')
  const row = view.value.bots.find(bot => bot.id === id)
  assert.equal(row.sessionId, null)
  assert.equal(view.value.mainBotIds.includes(id), false)
  const listBots = w.rt.teamTools.find(tool => tool.name === 'list_bots')
  const text = await listBots.execute({}, { agent: { id: undefined } })
  assert.match(text, /Bravo/)
  assert.match(text, /read-only, on mac-b/)
  // Nothing selected a model on a Session the shadow does not have.
  assert.equal(w.selections.some(selection => selection.sessionId === id), false)
})

test('A local Bot is still listed as a local Bot next to a shadow', async () => {
  const w = threadWorld()
  const bot = await makeBot(w, 'Alpha')
  await applyPeerRoster(w.rt, report())
  const tool = w.rt.teamTools.find(entry => entry.name === 'list_bots')
  const text = await tool.execute({}, { agent: { id: undefined } })
  assert.match(text, /Alpha/)
  assert.equal(Object.hasOwn(w.rt.state.bots, bot.id), true)
  assert.equal(w.rt.state.bots[peerId('hub-a', 'b1')].origin, 'peer')
})
