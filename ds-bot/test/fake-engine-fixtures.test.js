// DS-3 carryover criterion 1: every tracked fake-engine fixture runs through a real
// LocalAgentAdapter and engine with zero validation warnings, and its ordered chunk
// sequence equals the oracle captured at d841f6f4 (before screenEvent existed; capture
// script and output kept outside the repo, sha256 of the capture
// 4855e244eb29a2ebc13f5608a5434cf0aad458df4f619ea3a2f1eac0ea0eb8a8). Fixtures that need
// scenario arguments beyond the defaults are covered by local-agents.test.js.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'

const DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'dsb-fx-'))
// Not engines: listed so a new fixture cannot be skipped silently.
const NOT_ENGINES = { 'echo-argv-env': 'argv/env echo helper', 'gateway-egress': 'gateway egress probe server', 'self-signed': 'TLS certificate helper', 'im-view-crash': 'IM view crash helper' }
// fixture -> [engine kind, route, default args]
const ROUTES = {
  'counting-acp': ['acp', 'local-acp-fake', () => [join(tmp(), 'count')]],
  'fake-acp': ['acp', 'local-acp-fake', () => []],
  'fake-claude': ['claude', 'local-claude-code', () => []],
  'fake-claude-dead': ['claude', 'local-claude-code', () => []],
  'fake-claude-flaky': ['claude', 'local-claude-code', () => [join(tmp(), 'runs'), '']],
  'fake-claude-lazy-init': ['claude', 'local-claude-code', () => []],
  'fake-claude-resume-safety': ['claude', 'local-claude-code', () => [tmp(), 'ok', '']],
  'fake-codex': ['codex', 'local-codex-cli', () => []],
  'fake-local-startup': ['acp', 'local-acp-fake', () => []],
}
// 'fake-local-startup' is a handshake fixture, no content stream.
const ORACLE = {
 "counting-acp": {
  "chunks": [
   {
    "type": "block-start",
    "index": 0,
    "blockType": "reasoning"
   },
   {
    "type": "reasoning-delta",
    "index": 0,
    "text": "thought about: The conversation so far (oldest first):\n"
   },
   {
    "type": "reasoning-delta",
    "index": 0,
    "text": "▸ Read src/a.js\n"
   },
   {
    "type": "reasoning-delta",
    "index": 0,
    "text": "▸ Run `npm test`\n"
   },
   {
    "type": "block-end",
    "index": 0,
    "block": {
     "type": "reasoning",
     "text": "thought about: The conversation so far (oldest first):\n▸ Read src/a.js\n▸ Run `npm test`\n"
    }
   },
   {
    "type": "block-start",
    "index": 1,
    "blockType": "text"
   },
   {
    "type": "text-delta",
    "index": 1,
    "text": "ok: The conversation so far (oldest first):\n\nUser: hello there"
   },
   {
    "type": "block-end",
    "index": 1,
    "block": {
     "type": "text",
     "text": "ok: The conversation so far (oldest first):\n\nUser: hello there"
    }
   },
   {
    "type": "usage",
    "usage": {
     "inputTokens": 5020,
     "outputTokens": 30,
     "cacheReadTokens": 9000
    }
   },
   {
    "type": "finish",
    "reason": {
     "kind": "stop"
    }
   }
  ]
 },
 "fake-acp": {
  "chunks": [
   {
    "type": "block-start",
    "index": 0,
    "blockType": "reasoning"
   },
   {
    "type": "reasoning-delta",
    "index": 0,
    "text": "thought about: The conversation so far (oldest first):\n"
   },
   {
    "type": "reasoning-delta",
    "index": 0,
    "text": "▸ Read src/a.js\n"
   },
   {
    "type": "reasoning-delta",
    "index": 0,
    "text": "▸ Run `npm test`\n"
   },
   {
    "type": "block-end",
    "index": 0,
    "block": {
     "type": "reasoning",
     "text": "thought about: The conversation so far (oldest first):\n▸ Read src/a.js\n▸ Run `npm test`\n"
    }
   },
   {
    "type": "block-start",
    "index": 1,
    "blockType": "text"
   },
   {
    "type": "text-delta",
    "index": 1,
    "text": "ok: The conversation so far (oldest first):\n\nUser: hello there"
   },
   {
    "type": "block-end",
    "index": 1,
    "block": {
     "type": "text",
     "text": "ok: The conversation so far (oldest first):\n\nUser: hello there"
    }
   },
   {
    "type": "usage",
    "usage": {
     "inputTokens": 5020,
     "outputTokens": 30,
     "cacheReadTokens": 9000
    }
   },
   {
    "type": "finish",
    "reason": {
     "kind": "stop"
    }
   }
  ]
 },
 "fake-claude": {
  "chunks": [
   {
    "type": "block-start",
    "index": 0,
    "blockType": "reasoning"
   },
   {
    "type": "reasoning-delta",
    "index": 0,
    "text": "thought about: The conversation so far (oldest first):\n"
   },
   {
    "type": "reasoning-delta",
    "index": 0,
    "text": "▸ Read\n"
   },
   {
    "type": "block-end",
    "index": 0,
    "block": {
     "type": "reasoning",
     "text": "thought about: The conversation so far (oldest first):\n▸ Read\n"
    }
   },
   {
    "type": "block-start",
    "index": 1,
    "blockType": "text"
   },
   {
    "type": "text-delta",
    "index": 1,
    "text": "ok: The conversation so far (oldest first):\n\nUser: hello there"
   },
   {
    "type": "block-end",
    "index": 1,
    "block": {
     "type": "text",
     "text": "ok: The conversation so far (oldest first):\n\nUser: hello there"
    }
   },
   {
    "type": "usage",
    "usage": {
     "inputTokens": 10,
     "outputTokens": 5
    }
   },
   {
    "type": "finish",
    "reason": {
     "kind": "stop"
    }
   }
  ]
 },
 "fake-claude-dead": {
  "error": "LOCAL_AGENT_EXIT"
 },
 "fake-claude-flaky": {
  "chunks": [
   {
    "type": "block-start",
    "index": 0,
    "blockType": "text"
   },
   {
    "type": "text-delta",
    "index": 0,
    "text": "ok: The conversation so far (oldest first):\n\nUser: hello there resume=none"
   },
   {
    "type": "block-end",
    "index": 0,
    "block": {
     "type": "text",
     "text": "ok: The conversation so far (oldest first):\n\nUser: hello there resume=none"
    }
   },
   {
    "type": "usage",
    "usage": {
     "inputTokens": 3,
     "outputTokens": 1
    }
   },
   {
    "type": "finish",
    "reason": {
     "kind": "stop"
    }
   }
  ]
 },
 "fake-claude-lazy-init": {
  "chunks": [
   {
    "type": "block-start",
    "index": 0,
    "blockType": "text"
   },
   {
    "type": "text-delta",
    "index": 0,
    "text": "ok: The conversation so far (oldest first):\n\nUser: hello there resume=none"
   },
   {
    "type": "block-end",
    "index": 0,
    "block": {
     "type": "text",
     "text": "ok: The conversation so far (oldest first):\n\nUser: hello there resume=none"
    }
   },
   {
    "type": "usage",
    "usage": {
     "inputTokens": 3,
     "outputTokens": 1
    }
   },
   {
    "type": "finish",
    "reason": {
     "kind": "stop"
    }
   }
  ]
 },
 "fake-claude-resume-safety": {
  "chunks": [
   {
    "type": "block-start",
    "index": 0,
    "blockType": "text"
   },
   {
    "type": "text-delta",
    "index": 0,
    "text": "success-1-1"
   },
   {
    "type": "block-end",
    "index": 0,
    "block": {
     "type": "text",
     "text": "success-1-1"
    }
   },
   {
    "type": "finish",
    "reason": {
     "kind": "stop"
    }
   }
  ]
 },
 "fake-codex": {
  "chunks": [
   {
    "type": "block-start",
    "index": 0,
    "blockType": "reasoning"
   },
   {
    "type": "reasoning-delta",
    "index": 0,
    "text": "▸ ls\n"
   },
   {
    "type": "block-end",
    "index": 0,
    "block": {
     "type": "reasoning",
     "text": "▸ ls\n"
    }
   },
   {
    "type": "block-start",
    "index": 1,
    "blockType": "text"
   },
   {
    "type": "text-delta",
    "index": 1,
    "text": "ok: The conversation so far (oldest first):\n\nUser: hello there effort=none"
   },
   {
    "type": "usage",
    "usage": {
     "inputTokens": 13506,
     "outputTokens": 6,
     "cacheReadTokens": 12288
    }
   },
   {
    "type": "block-end",
    "index": 1,
    "block": {
     "type": "text",
     "text": "ok: The conversation so far (oldest first):\n\nUser: hello there effort=none"
    }
   },
   {
    "type": "finish",
    "reason": {
     "kind": "stop"
    }
   }
  ]
 },
 "fake-local-startup": {
  "chunks": [
   {
    "type": "finish",
    "reason": {
     "kind": "stop"
    }
   }
  ]
 }
}

const isEngine = name => name.endsWith('.mjs') && (name.startsWith('fake-') || name === 'counting-acp.mjs')
const discovered = readdirSync(DIR).filter(isEngine).map(name => name.slice(0, -4)).sort()

test('15 fixture discovery matches the oracle table and git', () => {
  assert.deepEqual(discovered, Object.keys(ORACLE).sort())
  assert.deepEqual(Object.keys(ROUTES).sort(), Object.keys(ORACLE).sort())
  const all = readdirSync(DIR).filter(name => name.endsWith('.mjs')).map(name => name.slice(0, -4))
  for (const name of all) assert.ok(discovered.includes(name) || name in NOT_ENGINES, `fixture ${name} is neither an engine with an oracle nor a listed non-engine`)
  try {
    const tracked = execFileSync('git', ['ls-files', DIR], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')
      .filter(line => line.endsWith('.mjs')).map(line => line.split('/').pop().slice(0, -4))
    for (const name of tracked) assert.ok(discovered.includes(name) || name in NOT_ENGINES, `tracked fixture ${name} has no oracle`)
  } catch (error) { if (error?.name === 'AssertionError') throw error }
})

for (const name of Object.keys(ORACLE)) {
  test(`15 ${name}: zero validation warnings and the exact ordered chunk sequence`, async () => {
    const [kind, route, args] = ROUTES[name]
    const warns = []
    const adapter = new LocalAgentAdapter({
      rt: { warn: message => warns.push(String(message)) },
      customAgents: () => [{ id: 'fake', name: 'Fake', command: 'x', args: [] }],
      findExecutable: path => path,
      spawnEngine: (_kind, engineRoute, spec) => {
        const Engine = { acp: AcpEngine, codex: CodexEngine, claude: ClaudeEngine }[kind]
        return new Engine(engineRoute, { ...spec, command: process.execPath, args: [join(DIR, name + '.mjs'), ...args()] }, { findExecutable: path => path })
      },
      record: () => undefined, saveRecord: () => {}, presetFor: () => 'workspace-write',
      cwdFor: async () => tmp(), probeCwd: () => tmp(), toolsFor: () => [],
    })
    const chunks = []
    let failure
    try {
      const stream = adapter.stream({ provider: route, model: 'default', sessionId: 's1', messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } }], tools: [], signal: AbortSignal.timeout(20_000) })
      for await (const chunk of stream) chunks.push(chunk)
    } catch (error) { failure = error } finally {
      for (const live of [...adapter.live.values()]) await adapter.closeLive(live, { idle: true }).catch(() => {})
      await adapter.dispose?.()
    }
    assert.deepEqual(warns, [], 'no validation warning')
    assert.ok(adapter.eventDiscards === undefined || adapter.eventDiscards === 0, 'no discarded event')
    const expected = ORACLE[name]
    if (expected.error !== undefined) {
      assert.equal(failure?.code, expected.error)
      assert.deepEqual(chunks, [])
    } else {
      assert.equal(failure, undefined, String(failure))
      assert.deepEqual(chunks, expected.chunks)
    }
  })
}
