// s50 / merge plan I1 (R8): upstream v0.3.2 added modules (groupLog, local-agent engines); this fork added
// joinedTurn/joinedPrompt/mirrorGuard/joinedCreate/configSource/joinedPage/hostContext. The merged MODULES list must
// keep every module exactly once, in an order where each wrapper installs after what it wraps, and the real
// createRuntime must come up with both halves' runtime surface (upstream's abandonWork/saveSection/adoptLiveWork
// next to this fork's joined takeover). Real createRuntime, no stand-in module list.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRuntime, MODULES } from '../index.js'
import * as turns from '../src/host/turns.js'
import * as steer from '../src/host/steer.js'
import * as handoffs from '../src/host/handoffs.js'
import * as delivery from '../src/host/delivery.js'
import * as rosterJoin from '../src/host/roster-join.js'
import * as roster from '../src/host/roster.js'
import * as groups from '../src/host/groups.js'
import * as groupLog from '../src/host/group-log.js'
import * as goals from '../src/host/goals.js'
import * as channel from '../src/host/channel.js'
import * as store from '../src/host/store.js'
import * as memory from '../src/host/memory.js'
import * as joinedTurn from '../src/host/joined-turn.js'
import * as joinedPrompt from '../src/host/joined-prompt.js'
import * as mirrorGuard from '../src/host/mirror-guard.js'
import * as joinedCreate from '../src/host/joined-create.js'
import * as configSource from '../src/host/config-source.js'
import * as joinedPage from '../src/host/joined-page.js'
import * as localAgents from '../src/host/local-agents/index.js'
import { fakeContext } from './fake-ctx.js'

const at = module => MODULES.indexOf(module)

describe('S50-modules: the merged install order', () => {
  it('M-mod-once: every module of both sides is installed exactly once', () => {
    for (const [name, module] of Object.entries({ turns, steer, handoffs, delivery, rosterJoin, roster, groups, groupLog, goals, channel, store, memory, joinedTurn, joinedPrompt, mirrorGuard, joinedCreate, configSource, joinedPage, localAgents })) {
      assert.equal(MODULES.filter(item => item === module).length, 1, `${name} appears once`)
    }
    assert.equal(new Set(MODULES).size, MODULES.length, 'no module twice')
    assert.ok(MODULES.every(module => typeof module.install === 'function'), 'every entry has install()')
  })

  it('M-mod-order: wrappers install after what they wrap, groupLog follows groups, the store comes first', () => {
    assert.ok(at(groupLog) > at(groups), 'groupLog (upstream) installs after groups')
    assert.ok(at(store) < at(turns) && at(store) < at(roster) && at(store) < at(channel), 'the store is up before anything reads state')
    assert.ok(at(turns) < at(steer) && at(handoffs) < at(delivery), 'turns before steer, handoffs before delivery')
    assert.ok(at(delivery) < at(roster), 'delivery (joined interception) before roster')
    assert.ok(at(rosterJoin) < at(roster), 'rosterJoin before roster')
    assert.ok(at(channel) < at(joinedTurn) && at(joinedTurn) < at(joinedPrompt) && at(joinedPrompt) < at(mirrorGuard), 'channel, joinedTurn, joinedPrompt, mirrorGuard in that order')
    assert.ok(at(joinedPrompt) > at(turns), 'joinedPrompt wraps turns, not the other way round')
    assert.ok(at(mirrorGuard) < at(joinedCreate) && at(joinedCreate) < at(configSource) && at(configSource) < at(joinedPage), 'the node-side modules follow in order')
    assert.ok(at(memory) > at(groups), 'memory after groups (the group review reads rooms)')
  })

  it('M-mod-surface: the real runtime carries upstream\'s and this fork\'s surface together', () => {
    const home = mkdtempSync(join(tmpdir(), 'ds-bot-merge-mod-'))
    const rt = createRuntime(fakeContext(), { home })
    for (const name of ['abandonWork', 'adoptLiveWork', 'saveSection', 'reorderSections', 'deleteSection', 'deliver', 'openWork', 'noteCutOffTurn', 'fileMemoryFor']) {
      assert.equal(typeof rt[name], 'function', `rt.${name}`)
    }
    assert.ok(rt.fileMemoryTools !== undefined, 'rt.fileMemoryTools')
    assert.equal(rt.botHomeEnabled, true)
  })
})
