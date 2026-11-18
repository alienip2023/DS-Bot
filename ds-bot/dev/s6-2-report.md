# s6-2: hub online signal

Worktree: `/private/tmp/wt-s6-2`; cwd for every command below:
`/private/tmp/wt-s6-2/ds-bot`. Branch: `feat/s6-2-hub-online`;
base: `4d77b7f1483e4f6bf32ebba7a905da24f72981ce`.

## Signal and accepted limitation

The authoritative connection flag exists at
`/private/tmp/ra-peer/lib/node/transport.js:760`: `NodeTransport.markOnline()`
sets `this.online = true`. The close handler sets it false at
`/private/tmp/ra-peer/lib/node/transport.js:439`. **That flag is not exposed to
DS Bot through a context service.**

The node creates the bot-network service at
`/private/tmp/ra-peer/lib/node/index.js:757` and registers it with `ctx` at
`/private/tmp/ra-peer/lib/node/index.js:800`. Its implementation at
`/private/tmp/ra-peer/lib/node/bot-network.js:13` exposes `nodeId`, directory and
room snapshots, message send/subscription, directory/message receivers and
disposal; it exposes neither an online/connected flag nor transport lifecycle
events. Its directory event is emitted after validation at
`/private/tmp/ra-peer/lib/node/bot-network.js:58`. The optional peer-direct service
at `/private/tmp/ra-peer/lib/node/index.js:760` exposes peer links, not hub link
state. `statusSnapshot().online` at
`/private/tmp/ra-peer/lib/node/index.js:1522` reads the private transport flag, but
is only served through the optional HTTP status handler at line 1561, not a
context service.

Accordingly this change uses the task's permitted derived fallback; it does not
claim to read authoritative socket state. In `src/host/bot-network.js:198`, an
installed node service with a `send` function receives an initial 180,000 ms
liveness lease. Each trusted directory receipt renews that lease through the
existing `peerAt` timestamp at line 42, even when the frame contains zero peer
rows. `rt.hubOnline()` returns a boolean from that lease and service availability.
`reapStalePeers()` deletes an expired lease at line 49, including when callers
inject a future time. Disposal clears the signal and invalidates retained
callbacks. No messages or probes are sent to infer connectivity.

Accepted trade-off: initial service availability is optimistic evidence, not proof
of a completed handshake. A disconnected or never-connected hub can appear online
for up to three minutes. Conversely, an actually live connection that produces no
directory for three minutes, or reconnects without producing a directory, cannot
be distinguished from a dead connection and can appear offline. A strict
socket-level guarantee requires remote-agent to expose its private transport
state. These tests verify the derived fallback, not real socket connectivity.

`src/host/tools.js:137` uses the signal when present and retains the old peer-row
fallback only when it is absent. Protocol version, frame fields, room filtering,
membership code, and timeout constants are unchanged. Only the two permitted
source files, `test/hub-online.test.js`, and this report were edited.

## New test assertions

All six tests are in `test/hub-online.test.js`; the fixture installs the real
network module and team tools over the existing `fakeContext`/`fakeNetwork`, with
no gateway or model calls.

| Test | Exact asserted conditions |
| --- | --- |
| Online before the first directory frame | `peerRows(rt).length === 0`; list output **does not match** `/Hub group chats: unavailable, the hub is offline\./`; output **matches** `/Hub group chats: none you can see\./`; `rt.hubOnline() === true`. The output assertion runs before invoking the new signal, so the knife fails on behavior rather than a missing function. |
| Fresh directory frames | Four iterations advance mocked Date by `179_000` ms and emit a self-only directory with empty rooms. Every iteration asserts peer count `0`, online `true`, `reapStalePeers(rt) === false`, and output matching `/Hub group chats: none you can see\./`. This spans more than three minutes since install. |
| Stale directory, no observable live link | After a frame containing one peer and `Review`, assert online `true` and output matching `/"Review" — 2 members \(hub, read-only\)/`. Reaping at receipt time + `179_999` returns `false` and leaves online `true`; reaping at + `180_000` returns `true`, makes online `false`, leaves `hubRooms` deeply equal to `[]` and peer count `0`, and produces the exact offline-line regex above. A subsequent empty directory restores online `true` and the none-visible line. Injected reap time advances independently of mocked Date. |
| No first directory ever arrives | At `179_999` ms online is `true`; one ms later online is `false`. Reaping returns `false` (no peer removed), online stays `false`, and output matches the offline-line regex. |
| Absent-signal fallback | Signal is `undefined`; no peers produces the offline-line regex. Adding a peer produces the none-visible regex. Setting an explicit `() => false` overrides the peer and produces the offline-line regex. |
| Disposal | A retained online callback initially returns `true`; after disposal both `rt.botNetwork` and `rt.hubOnline` are `undefined` and the retained callback returns `false`. A late directory leaves peer count `0`. |

## Knife evidence

Copied both edited source files aside, computed their SHA-256, overwrote both
with exact bytes from `git show 4d77b7f1:ds-bot/<path>`, ran the command below,
then restored the saved bytes in a Python `finally` block. Restoration asserted
byte equality as well as matching SHA-256. The new test remained installed.
The knife used a temporary `DSH_HOME` and `DS_BOT_GATEWAY_PORT=0`.

```sh
DSH_HARNESS=/Users/kjclaw/dsh-dev/deepseek-harness \
DSH_HOME=<temporary knife directory> DS_BOT_GATEWAY_PORT=0 \
node --import ./test/harness-resolve.mjs \
  --test --test-force-exit --test-timeout=120000 \
  --test-name-pattern='online before the first directory frame' \
  test/hub-online.test.js
```

Result: **0 pass, 1 fail**, node exit **1**, as required. The failed assertion was
`assert.doesNotMatch(text, /Hub group chats: unavailable, the hub is offline\./)`
at `test/hub-online.test.js:29`. The base implementation printed that exact
offline line before any directory frame.

| Source | Edited SHA-256 before knife and after byte-exact restore | Base SHA-256 during knife |
| --- | --- | --- |
| `src/host/bot-network.js` | `74c3655b9ab11f1d6451d29c635a39c9468444ad83f4fecab359c28cb5449ac9` | `3546b0e66061d44fe021c6db79dbfbf4ee0d59865d55a66a86288a5d525c2e3c` |
| `src/host/tools.js` | `f5bda918ee7668dbb927b1d785a04ef888e3aa0ca85e02c2a9ea1a3eee5143ca` | `870e15d576080e411fda192833e3a896ec0a78e2b5a1a068cdb5afa676352f64` |

## Regression commands and results

Node version: `v24.16.0`. Final regression runs used the isolated home below,
created with Python `tempfile.TemporaryDirectory` and removed after both runs.
A minimal test-only settings file selected loopback and port zero, since this
checkout's config lookup otherwise finds the user's settings before applying
the environment gateway override. Final captured gateway configuration was
exclusively `127.0.0.1:0`. An earlier run passed but encountered the user's
configured occupied gateway port; the final runs below resolve that isolation
issue. No running service was restarted.

Exact requested regression command, cwd `/private/tmp/wt-s6-2/ds-bot`:

```sh
DSH_HARNESS=/Users/kjclaw/dsh-dev/deepseek-harness \
DSH_HOME=/var/folders/k0/m_n2yph11pdc7q6sp0366ws80000gn/T/ds-bot-s6-2-isolated-smfmuptr \
DS_BOT_GATEWAY_PORT=0 \
node --import ./test/harness-resolve.mjs \
  --test --test-force-exit --test-timeout=120000 \
  test/peer-rooms.test.js test/peer-rooms-membership.test.js \
  test/bot-network.test.js test/peer-rows.test.js test/peer-messages.test.js
```

Result: **54 pass, 0 fail**, exit **0**; zero cancelled/skipped/todo. The existing
`a stale directory clears rooms and peers using the injected time` test passed,
including its exact offline-line assertion.

**Coverage gap:** `test/peer-messages.test.js` does not exist at this base. Node
24 silently ignored that missing explicit path in the multi-file invocation.
Thus 54 passing tests cover the four existing requested files, not the absent
fifth file. It was not created or replaced.

Additional command, same cwd and isolated environment:

```sh
DSH_HARNESS=/Users/kjclaw/dsh-dev/deepseek-harness \
DSH_HOME=/var/folders/k0/m_n2yph11pdc7q6sp0366ws80000gn/T/ds-bot-s6-2-isolated-smfmuptr \
DS_BOT_GATEWAY_PORT=0 \
node --import ./test/harness-resolve.mjs \
  --test --test-force-exit --test-timeout=120000 \
  test/peer-rooms.test.js test/peer-rooms-membership.test.js \
  test/bot-network.test.js test/peer-rows.test.js \
  test/hub-online.test.js test/peer-send.test.js
```

Result: **63 pass, 0 fail**, exit **0**; zero cancelled/skipped/todo. This includes
all six new tests and the three existing peer-send tests. The new file alone
also passed **6/6** before the knife.

Other verification, same cwd:

- `git diff --check`: passed, exit 0.
- `DSH_HARNESS=/Users/kjclaw/dsh-dev/deepseek-harness npm run lint`: failed,
  exit 1, with 90 existing error diagnostics. Examples include unused `asked`
  in `test/config-source-quiet.test.js:144` and unused imports in
  `src/client/memory-hub-panel.js`. The sole diagnostic in the changed files is
  the pre-existing unused `classify` import at `src/host/bot-network.js:2`.
- `node /Users/kjclaw/dsh-dev/deepseek-harness/node_modules/oxlint/bin/oxlint -c .oxlintrc.json src/host/bot-network.js src/host/tools.js test/hub-online.test.js`:
  failed only for that same unused import. Linting temporary copies of both
  source files from `4d77b7f1` reproduced the identical unused-import error.
  Linting `test/hub-online.test.js` alone passed, exit 0.
- `node scripts/build-client.mjs --check`: failed, exit 1, reporting
  `client.js or office.js is stale`. No generated files or their sources were
  changed or rebuilt within this task's edit scope.
- Whole-repo tests were not run, as requested. The standard smoke bench was not
  started: its setup invokes `pnpm install`, which this task forbids. No installs,
  commits, pushes, or service restarts were performed.
