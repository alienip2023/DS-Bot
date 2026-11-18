# s6-3: reject node Bot writes without a cluster identity

Date: 2026-11-18. Worktree: `/private/tmp/wt-s6-3`. Branch: `feat/s6-3-bot-scope-reject`. Starting HEAD: `f915e61fd1d7fc65f57576b49c5522ec07393507`.

## Result and code choice

A node-originated `scope: 'bot'` write whose roster shadow has no nonblank `clusterBotId` now returns `{ ok: false, seq, error: 'memory/refused' }` before resolving a scope or calling the file writer. The node tool throws `memory/refused` with: `The hub refused the change. A "bot" write requires clusterBotId on the hub roster. Nothing was saved.`

Chose existing `CODES.refused` (`memory/refused`): this is an intentional rejection of a write that cannot be placed. The Bot is still on the roster and has permission to write its own memory. `notOnRoster` would misidentify it as missing; `denied` would imply a permission or invalid-operation problem. `failed` represents a write that broke and is nonterminal, so it would leave an unplaceable request blocking the outbox.

Checked every existing use of the chosen code in `src/host/memory-federation.js`: `CODES` definition (:78), `HUB_MESSAGES` (:65), `TERMINAL_CODES` (:47–51), content validation in `writeFrame` (now :305), and panel `add` (now :527). Also checked `errorCode` (:265–275), which passes memory codes through; `onWrite` (now :376–408), which records only successful replies; `nodeFailure` (now :632), `nodeWrite` (now :774), `nodeRead` (now :794), and `nodeDrain` (now :849). A refusal is terminal and dequeues on replay, preserving the existing caller contract.

Checked node/hub callers in `src/host/memory.js`: `REFUSED`/:118 distinguishes rejection from `FAILED`; `federationRemember`/:1395 and `federationForget`/:1429 preserve memory codes and messages (catch paths :1423–1425 and :1448–1450). The memory tools are registered by memory.js. Searched `src/host/tools.js` and `src/host/bot-network.js`: neither interprets this code or handles the memory write-result frame. The hub fake routes `mem/write` through the real `memoryWrite` registry handler and returns its actual `mem/write-result`.

## Changes

Paths below are relative to the worktree root.

- `ds-bot/src/host/memory-federation.js:295`: guard missing/blank `clusterBotId` before the legacy resolver fallback; applies to add/replace/forget on the node write path. The resolver is also used for reads, so the guard is deliberately write-only; existing reads, own scopes and node scopes retain their behavior.
- `ds-bot/src/host/memory-federation.js:632` and `:774`: supply write scope to node error formatting and add the cluster identity requirement hint only for `bot` + `memory/refused`. No frame fields, codes or protocol versions added.
- `ds-bot/test/memory-bot-scope-reject.test.js:9`: harness copied from `memory-node-bot-scope.test.js`, reusing `hub`, `rosterFor`, `fakeLink`, and `startNode`.
- `ds-bot/test/memory-bot-scope-reject.test.js:29`: assert actual directory, file contents, resolved journal scope and sequence on successful writes.
- Tests at `:40`, `:48`, `:67`, `:75`: cluster identity success; id-less refusal with error text, no per-node Bot directory, unchanged sequence, empty inbox/outbox; unchanged own write; unchanged node write.
- `dev/s6-3-report.md`: this requested report is the only file outside the two named implementation/test files.

No changes to memory.js, roster.js, bot-network.js, tools.js, dependencies, versions, frames or generated client files. `PROTOCOL_VERSION = 1`, `ACCEPT_WAIT_MS = 60_000`, and `JOINED_TURN_TIMEOUT_MS = 600_000` remain unchanged. No commits, pushes, installs or service restarts.

## Verification setup and limits

The supplied commands use plugin-relative paths, but the supplied cwd is the repository root. Those exact root commands were attempted and their path errors are recorded below. Effective test cwd is `/private/tmp/wt-s6-3/ds-bot`.

The raw plugin command cannot resolve `@deepseek-ai/dsh-llm`; used the existing `--import ./test/harness-resolve.mjs` loader without installing packages. An initial harness run exposed test assertions using `scopeKey` instead of the remote `logKeyOf`; corrected those assertions before the canonical knife. That initial run also fell back to the machine's DSH gateway settings and hit EADDRINUSE. All canonical red/green runs below isolate home lookup and DSH_HOME with a process-local preload, choose ephemeral test gateway ports, and remove their temporary home directories at process exit. The `~` in captured canonical logs represents the mocked temporary home, not the user's home. Runtime helpers dispose their test gateways, and the test processes have exited.

For every canonical red/green test command below, the exact additional environment was:

```sh
export NODE_OPTIONS='--import=data:text/javascript,import%20os%20from%20%22node%3Aos%22%3Bimport%20%7BsyncBuiltinESMExports%7D%20from%20%22node%3Amodule%22%3Bimport%20%7BmkdtempSync%2CrmSync%7D%20from%20%22node%3Afs%22%3Bconst%20home%3DmkdtempSync(os.tmpdir()%2B%22%2Fds-bot-s6-3-%22)%3Bos.homedir%3D()%3D%3Ehome%3BsyncBuiltinESMExports()%3Bprocess.env.DSH_HOME%3Dhome%3Bprocess.env.DS_BOT_GATEWAY_PORT%3D%220%22%3Bprocess.on(%22exit%22%2C()%3D%3ErmSync(home%2C%7Brecursive%3Atrue%2Cforce%3Atrue%7D))%3B'
```

The data URL decodes to this test-only setup (no repository file added):

```js
import os from "node:os";import {syncBuiltinESMExports} from "node:module";import {mkdtempSync,rmSync} from "node:fs";const home=mkdtempSync(os.tmpdir()+"/ds-bot-s6-3-");os.homedir=()=>home;syncBuiltinESMExports();process.env.DSH_HOME=home;process.env.DS_BOT_GATEWAY_PORT="0";process.on("exit",()=>rmSync(home,{recursive:true,force:true}));
```

The requested `test/memory-federation.test.js` does not exist. Listed test files and ran the closest named suite, `test/memory-federation-guard.test.js`, plus `test/memory-hub.test.js` to exercise actual hub writes. Also ran node tool/outbox callers because error-code retry semantics determine the code choice.

No full `npm test`, package installation, smoke bench, or service restart was run. The full suite was explicitly prohibited; the smoke bench would start an additional DSH instance and was outside the requested focused verification.

## Red knife and restore check

The production source was never changed during the knife: only the new test was added. The canonical knife failed specifically because the id-less bot write created `memory/nodes/n1/bots/`. Other three cases passed. SHA-256 command, cwd `/private/tmp/wt-s6-3/ds-bot`:

```sh
shasum -a 256 src/host/memory-federation.js
```

Before knife (exit 0):

```text
dcb7a2d30f29260a3088881d4651c95072b3f6b5f3c63682e473bd8e4095250e  src/host/memory-federation.js
```

After knife, before fix (exit 0):

```text
dcb7a2d30f29260a3088881d4651c95072b3f6b5f3c63682e473bd8e4095250e  src/host/memory-federation.js
```

Hashes match. No source rollback was necessary because the source was still the original HEAD during the knife.

## Canonical red knife: 3 pass, 1 fail

Cwd: `/private/tmp/wt-s6-3/ds-bot`

Command:

```sh
node --import ./test/harness-resolve.mjs --test --test-force-exit --test-timeout=120000 test/memory-bot-scope-reject.test.js
```

Exit: 1. Exact combined stdout/stderr as a JSON array of lines (join with newline to reproduce whitespace exactly):

```json
[
  "[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~",
  "[ds-bot] ds-bot: gateway config host=(default) port=0 from=env",
  "[ds-bot] ds-bot: gateway listening on 127.0.0.1:63857",
  "[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~",
  "[ds-bot] ds-bot: gateway config host=(default) port=0 from=env",
  "[ds-bot] ds-bot: gateway listening on 127.0.0.1:63858",
  "[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~",
  "[ds-bot] ds-bot: gateway config host=(default) port=0 from=env",
  "[ds-bot] ds-bot: gateway listening on 127.0.0.1:63859",
  "✔ bot scope with clusterBotId writes only to the cluster identity (99.6285ms)",
  "[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~",
  "[ds-bot] ds-bot: gateway config host=(default) port=0 from=env",
  "[ds-bot] ds-bot: gateway listening on 127.0.0.1:63860",
  "[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~",
  "[ds-bot] ds-bot: gateway config host=(default) port=0 from=env",
  "✖ bot scope without clusterBotId refuses the write without creating node Bot memory (14.139708ms)",
  "[ds-bot] ds-bot: gateway listening on 127.0.0.1:63861",
  "[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~",
  "[ds-bot] ds-bot: gateway config host=(default) port=0 from=env",
  "[ds-bot] ds-bot: gateway listening on 127.0.0.1:63862",
  "[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~",
  "[ds-bot] ds-bot: gateway config host=(default) port=0 from=env",
  "[ds-bot] ds-bot: gateway listening on 127.0.0.1:63863",
  "✔ own scope without clusterBotId still writes to the node Bot directory (14.678041ms)",
  "[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~",
  "[ds-bot] ds-bot: gateway config host=(default) port=0 from=env",
  "[ds-bot] ds-bot: gateway listening on 127.0.0.1:63864",
  "✔ node scope without clusterBotId still writes to the node directory (12.352916ms)",
  "ℹ tests 4",
  "ℹ suites 0",
  "ℹ pass 3",
  "ℹ fail 1",
  "ℹ cancelled 0",
  "ℹ skipped 0",
  "ℹ todo 0",
  "ℹ duration_ms 284.169375",
  "",
  "✖ failing tests:",
  "",
  "test at test/memory-bot-scope-reject.test.js:48:1",
  "✖ bot scope without clusterBotId refuses the write without creating node Bot memory (14.139708ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "  ",
  "  true !== false",
  "  ",
  "      at TestContext.<anonymous> (file:///private/tmp/wt-s6-3/ds-bot/test/memory-bot-scope-reject.test.js:55:10)",
  "      at async Test.run (node:internal/test_runner/test:1313:7)",
  "      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {",
  "    generatedMessage: true,",
  "    code: 'ERR_ASSERTION',",
  "    actual: true,",
  "    expected: false,",
  "    operator: 'strictEqual',",
  "    diff: 'simple'",
  "  }",
  ""
]
```

## Green regression suite: 4 pass, 0 fail

Cwd: `/private/tmp/wt-s6-3/ds-bot`

Command:

```sh
node --import ./test/harness-resolve.mjs --test --test-force-exit --test-timeout=120000 test/memory-bot-scope-reject.test.js
```

Exit: 0. Exact combined stdout/stderr:

```text
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63905
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63909
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63915
✔ bot scope with clusterBotId writes only to the cluster identity (107.567833ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63918
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63923
✔ bot scope without clusterBotId refuses the write without creating node Bot memory (16.550583ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63927
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63930
✔ own scope without clusterBotId still writes to the node Bot directory (18.460958ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63934
✔ node scope without clusterBotId still writes to the node directory (15.124792ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 307.837
```

## Combined scope suites: 11 pass, 1 fail

Cwd: `/private/tmp/wt-s6-3/ds-bot`

Command:

```sh
node --import ./test/harness-resolve.mjs --test --test-force-exit --test-timeout=120000 test/memory-bot-scope-reject.test.js test/memory-node-bot-scope.test.js
```

Exit: 1. Exact combined stdout/stderr:

```text
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63906
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63910
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63913
✔ bot scope with clusterBotId writes only to the cluster identity (106.93675ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63916
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63921
✔ bot scope without clusterBotId refuses the write without creating node Bot memory (15.341875ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63926
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63929
✔ own scope without clusterBotId still writes to the node Bot directory (17.918791ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63932
✔ node scope without clusterBotId still writes to the node directory (15.269209ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63907
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63914
✔ remember with bot scope sends mem/write with the same remoteBotId (106.268125ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63919
✔ recall with bot scope sends mem/read and labels cluster entries (10.969292ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63925
✔ cluster scope aliases are trimmed, unquoted and case-insensitive for reads and writes (11.69025ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63928
✔ a write without scope still sends own (7.040625ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63931
✔ recall without scope still reads own then team (7.332417ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63935
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63936
✔ team writes are refused locally without a frame or outbox entry, online or offline (14.125583ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63937
✔ unknown and named Bot scope messages explain bot cluster memory (5.364625ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63938
✖ the hub falls back to the node Bot directory when it has no cluster identity (14.119417ms)
ℹ tests 12
ℹ suites 0
ℹ pass 11
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 327.3495

✖ failing tests:

test at test/memory-node-bot-scope.test.js:108:1
✖ the hub falls back to the node Bot directory when it has no cluster identity (14.119417ms)
  Error [MemoryWriteError]: The hub refused the change. A "bot" write requires clusterBotId on the hub roster. Nothing was saved.
      at federationRemember (file:///private/tmp/wt-s6-3/ds-bot/src/host/memory.js:1424:11)
      at async execute (file:///private/tmp/wt-s6-3/ds-bot/src/host/memory.js:1524:88)
      at async TestContext.<anonymous> (file:///private/tmp/wt-s6-3/ds-bot/test/memory-node-bot-scope.test.js:125:16)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    code: 'memory/refused'
  }
```

The sole combined-run failure is the pre-existing test at `ds-bot/test/memory-node-bot-scope.test.js:108`, named "the hub falls back to the node Bot directory when it has no cluster identity". It requires the behavior this task removes. Left it untouched because only the new test and production file were authorized for code/test edits. The combined command therefore remains red; this is not an all-green claim.

## Available federation and hub suites

Cwd: `/private/tmp/wt-s6-3/ds-bot`

Command:

```sh
rg --files test | rg 'memory-(federation|hub).*test\.js$' | sort
```

Exit: 0. Exact combined stdout/stderr:

```text
test/memory-federation-guard.test.js
test/memory-hub-dedupe.test.js
test/memory-hub-model.test.js
test/memory-hub.test.js
```

## Fallback federation and hub suites: 15 pass, 0 fail

Cwd: `/private/tmp/wt-s6-3/ds-bot`

Command:

```sh
node --import ./test/harness-resolve.mjs --test --test-force-exit --test-timeout=120000 test/memory-federation-guard.test.js test/memory-hub.test.js
```

Exit: 0. Exact combined stdout/stderr:

```text
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63908
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63912
✔ the roster refuses the federated backend on a machine without a node identity (105.892459ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63917
✔ the tools refuse a federated Bot row on the hub itself and queue nothing (10.631042ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63922
✔ only a node offers the federated backend, and the preference switches it off (15.933291ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63904
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63911
✔ a node write lands in its own folder, steps the sequence once, and never the team log (103.764917ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63920
✔ a retried request is answered with the first result and written once (13.345042ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63924
✔ a node that writes the team memory is refused before a file or the sequence is touched (7.106417ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63933
✔ a Bot reads the team, its node and its own memory, and nothing of another Bot (22.1215ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63939
✔ a team change is pushed whole to every node, and an ack moves what that node applied (531.424583ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63940
✔ an over-budget snapshot keeps team, then node, then Bots, and says it was cut (9.330959ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63941
✔ the panel sees a remote scope in the same shape as the local memory panel (8.244ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63942
✔ a replace that matches more than one entry is refused as ambiguous, not guessed (10.329459ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
✔ a deleted remote Bot keeps its memory in the archive, and the node log says where (8.80425ms)
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63943
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63944
✔ an ack ahead of the hub sequence is clamped to it (8.288625ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63945
✔ a remote add writes its own folder and never the root MEMORY.md (8.583334ms)
✔ the panel counts every file of a scope and names a remote scope by its own key (13.089375ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 894.663458
```

## Node tool and outbox caller suites: 13 pass, 0 fail

Cwd: `/private/tmp/wt-s6-3/ds-bot`

Command:

```sh
node --import ./test/harness-resolve.mjs --test --test-force-exit --test-timeout=120000 test/memory-outbox.test.js test/memory-node-tools.test.js
```

Exit: 0. Exact combined stdout/stderr:

```text
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64045
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64048
✔ an online remember sends one mem/write with a requestId and waits for the hub (96.850542ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64049
✔ replace and forget map to the hub operations and keep their match text (10.024ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64050
✔ a node scope is named in the frame, and recall reads it back (7.159416ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64051
✔ recall sends the query and formats what the hub returns (5.473333ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64052
✔ recall with no scope reads your memory and the team memory (5.85725ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64053
✔ a node that is offline cannot answer a recall, and says so (6.222958ms)
✔ a topic is saved and read through the frame (5.88175ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64046
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64047
✔ offline writes wait in the outbox and go out in order once the link is back (95.075458ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64054
✔ a lost reply keeps the change queued and the retry reuses its requestId (52.731709ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64055
✔ a full outbox refuses the change and keeps what is already queued (5.898209ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64056
✔ a team write is refused before a frame or an outbox entry exists (6.261333ms)
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~
[ds-bot] ds-bot: gateway config host=(default) port=0 from=env
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64057
✔ a hub without memory-sync/1 fails closed instead of queueing (6.812625ms)
✔ a non-terminal refusal keeps the entry and a terminal one lets it go (6.412959ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 316.461417
```

## Effective syntax check

Cwd: `/private/tmp/wt-s6-3/ds-bot`

Command:

```sh
node --check src/host/memory-federation.js
```

Exit: 0. Exact combined stdout/stderr: empty.

```text
(no output)
```

## Whitespace check

Cwd: `/private/tmp/wt-s6-3`

Command:

```sh
git diff --check
```

Exit: 0. Exact combined stdout/stderr: empty.

```text
(no output)
```

## Literal requested root scope command

Cwd: `/private/tmp/wt-s6-3`

Command:

```sh
node --test --test-force-exit --test-timeout=120000 test/memory-bot-scope-reject.test.js test/memory-node-bot-scope.test.js
```

Exit: 1. Exact combined stdout/stderr:

```text
Could not find 'test/memory-bot-scope-reject.test.js, test/memory-node-bot-scope.test.js'
```

## Literal requested root federation command

Cwd: `/private/tmp/wt-s6-3`

Command:

```sh
node --test --test-force-exit --test-timeout=120000 test/memory-federation.test.js
```

Exit: 1. Exact combined stdout/stderr:

```text
Could not find 'test/memory-federation.test.js'
```

## Literal requested root syntax command

Cwd: `/private/tmp/wt-s6-3`

Command:

```sh
node --check src/host/memory-federation.js
```

Exit: 1. Exact combined stdout/stderr:

```text
node:internal/modules/cjs/loader:1503
  throw err;
  ^

Error: Cannot find module '/private/tmp/wt-s6-3/src/host/memory-federation.js'
    at node:internal/modules/cjs/loader:1500:15
    at node:internal/main/check_syntax:33:20 {
  code: 'MODULE_NOT_FOUND',
  requireStack: []
}

Node.js v24.16.0
```

## Initial raw plugin invocation without harness loader

Cwd: `/private/tmp/wt-s6-3/ds-bot`

Command:

```sh
node --test --test-force-exit --test-timeout=120000 test/memory-bot-scope-reject.test.js
```

Exit: 1. Exact combined stdout/stderr:

```text
node:internal/modules/package_json_reader:301
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-llm' imported from /private/tmp/wt-s6-3/ds-bot/src/host/memory.js
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:301:9)
    at packageResolve (node:internal/modules/esm/resolve:768:81)
    at moduleResolve (node:internal/modules/esm/resolve:859:18)
    at defaultResolve (node:internal/modules/esm/resolve:992:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:691:20)
    at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:708:38)
    at ModuleLoader.resolveSync (node:internal/modules/esm/loader:740:52)
    at #resolve (node:internal/modules/esm/loader:673:17)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:593:35)
    at ModuleJob.syncLink (node:internal/modules/esm/module_job:163:33) {
  code: 'ERR_MODULE_NOT_FOUND'
}

Node.js v24.16.0
✖ test/memory-bot-scope-reject.test.js (36.024792ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 39.853375

✖ failing tests:

test at test/memory-bot-scope-reject.test.js:1:1
✖ test/memory-bot-scope-reject.test.js (36.024792ms)
  'test failed'
```

## Risk

An older node Bot, or a shadow whose roster report omitted `clusterBotId`, now receives an explicit refusal for `scope: 'bot'` rather than a successful per-node write. Existing memory is not migrated and no identity is fabricated. `scope: 'own'` remains available as the per-node scope. Offline bot writes may still queue, but the hub refuses them on delivery and the existing terminal-code handling removes them from the outbox.

Because protocol replies carry only an error code, the node's `clusterBotId` sentence is a requirement hint on every `bot`-scope `memory/refused`, including other existing rejection reasons such as invalid content; it does not claim the identity is definitely absent. Legacy reads are deliberately preserved. No real transport or running DSH instance was used to validate delivery; coverage is through the repository's fakes and real federation/memory file writer.

## Round 2

Date: 2026-11-18. Updated only the two authorized legacy tests and appended this section. The accepted production implementation and the new Round 1 regression test were not edited.

### Assertions changed

- `ds-bot/test/memory-node-bot-scope.test.js:108`: renamed the test to describe hub refusal and retained the existing setup through the remember call. At :125, assert that `remember { scope: 'bot' }` rejects with `memory/refused` and the hint `A "bot" write requires clusterBotId on the hub roster. Nothing was saved.` At :130, assert exactly one `mem/write` was sent with scope `bot`, and match its requestId to the hub's unsuccessful `mem/write-result` carrying `memory/refused`. At :137, assert the per-node `MEMORY.md`, its Bot directory and the cluster Bot directory remain absent. At :140, assert both `bot` and `own` recalls report nothing saved, both actual `mem/read-result` entry arrays are empty, and the sent read scopes are exactly `['bot', 'own']`. At :144–147, assert the Bot directory is still absent after reads, the hub sequence is zero, warnings are unchanged, and the outbox is empty. Removed the now-unused `readFileSync` import at :2.
- `ds-bot/test/memory-bot-scope.test.js:249`: renamed the test to describe refusal followed by successful writing once identity is present. Retained all six unusable values (`undefined`, `null`, `''`, whitespace, `17`, `{}`) and the forged frame identity. At :257, each write must return `ok: false`, `error: 'memory/refused'`, sequence zero, and never reach the memory writer; cluster and own reads must both be empty, and the per-node Bot directory must remain absent. At :265, assert no per-node file or cluster Bot directory was created and the sequence remains zero. At :269, set `clusterBotId = 'shared'` on the same roster row and assert a write now succeeds with `changed: true` and sequence one, creates `bots/cluster.shared/MEMORY.md` with the expected text, never creates `cluster.forged`, is readable both on n1 and the n2 row sharing this identity, and leaves own reads empty and the per-node Bot directory absent.

### Verification

Cwd: `/private/tmp/wt-s6-3/ds-bot`.

Exact command run:

```sh
DSH_HARNESS=/Users/kjclaw/dsh-dev/deepseek-harness node --import 'data:text/javascript,import os from "node:os";import {syncBuiltinESMExports} from "node:module";import {mkdtempSync,rmSync} from "node:fs";const home=mkdtempSync(os.tmpdir()+"/ds-bot-s6-3-r2-");os.homedir=()=>home;syncBuiltinESMExports();process.env.DSH_HOME=home;process.env.DS_BOT_GATEWAY_PORT="0";process.on("exit",()=>rmSync(home,{recursive:true,force:true}));' --import ./test/harness-resolve.mjs --test --test-force-exit --test-timeout=120000 test/memory-*.test.js
```

The extra first CLI import isolates `os.homedir()` and `DSH_HOME` to a temporary test home and uses ephemeral gateway ports. This prevents the runtime fakes from falling back to the user's DSH settings. Both imports are CLI arguments; no `NODE_OPTIONS` dependency. `DSH_HARNESS` uses the required existing checkout; no packages were installed. Temporary homes are removed at process exit and test runtime disposers close their gateways.

Exit: 0. Exact summary:

```text
ℹ tests 133
ℹ suites 0
ℹ pass 133
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1107.899709
```

Also ran, from the same cwd:

```sh
node --check test/memory-node-bot-scope.test.js
node --check test/memory-bot-scope.test.js
git diff --check
```

All passed with no output. No tests were deleted, skipped, or loosened. No full-repository suite, installs, commits, pushes, timeout changes, protocol/frame changes or service restarts.

### Accepted source unchanged

Ran `shasum -a 256 src/host/memory-federation.js` before the Round 2 test edits and after the memory suite, from `/private/tmp/wt-s6-3/ds-bot`. Both commands exited 0 and returned:

```text
4388dce4d98e82c4352ff6b1656d0b6ad3ac4ab126d72676cdf4ce793e23fd14  src/host/memory-federation.js
```

This matches the accepted Round 1 source hash. `src/host/memory-federation.js` is byte-identical to that version; no production defect or production edit was needed in Round 2.
