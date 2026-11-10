// s50 / merge plan I9 (R2): upstream v0.3.2 renames the stored local-CLI routes at load
// (store.js migrateLocalRoutes: `claude-code/x` → `local-claude-code/x`, appliedModel dropped).
// A joined (remote) Bot's `model` is a ref ON THE NODE — the node may be older and know only the old
// name — so the migration must leave it alone, while a local Bot is migrated as upstream intends.
// Written BEFORE the merge: on fork.76 there is no migrateLocalRoutes, so every case here is red;
// after the merge the joined-shadow cases stay red until the migration skips shadows.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/store.js'
import * as store from '../src/host/store.js'

const joinedShadow = (id, model, extra = {}) => ({
  id, name: id, origin: 'joined', type: 'remote-worker', model, appliedModel: model,
  worker: { nodeId: 'n1', remoteBotId: id.split(':').at(-1), home: 'remote', online: true },
  capabilities: [], ...extra,
})
const localBot = (id, model, extra = {}) => ({ id, name: id, model, appliedModel: model, capabilities: [], ...extra })

function stateWith(bots) {
  return { version: 1, mainBotIds: [], bots: Object.fromEntries(bots.map(b => [b.id, b])), rooms: {}, localAgents: { sessions: {} } }
}

test('M-migrate-present: the merged store exports migrateLocalRoutes (upstream behaviour is in)', () => {
  assert.equal(typeof store.migrateLocalRoutes, 'function')
})

test('M-migrate-joined: a joined shadow keeps its model and appliedModel — claude-code, codex-cli and opencode/default alike', () => {
  const shadows = [
    joinedShadow('joined:n1:a', 'claude-code/sonnet'),
    joinedShadow('joined:n1:b', 'codex-cli/gpt-5'),
    joinedShadow('joined:n1:c', 'opencode/default'),
  ]
  const state = stateWith(shadows)
  const before = JSON.stringify(state.bots)
  store.migrateLocalRoutes(state)
  assert.equal(JSON.stringify(state.bots), before, 'not one byte of a shadow changed')
})

test('M-migrate-local: a local Bot IS migrated as upstream intends — the ref moves under local-, appliedModel is dropped', () => {
  const state = stateWith([localBot('l1', 'claude-code/sonnet'), localBot('l2', 'codex-cli/gpt-5'), localBot('l3', 'opencode/default')])
  assert.equal(store.migrateLocalRoutes(state), true)
  assert.equal(state.bots.l1.model, 'local-claude-code/sonnet')
  assert.equal(state.bots.l2.model, 'local-codex-cli/gpt-5')
  assert.equal(state.bots.l3.model, 'local-opencode/default')
  for (const id of ['l1', 'l2', 'l3']) assert.equal('appliedModel' in state.bots[id], false, `${id}: applied model dropped`)
})

test('M-migrate-mixed: a local Bot and a shadow side by side — only the local one moves', () => {
  const state = stateWith([localBot('l1', 'claude-code/sonnet'), joinedShadow('joined:n1:a', 'claude-code/sonnet')])
  store.migrateLocalRoutes(state)
  assert.equal(state.bots.l1.model, 'local-claude-code/sonnet')
  assert.equal(state.bots['joined:n1:a'].model, 'claude-code/sonnet')
  assert.equal(state.bots['joined:n1:a'].appliedModel, 'claude-code/sonnet')
})

test('M-migrate-load: the same through the real load() of the store, from a saved team file, and the migrated team is written back without touching the shadow', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-migrate-'))
  const statePath = join(home, 'state.json')
  fs.writeFileSync(statePath, JSON.stringify(stateWith([localBot('l1', 'claude-code/sonnet'), joinedShadow('joined:n1:a', 'claude-code/sonnet')])))
  const rt = { ctx: { logger: { warn() {} }, effect() {} }, home, statePath, autoRoomName: () => 'Room', retitleRoom: async () => {}, warn() {} }
  install(rt)
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  await rt.load()
  assert.equal(rt.state.bots.l1.model, 'local-claude-code/sonnet')
  assert.equal(rt.state.bots['joined:n1:a'].model, 'claude-code/sonnet')
  await rt.save()
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(saved.bots['joined:n1:a'].model, 'claude-code/sonnet')
  assert.equal(saved.bots['joined:n1:a'].appliedModel, 'claude-code/sonnet')
})
