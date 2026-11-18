# Room Session retry report

Date: November 18, 2026. Cwd for every command below: `/private/tmp/ds-up038/ds-bot`.
Branch: `fix/room-session-retry-backoff`; base/HEAD: `5da612d5b3b335248954de8a7e305d1d92c9a686` (`0.3.8-fork.54`).
Changes remain uncommitted.

## 1. Repeating driver and exact call chain

The repeating driver is inside ds-bot: the browser roster poll. These are current working-tree line numbers:

1. `src/client/index.js:307` starts `loop()`; `src/client/index.js:303` schedules it repeatedly. `src/client/polling.js:20` computes the delay: visible polling starts at 1500 ms, doubles on unchanged answers, and caps at 5000 ms (`src/client/polling.js:12`). Hidden polling uses 10000 ms.
2. `src/client/index.js:287` calls `pull()` (defined at `src/client/index.js:206`).
3. `src/client/index.js:209` calls `call('state', ...)`.
4. `src/client/api.js:8` defines `call`; `src/client/api.js:12` sends `POST api/bot`, with `endpoint` in its JSON body at `src/client/api.js:16`.
5. The registered fetch handler at `src/host/channel.js:1480` dispatches to `handle(endpoint, ...)` at `src/host/channel.js:1483`.
6. `handle` at `src/host/channel.js:552` handles `state` at `src/host/channel.js:559`; a writable host calls `rt.bootstrap()` at `src/host/channel.js:561`, before the unchanged-state response.
7. `bootstrap()` at `src/host/roster.js:1203` calls `void rt.syncModels()` at `src/host/roster.js:1205`, even when a Main Bot already exists.
8. `syncModels()` at `src/host/models.js:555` queues `syncRooms` at `src/host/models.js:560` for a due retry. In the unfixed HEAD this was `src/host/models.js:514` / `:517`, with the sole condition `roomRetry.size > 0`.
9. `syncRooms` at `src/host/models.js:566` calls `syncRoomSessions()` at `src/host/models.js:530`. In HEAD: `:522` -> `:486`.
10. `src/host/models.js:531` calls `selectRoomSession(sessionId)` (defined at `:500`); `:512` calls `selectSessionModel`. In HEAD: `:490` -> `:472` -> `:478`.
11. `selectSessionModel` at `src/host/models.js:376` serializes the request and calls `ctx.sessionController.selectModel` at `:381`. In HEAD: `:373` -> `:378`.

The first catalog-changing round instead takes `src/host/models.js:558` -> `syncAll` at `:567` -> `syncRooms` at `:573` -> the same remaining chain.

The shipped generated bundle contains the same timer at `client.js:47848`, `pull()` call at `client.js:47834`, state request at `client.js:47755`, and fetch at `client.js:15158`. It was inspected, not edited.

Whole-tree searches covered source, generated bundles, hidden/unignored project files and any `lib/` paths; this plugin has no top-level `lib/` directory. The only production `rt.syncModels()` call is `roster.js:1205`. Other direct room selection callers are `roster.js:839` (new room) and `parts.js:1277` (fresh part). The `llm/adapters-updated` handlers in HEAD `models.js:153` and `:505` invalidate caches/refusals or wake a model waiter; neither calls model sync.

There is no self-triggering promise chain: polling provides the next call. In HEAD, every failure adds the same id at `models.js:481` and warns at `:482`; only success (`:479`) or leaving the current room set (`:489`) removes it. Permanent corruption therefore keeps `roomRetry.size > 0` forever, and each state poll attempts all rooms again. Restart recreates an empty in-memory set, immediately encounters the same corrupt stored Session, and starts the cycle again. This source chain explains the supplied 1.5/3/5-second cadence; no production host or request tracing was accessed to identify the particular open client.

## 2. Changes and recovery

Only these three files were changed/added:

- `src/host/models.js:23`: retry delays start at 1500 ms and double to a 300000 ms cap.
- `src/host/models.js:375`: replace the retry Set with an in-memory per-Session Map holding attempt count, next eligible time and the last error signature.
- `src/host/models.js:391`: a successful explicit model selection clears retry/quarantine state.
- `src/host/models.js:476`: prune stale retry state and remembered room selections when an id leaves the current room set. This runs on every `syncModels()`, including when all failures are quarantined or not yet due. Deleted, replaced and deselected ids can subsequently be attempted normally.
- `src/host/models.js:486`: recognize `SessionFormatError`, `is corrupt`, and `turn/start does not open the expected turn`, including wrapped messages and nested causes; cause cycles are bounded by a Set.
- `src/host/models.js:500`: enforce eligibility for direct callers and sync callers. An in-flight reservation plus a second check after catalog lookup prevents concurrent duplicate selections. Permanent errors keep an infinite deadline and produce exactly one actionable, stack-free warning naming the id and recommending a fresh Session.
- `src/host/models.js:521`: transient failures retain a finite exponential deadline. Log the first failure, a distinct error, and failures at the cap; warnings include the total attempt count. Compare the full error signature while limiting displayed text to one line and 300 characters.
- `src/host/models.js:555`: schedule room work only for due failures or a previously unselected current id, so quarantined sessions no longer keep whole-room sync running on every poll.
- `test/room-session-retry.test.js:1`: 11 regression cases cover corruption variants, nested errors, backoff/cap/log counts, distinct errors, new ids, deleted rooms, deselection/reset, successful recovery, restart and concurrent callers.
- `dev/room-session-retry-report.md:1`: this report and captured evidence.

Quarantining is appropriate because selecting a model cannot repair an invalid stored event sequence. Retrying that same id adds load and logs without changing the failing input. No Session data is read or changed by the new scheduling code.

## 3. Red knife and green output

Both runs used Node v24.16.0 and the same test file. Existing repository conventions require the harness resolver; it finds the already installed checkout at `/Users/kjclaw/dsh-dev/deepseek-harness`. Nothing was installed.

Exact command, cwd `/private/tmp/ds-up038/ds-bot`:

```sh
NODE_OPTIONS='--import=./test/harness-resolve.mjs' node --test --test-force-exit --test-timeout=120000 test/room-session-retry.test.js
```

Red knife: executed after adding the tests and before editing `models.js` (exit 1). Complete output:

```text
✖ a permanent format error is quarantined and logged once (2.006125ms)
✖ a permanent remote corruption is quarantined and logged once (0.398167ms)
✖ a permanent invalid turn is quarantined and logged once (0.389542ms)
✖ a permanent nested cause is quarantined and logged once (0.401792ms)
✖ transient retries wait exponentially and stop growing at five minutes (0.339834ms)
✖ a distinct transient error logs its total attempt count without bypassing backoff (0.235416ms)
✖ a fresh room Session is selected and the quarantined id is forgotten (0.381125ms)
✖ deleting a room forgets its quarantine even when no retry is due (0.201708ms)
✖ deselecting a room Session drops its quarantine before the same id is reset (0.219ms)
✔ success clears transient failures and restart does not preserve quarantine (0.887125ms)
✖ concurrent direct and sync calls cannot select a failing Session twice (0.24475ms)
ℹ tests 11
ℹ suites 0
ℹ pass 1
ℹ fail 10
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 74.311333

✖ failing tests:

test at test/room-session-retry.test.js:41:3
✖ a permanent format error is quarantined and logged once (2.006125ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'broken',
  +   'broken',
  +   'broken',
  +   'broken'
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:48:12)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'broken', 'broken', 'broken', 'broken' ],
    expected: [ 'broken' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/room-session-retry.test.js:41:3
✖ a permanent remote corruption is quarantined and logged once (0.398167ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'broken',
  +   'broken',
  +   'broken',
  +   'broken'
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:48:12)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'broken', 'broken', 'broken', 'broken' ],
    expected: [ 'broken' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/room-session-retry.test.js:41:3
✖ a permanent invalid turn is quarantined and logged once (0.389542ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'broken',
  +   'broken',
  +   'broken',
  +   'broken'
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:48:12)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'broken', 'broken', 'broken', 'broken' ],
    expected: [ 'broken' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/room-session-retry.test.js:41:3
✖ a permanent nested cause is quarantined and logged once (0.401792ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'broken',
  +   'broken',
  +   'broken',
  +   'broken'
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:48:12)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'broken', 'broken', 'broken', 'broken' ],
    expected: [ 'broken' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/room-session-retry.test.js:56:1
✖ transient retries wait exponentially and stop growing at five minutes (0.339834ms)
  AssertionError [ERR_ASSERTION]: ticks before the deadline must not select
  
  3 !== 1
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:65:12)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 3,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test/room-session-retry.test.js:77:1
✖ a distinct transient error logs its total attempt count without bypassing backoff (0.235416ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  2 !== 1
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:82:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test/room-session-retry.test.js:92:1
✖ a fresh room Session is selected and the quarantined id is forgotten (0.381125ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'broken',
      'fresh',
  -   'broken'
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:103:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'broken', 'fresh' ],
    expected: [ 'broken', 'fresh', 'broken' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/room-session-retry.test.js:106:1
✖ deleting a room forgets its quarantine even when no retry is due (0.201708ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'broken',
  -   'broken'
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:114:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'broken' ],
    expected: [ 'broken', 'broken' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/room-session-retry.test.js:117:1
✖ deselecting a room Session drops its quarantine before the same id is reset (0.219ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'broken',
  +   undefined,
      'broken'
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:125:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'broken', undefined, 'broken' ],
    expected: [ 'broken', 'broken' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/room-session-retry.test.js:144:1
✖ concurrent direct and sync calls cannot select a failing Session twice (0.24475ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'broken',
  +   'broken',
  +   'broken'
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/room-session-retry.test.js:147:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'broken', 'broken', 'broken' ],
    expected: [ 'broken' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
```

Green: final source (exit 0). Complete output:

```text
✔ a permanent format error is quarantined and logged once (1.471708ms)
✔ a permanent remote corruption is quarantined and logged once (0.249333ms)
✔ a permanent invalid turn is quarantined and logged once (0.156458ms)
✔ a permanent nested cause is quarantined and logged once (0.131875ms)
✔ transient retries wait exponentially and stop growing at five minutes (0.717625ms)
✔ a distinct transient error logs its total attempt count without bypassing backoff (0.280667ms)
✔ a fresh room Session is selected and the quarantined id is forgotten (0.263792ms)
✔ deleting a room forgets its quarantine even when no retry is due (0.624959ms)
✔ deselecting a room Session drops its quarantine before the same id is reset (0.241542ms)
✔ success clears transient failures and restart does not preserve quarantine (0.304083ms)
✔ concurrent direct and sync calls cannot select a failing Session twice (0.128792ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 69.990042
```

## 4. Existing-suite verification and limitations

Baseline `test/models.test.js`, before the fix:

```sh
node --import ./test/harness-resolve.mjs --test --test-force-exit --test-timeout=120000 test/models.test.js
```

Result: **34 passed, 0 failed**.

Discovery command:

```sh
rg -l 'selectRoomSession|syncRoomSessions|models\.js' test/
```

The following nine existing suites were run together, plus the new file:

```sh
node --import ./test/harness-resolve.mjs --test --test-force-exit --test-timeout=120000 test/providers.test.js test/managed-model-failclosed.test.js test/controller-callsites.test.js test/models.test.js test/local-agents.test.js test/merge-node-menu.test.js test/managed-turn-guard.test.js test/node-model-menu.test.js test/images.test.js test/room-session-retry.test.js
```

Result: **214 tests: 211 passed, 3 failed** (exit 1). Excluding the new file: **203 existing tests: 200 passed, 3 failed**.

These three failures are introduced by the required timing change, not pre-existing failures:

| Existing assertion | Result and reason |
| --- | --- |
| `test/models.test.js:456` — a group's own Session follows the team default when it changes, and a failure is retried | Expects selection on the immediate next call, before 1500 ms. |
| `test/models.test.js:477` — a group Session whose selection failed is retried at the next sync, though the models are the same | Same immediate-retry assumption. |
| `test/models.test.js:499` — a new group chat whose selection failed is retried at the next sync | Same immediate-retry assumption. |

They remain unchanged to respect the named-file edit scope. Updating them to advance a fake clock requires expanding that scope; the optional clarification received no answer during this work.

The requested directory command was also executed:

```sh
NODE_OPTIONS='--import=./test/harness-resolve.mjs' node --test --test-force-exit --test-timeout=120000 test/
```

It **does not discover the suite on this Node version**: `ERR_UNSUPPORTED_DIR_IMPORT: Directory import '/private/tmp/ds-up038/ds-bot/test' is not supported`. Node reports one failed entry point, 0 passes. This is not a full-suite result.

The actual full suite was run using the repository's command:

```sh
npm test
# expands to:
# node --import ./test/harness-resolve.mjs --test --test-timeout=120000 --test-force-exit "test/*.test.js"
```

For comparison, `npm test` was first run with only `src/host/models.js` temporarily restored from `git show HEAD:ds-bot/src/host/models.js`, restoring the working change in a `finally` block. The new regression file remained present. Then `npm test` was run with the fix.

| Full-suite run | Tests | Passed | Failed | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| HEAD implementation + new tests | 4135 | 4098 | 28 | 9 | 1 |
| Fixed implementation + new tests | 4135 | 4105 | 21 | 9 | 1 |

Baseline's 28 failures = 18 existing failures + 10 new regression failures. Final's 21 failures = those same 18 existing failures + the 3 immediate-retry assertions above. All 11 new tests pass. Existing-suite baseline excluding the new file: 4124 tests, 4097 passed, 18 failed, 9 skipped.

All 18 baseline failures also appear in `dev/state-save-verification/FAILURES.md`:

| File:line | Failing test |
| --- | --- |
| `test/by-session-id.test.js:17` | bySessionId routes to handleJoinedTurn, not local prompt |
| `test/group-work.test.js:2727` | after a restart a member whose pick-up is still queued keeps its batch waiting |
| `test/install.test.js:70` | apply registers listeners and effects in a fixed order |
| `test/link-bundle.test.js:6` | link.js is the build of ../link/src |
| `test/mirror-gate1.test.js:21` | gate1: real jsonl persistence — write 6 events, flush, reload, historyEntry maps user+bot bubbles |
| `test/mirror-gate1.test.js:110` | gate1: (turn, step) idempotency — duplicate step skipped |
| `test/phone.test.js:1` | file fails to load |
| `test/remote.test.js:1` | file fails to load |
| `test/roster-join-step2.test.js:192` | the remote receiver only accepts a local non-worker bot and keeps the exchangeId |
| `test/roster-join-step2.test.js:217` | sidebar send does not prompt a local session when the bridge is down |
| `test/settings-shell.test.js:1` | file fails to load |
| `test/style-debt.test.js:28` | colors come from the --bt-* variables |
| `test/styles.test.js:1` | file fails to load |
| `test/switch-keeps-input.test.js:205` | a move that fails while the plugin unloads hands its input back to the part it left |
| `test/switch-keeps-input.test.js:225` | a move that never started keeps carry and one pause note in the inbox; a retry adds none |
| `test/usage.test.js:323` | a ledger from the previous version keeps its metered calls and gains the seal watermark |
| `test/usage.test.js:344` | a cached projection watermark beyond the log is not used as a page cursor |
| `test/usage.test.js:359` | a cached projection watermark behind the log does not omit later usage |

Additional checks:

- `node scripts/build-client.mjs --check`: passed.
- `git diff --check`: passed.
- `npm run lint`: initially could not locate oxlint without an explicit harness path.
- `DSH_HARNESS=/Users/kjclaw/dsh-dev/deepseek-harness npm run lint`: executed; failed with 90 errors and 128 warnings, all in untouched files. Examples: unused variables in `test/mirror-list-core.test.js:172`, unused imports in `src/client/memory-hub-panel.js:5`, and unused variables in `dev/spikes/mirror-spike.mjs:74`.
- `node /Users/kjclaw/dsh-dev/deepseek-harness/node_modules/oxlint/bin/oxlint -c .oxlintrc.json src/host/models.js test/room-session-retry.test.js`: passed, no diagnostics.
- No smoke bench was started: the task prohibits DSH restarts and installs, while `dev/bench.sh` starts DSH, may install a profile and writes bench data outside this plugin directory.

## 5. Review risks and work not performed

- A quarantined id stays quarantined while it remains the current id. Changing the team model or receiving an adapter event does not unquarantine it. This intentionally prevents the original storm.
- A departure from the current room set observed by either sync clears its state; returning that id is eligible again. A successful explicit `selectSessionModel` also clears it. There is no new public reset API or invented DSH reset event. An external same-id disk repair without either signal is retried after restart.
- Retry state is never persisted. Each restart may log one fresh corruption warning; a genuinely fixed Session gets a fresh attempt.
- Transient retry deadlines are checked by existing sync calls; no autonomous timer is added. Actual attempts may occur later than the deadline when polling is idle.
- Backoff/classification apply to group Session model-selection failures. Catalog/service lookup failures before selection still use the existing outer sync error handling.
- The three legacy timing tests require maintainer review/update within an expanded file scope. The existing full suite and global lint are not green; counts above distinguish the causes.
- Production recovery was not exercised, and no production files, Sessions, DSH data or services were changed. No stored session was deleted, rewritten, truncated or archived by this work.
- No install, dependency/version change, protocol change, commit, amend, push or DSH restart. Version remains `0.3.8-fork.54`; the bot API remains 1 (`src/host/mobile.js:23` and `:24`). This checkout has no bot API constant literally named `PROTOCOL_VERSION`.
- Existing untracked `dev/state-save-verification/` and the caller's parent event log were left alone.

## Round 2 — preserve the first-failure retry contract

This section supersedes Round 1's timing rule and conclusion about the three legacy tests: immediate retry after a single transient failure is the intended product contract. All three legacy tests now pass without edits to `test/models.test.js`.

At `src/host/models.js:521`, the first consecutive transient failure now has delay 0, making it eligible at the next sync. Failure 2 waits 1500 ms; subsequent failures double that delay to the 300000 ms cap. Successful selection still clears the sequence at `src/host/models.js:391` / `:513`. Corruption quarantine, pruning, in-flight reservation and the `syncModels` due-check are unchanged. No timers or persistence were added.

The existing exponential-delay and distinct-error tests were adjusted to this rule. A twelfth case at `test/room-session-retry.test.js:93` verifies immediate first retry, second-failure backoff and reset after success. Before the scheduling change, the revised file failed 3 cases (9 passed); after it, all 12 pass.

Every command below ran in `/private/tmp/ds-up038/ds-bot`:

1. Legacy model suite:

   ```sh
   node --import ./test/harness-resolve.mjs --test --test-force-exit --test-timeout=120000 test/models.test.js
   ```

   **34 tests, 34 passed, 0 failed, 0 skipped; exit 0.** This includes all three named legacy retry tests. `git diff --exit-code HEAD -- test/models.test.js` also passed, confirming the file is unchanged.

2. Room Session regression suite:

   ```sh
   NODE_OPTIONS='--import=./test/harness-resolve.mjs' node --test --test-force-exit --test-timeout=120000 test/room-session-retry.test.js
   ```

   **12 tests, 12 passed, 0 failed, 0 skipped; exit 0.** All 11 existing cases plus the new first-failure/reset case pass.

3. Full suite:

   ```sh
   npm test
   ```

   **4136 tests, 4109 passed, 18 failed, 9 skipped; exit 1.** The 18 failure locations exactly match the Round 1 baseline table above and are all listed in `dev/state-save-verification/FAILURES.md`. No added failures and no missing baseline failures; the three legacy retry failures from Round 1 are resolved.

4. Build and static checks:

   ```sh
   node scripts/build-client.mjs --check
   git diff --check
   node /Users/kjclaw/dsh-dev/deepseek-harness/node_modules/oxlint/bin/oxlint -c .oxlintrc.json src/host/models.js test/room-session-retry.test.js
   ```

   **All three checks passed, exit 0; oxlint produced no diagnostics.** The existing harness-provided oxlint was used without installing anything.

Round 2 changed only `src/host/models.js`, `test/room-session-retry.test.js` and this appended report section. Version remains `0.3.8-fork.54`; no dependency, protocol, public signature, session-storage or DSH-service changes. No commit, push or amend.

