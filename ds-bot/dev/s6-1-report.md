# s6-1 room membership report

Started from HEAD `f915e61f` (`0.3.8-fork.55`) on the supplied branch `feat/s6-1-room-membership`. Changes remain in the working tree.

The task both limits edits to two files and explicitly requests this report. I treated the requested report as the sole documentation exception; the only code/test changes are `src/host/bot-network.js` and `test/peer-rooms-membership.test.js`.

## Membership evidence

`room.members` is an array of hub roster bot IDs, not an object keyed by bot IDs. Its JavaScript object keys are array indices; `Object.keys(room.members).length` was only counting entries.

- `src/host/roster.js:800` accepts member IDs; line 801 resolves them through `liveBot` (which calls `rt.botOf` at line 154). Lines 819 and 829 retain the live IDs as the room's array, and line 836 writes the room to `state.rooms`.
- `src/host/roster.js:925` also assigns the updated ID array to `room.members`.
- `src/host/store.js:208` normalizes members to an array; line 354 filters them by `state.bots[id]`.
- `src/host/roster-join.js:18` constructs joined roster IDs as `joined:${encodeURIComponent(nodeId)}:${encodeURIComponent(remoteBotId)}`. Lines 58, 70, 76 and 94 create a joined roster row, record `worker.nodeId`, and store the row at that roster ID.
- `src/host/bot-network.js:77` / line 82 publishes those same `bot.id` values with `worker.nodeId ?? HUB_NODE` for joined bots and `HUB_NODE` for local bots.
- Existing evidence: `test/peer-rooms.test.js:115` asserts the room array equals the two local bot IDs. The new test at `test/peer-rooms-membership.test.js:45` asserts the real room array includes `joined:node009:same`. Both joined nodes deliberately use remote ID `same`, proving the mapping uses full roster identity.

The node is therefore provably recoverable through the existing directory mapping. No ID parsing or guessed remote-session mapping is needed.

## Changes

- `src/host/bot-network.js:90`: `roomListsOf` indexes the existing directory by full bot ID, reads each non-private room once, builds one numeric-count room summary, and appends it once per member node. The hub receives every non-private room. Each list caps at 100 after node selection, so rooms belonging to other nodes cannot consume a node's quota.
- `src/host/bot-network.js:86`: the exported `roomsOf` retains the complete capped hub list.
- `src/host/bot-network.js:111`: publication computes the shared bot directory, timestamp and room lists once, then sends the corresponding node list. The send exception handler still warns and continues.
- `src/host/bot-network.js:162` and line 185: change detection includes per-node room lists, so a same-count member replacement across nodes republishes after the existing one-second debounce.
- `test/peer-rooms-membership.test.js:11`: reuses `fakeNetwork`, `threadWorld`, `makeBot`, temporary homes and disposal from the existing room tests. It creates real joined rows with `applyRosterReport` and real rooms with `createRoom`. Eight tests cover own-node visibility, cross-node exclusion, shared membership, private rooms, the hub list, no-member nodes, payload shape/counts, independent caps, same-count membership changes, and send failures.

The room indexing work is O(bots + rooms + total room memberships); selecting each outgoing room list is a Map lookup. Room summaries are shared. There is no nodes × rooms × members scan.

## Results

| Run | Passed | Failed | Exit |
| --- | ---: | ---: | ---: |
| Before-fix new file | 4 | 4 | 1 |
| Restore knife against original source, cross-node test only | 0 | 1 | 1 (expected) |
| After-fix new file | 8 | 0 | 0 |
| New file after restore knife | 8 | 0 | 0 |
| Requested combined room command | 16 | 2 | 1 |
| Requested bot-network command (includes two nested tests) | 32 | 0 | 0 |

The combined room suite is **not green**. The two failures are the existing assertions at `test/peer-rooms.test.js:122` and line 149. They expect node `n9` to receive rooms whose bots are all hub-local. The requested filter correctly returns an empty array. That test file was outside the permitted edit scope and was left unchanged.

`node --check src/host/bot-network.js` and `git diff --check` passed with no output. `npm run lint` exited 2 because the repository's oxlint resolver found no installed oxlint. No installation was attempted.

The initial red run inherited the session environment; the shared runtime fixture read fallback gateway settings and reported the existing port as occupied. Subsequent runs used an isolated `DSH_HOME` under `.dsh-test-s6-1-lDvdeA`, with a synthetic `settings.yaml` selecting loopback and port 0. This avoids the personal configuration fallback for those runs. The temporary runtime homes and test gateway listeners were disposed by the fixtures; the isolated settings directory was removed after verification.

## Restore checks

The first hashes were taken after adding the new test and before editing production code. The full new file then failed on the cross-node leak. Hashes immediately after that red run matched:

```text
ba2e4b7f132b8c3bef00e42d6af6183e0f5dcfe30966ca95b9a17ba9b5dc22af  src/host/bot-network.js
84e74268338ae3cafb238962bb4459e40e0624a01e9cf3ef20360d260357972c  test/peer-rooms-membership.test.js
```

After the fix, an additional knife temporarily replaced only `bot-network.js` with its `f915e61f` contents, reproduced the cross-node leak, and restored the saved fixed bytes in a Python `finally` block. Before/after SHA-256 values matched for both files:

```text
3546b0e66061d44fe021c6db79dbfbf4ee0d59865d55a66a86288a5d525c2e3c  src/host/bot-network.js
84e74268338ae3cafb238962bb4459e40e0624a01e9cf3ef20360d260357972c  test/peer-rooms-membership.test.js
```

## Scope and limits

No commits, pushes, amendments, version bumps, package installations, service restarts or DSH patches. No changes to `tools.js`, `memory-federation.js`, `applyDirectory`, `hubRoomLines`, protocol declarations or frames. The payload remains `{ bots, rooms, at }`; rooms remain `{ id, name, members }` with numeric counts. `ACCEPT_WAIT_MS` remains 60,000 and `JOINED_TURN_TIMEOUT_MS` remains 600,000. The network protocol version was not edited.

I did not change the two conflicting existing assertions, run the full repository suite, or start a smoke bench. Verification used the requested focused commands. Oxlint was unavailable. Pre-existing untracked `../codex-events-upstream-038.jsonl` and `dev/state-save-verification/` were left alone.

The following sections preserve the exact commands, cwd, exit codes and captured output.

## Initial red before applying the fix

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `1`.

```sh
node --test --test-force-exit --test-timeout=120000 test/peer-rooms-membership.test.js
```

Exact captured output (stdout and stderr combined):

```text
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~/Library/Application Support/dsh-desktop/harness
[ds-bot] ds-bot: gateway config host=100.64.0.3 port=4387 from=yaml:~/.dsh/settings.yaml
[ds-bot] ds-bot: gateway port 100.64.0.3:4387 in use (EADDRINUSE) — gateway disabled
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~/Library/Application Support/dsh-desktop/harness
[ds-bot] ds-bot: gateway config host=100.64.0.3 port=4387 from=yaml:~/.dsh/settings.yaml
✔ node009 receives a room containing its roster bot and preserves the payload shape (111.86825ms)
[ds-bot] ds-bot: gateway port 100.64.0.3:4387 in use (EADDRINUSE) — gateway disabled
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~/Library/Application Support/dsh-desktop/harness
[ds-bot] ds-bot: gateway config host=100.64.0.3 port=4387 from=yaml:~/.dsh/settings.yaml
✖ node009 cannot see a room whose members belong only to node010 (9.87025ms)
[ds-bot] ds-bot: gateway port 100.64.0.3:4387 in use (EADDRINUSE) — gateway disabled
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~/Library/Application Support/dsh-desktop/harness
[ds-bot] ds-bot: gateway config host=100.64.0.3 port=4387 from=yaml:~/.dsh/settings.yaml
[ds-bot] ds-bot: gateway port 100.64.0.3:4387 in use (EADDRINUSE) — gateway disabled
✔ a room containing bots from both nodes is visible to both (7.229542ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~/Library/Application Support/dsh-desktop/harness
[ds-bot] ds-bot: gateway config host=100.64.0.3 port=4387 from=yaml:~/.dsh/settings.yaml
[ds-bot] ds-bot: gateway port 100.64.0.3:4387 in use (EADDRINUSE) — gateway disabled
✔ private rooms are excluded from every node including the hub (7.832167ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~/Library/Application Support/dsh-desktop/harness
[ds-bot] ds-bot: gateway config host=100.64.0.3 port=4387 from=yaml:~/.dsh/settings.yaml
[ds-bot] ds-bot: gateway port 100.64.0.3:4387 in use (EADDRINUSE) — gateway disabled
✖ the hub keeps every non-private room and a node without member bots sees none (8.11675ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~/Library/Application Support/dsh-desktop/harness
[ds-bot] ds-bot: gateway config host=100.64.0.3 port=4387 from=yaml:~/.dsh/settings.yaml
[ds-bot] ds-bot: gateway port 100.64.0.3:4387 in use (EADDRINUSE) — gateway disabled
✖ the 100-room cap applies after filtering for each node (12.079791ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=~/.dsh credsDir=~/Library/Application Support/dsh-desktop/harness
[ds-bot] ds-bot: gateway config host=100.64.0.3 port=4387 from=yaml:~/.dsh/settings.yaml
[ds-bot] ds-bot: gateway port 100.64.0.3:4387 in use (EADDRINUSE) — gateway disabled
✖ replacing a member from another node republishes even when the member count stays the same (7.599667ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
✔ a failed directory send warns and continues to the next node (6.525792ms)
ℹ tests 8
ℹ suites 0
ℹ pass 4
ℹ fail 4
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 321.339167

✖ failing tests:

test at test/peer-rooms-membership.test.js:54:1
✖ node009 cannot see a room whose members belong only to node010 (9.87025ms)
  AssertionError [ERR_ASSERTION]: node009 must not receive node010-only rooms
  + actual - expected
  
  + [
  +   {
  +     id: 'session-2',
  +     members: 2,
  +     name: 'Ten only'
  +   }
  + ]
  - []
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/peer-rooms-membership.test.js:58:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ { id: 'session-2', name: 'Ten only', members: 2 } ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/peer-rooms-membership.test.js:77:1
✖ the hub keeps every non-private room and a node without member bots sees none (8.11675ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
  + [
  +   {
  +     id: 'session-3',
  +     members: 2,
  +     name: 'Hub only'
  +   },
  +   {
  +     id: 'session-4',
  +     members: 2,
  +     name: 'Nine'
  +   },
  +   {
  +     id: 'session-5',
  +     members: 2,
  +     name: 'Ten'
  +   }
  + ]
  - []
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/peer-rooms-membership.test.js:87:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ { id: 'session-3', name: 'Hub only', members: 2 }, { id: 'session-4', name: 'Nine', members: 2 }, { id: 'session-5', name: 'Ten', members: 2 } ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/peer-rooms-membership.test.js:90:1
✖ the 100-room cap applies after filtering for each node (12.079791ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      {
  +     id: 'node010-0',
  -     id: 'node009-0',
        members: 2,
  +     name: 'node010 room 0'
  -     name: 'node009 room 0'
      },
      {
  +     id: 'node010-1',
  -     id: 'node009-1',
        members: 2,
  +     name: 'node010 room 1'
  -     name: 'node009 room 1'
      },
      {
  +     id: 'node010-2',
  -     id: 'node009-2',
        members: 2,
  +     name: 'node010 room 2'
  -     name: 'node009 room 2'
      },
      {
  +     id: 'node010-3',
  -     id: 'node009-3',
        members: 2,
  +     name: 'node010 room 3'
  -     name: 'node009 room 3'
      },
      {
  +     id: 'node010-4',
  -     id: 'node009-4',
        members: 2,
  +     name: 'node010 room 4'
  -     name: 'node009 room 4'
      },
      {
  +     id: 'node010-5',
  -     id: 'node009-5',
        members: 2,
  +     name: 'node010 room 5'
  -     name: 'node009 room 5'
      },
      {
  +     id: 'node010-6',
  -     id: 'node009-6',
        members: 2,
  +     name: 'node010 room 6'
  -     name: 'node009 room 6'
      },
      {
  +     id: 'node010-7',
  -     id: 'node009-7',
        members: 2,
  +     name: 'node010 room 7'
  -     name: 'node009 room 7'
      },
      {
  +     id: 'node010-8',
  -     id: 'node009-8',
        members: 2,
  +     name: 'node010 room 8'
  -     name: 'node009 room 8'
      },
      {
  +     id: 'node010-9',
  -     id: 'node009-9',
        members: 2,
  +     name: 'node010 room 9'
  -     name: 'node009 room 9'
      },
      {
  +     id: 'node010-10',
  -     id: 'node009-10',
        members: 2,
  +     name: 'node010 room 10'
  -     name: 'node009 room 10'
      },
      {
  +     id: 'node010-11',
  -     id: 'node009-11',
        members: 2,
  +     name: 'node010 room 11'
  -     name: 'node009 room 11'
      },
      {
  +     id: 'node010-12',
  -     id: 'node009-12',
        members: 2,
  +     name: 'node010 room 12'
  -     name: 'node009 room 12'
      },
      {
  +     id: 'node010-13',
  -     id: 'node009-13',
        members: 2,
  +     name: 'node010 room 13'
  -     name: 'node009 room 13'
      },
      {
  +     id: 'node010-14',
  -     id: 'node009-14',
        members: 2,
  +     name: 'node010 room 14'
  -     name: 'node009 room 14'
      },
      {
  +     id: 'node010-15',
  -     id: 'node009-15',
        members: 2,
  +     name: 'node010 room 15'
  -     name: 'node009 room 15'
      },
      {
  +     id: 'node010-16',
  -     id: 'node009-16',
        members: 2,
  +     name: 'node010 room 16'
  -     name: 'node009 room 16'
      },
      {
  +     id: 'node010-17',
  -     id: 'node009-17',
        members: 2,
  +     name: 'node010 room 17'
  -     name: 'node009 room 17'
      },
      {
  +     id: 'node010-18',
  -     id: 'node009-18',
        members: 2,
  +     name: 'node010 room 18'
  -     name: 'node009 room 18'
      },
      {
  +     id: 'node010-19',
  -     id: 'node009-19',
        members: 2,
  +     name: 'node010 room 19'
  -     name: 'node009 room 19'
      },
      {
  +     id: 'node010-20',
  -     id: 'node009-20',
        members: 2,
  +     name: 'node010 room 20'
  -     name: 'node009 room 20'
      },
      {
  +     id: 'node010-21',
  -     id: 'node009-21',
        members: 2,
  +     name: 'node010 room 21'
  -     name: 'node009 room 21'
      },
      {
  +     id: 'node010-22',
  -     id: 'node009-22',
        members: 2,
  +     name: 'node010 room 22'
  -     name: 'node009 room 22'
      },
      {
  +     id: 'node010-23',
  -     id: 'node009-23',
        members: 2,
  +     name: 'node010 room 23'
  -     name: 'node009 room 23'
      },
      {
  +     id: 'node010-24',
  -     id: 'node009-24',
        members: 2,
  +     name: 'node010 room 24'
  -     name: 'node009 room 24'
      },
      {
  +     id: 'node010-25',
  -     id: 'node009-25',
        members: 2,
  +     name: 'node010 room 25'
  -     name: 'node009 room 25'
      },
      {
  +     id: 'node010-26',
  -     id: 'node009-26',
        members: 2,
  +     name: 'node010 room 26'
  -     name: 'node009 room 26'
      },
      {
  +     id: 'node010-27',
  -     id: 'node009-27',
        members: 2,
  +     name: 'node010 room 27'
  -     name: 'node009 room 27'
      },
      {
  +     id: 'node010-28',
  -     id: 'node009-28',
        members: 2,
  +     name: 'node010 room 28'
  -     name: 'node009 room 28'
      },
      {
  +     id: 'node010-29',
  -     id: 'node009-29',
        members: 2,
  +     name: 'node010 room 29'
  -     name: 'node009 room 29'
      },
      {
  +     id: 'node010-30',
  -     id: 'node009-30',
        members: 2,
  +     name: 'node010 room 30'
  -     name: 'node009 room 30'
      },
      {
  +     id: 'node010-31',
  -     id: 'node009-31',
        members: 2,
  +     name: 'node010 room 31'
  -     name: 'node009 room 31'
      },
      {
  +     id: 'node010-32',
  -     id: 'node009-32',
        members: 2,
  +     name: 'node010 room 32'
  -     name: 'node009 room 32'
      },
      {
  +     id: 'node010-33',
  -     id: 'node009-33',
        members: 2,
  +     name: 'node010 room 33'
  -     name: 'node009 room 33'
      },
      {
  +     id: 'node010-34',
  -     id: 'node009-34',
        members: 2,
  +     name: 'node010 room 34'
  -     name: 'node009 room 34'
      },
      {
  +     id: 'node010-35',
  -     id: 'node009-35',
        members: 2,
  +     name: 'node010 room 35'
  -     name: 'node009 room 35'
      },
      {
  +     id: 'node010-36',
  -     id: 'node009-36',
        members: 2,
  +     name: 'node010 room 36'
  -     name: 'node009 room 36'
      },
      {
  +     id: 'node010-37',
  -     id: 'node009-37',
        members: 2,
  +     name: 'node010 room 37'
  -     name: 'node009 room 37'
      },
      {
  +     id: 'node010-38',
  -     id: 'node009-38',
        members: 2,
  +     name: 'node010 room 38'
  -     name: 'node009 room 38'
      },
      {
  +     id: 'node010-39',
  -     id: 'node009-39',
        members: 2,
  +     name: 'node010 room 39'
  -     name: 'node009 room 39'
      },
      {
  +     id: 'node010-40',
  -     id: 'node009-40',
        members: 2,
  +     name: 'node010 room 40'
  -     name: 'node009 room 40'
      },
      {
  +     id: 'node010-41',
  -     id: 'node009-41',
        members: 2,
  +     name: 'node010 room 41'
  -     name: 'node009 room 41'
      },
      {
  +     id: 'node010-42',
  -     id: 'node009-42',
        members: 2,
  +     name: 'node010 room 42'
  -     name: 'node009 room 42'
      },
      {
  +     id: 'node010-43',
  -     id: 'node009-43',
        members: 2,
  +     name: 'node010 room 43'
  -     name: 'node009 room 43'
      },
      {
  +     id: 'node010-44',
  -     id: 'node009-44',
        members: 2,
  +     name: 'node010 room 44'
  -     name: 'node009 room 44'
      },
      {
  +     id: 'node010-45',
  -     id: 'node009-45',
        members: 2,
  +     name: 'node010 room 45'
  -     name: 'node009 room 45'
      },
      {
  +     id: 'node010-46',
  -     id: 'node009-46',
        members: 2,
  +     name: 'node010 room 46'
  -     name: 'node009 room 46'
      },
      {
  +     id: 'node010-47',
  -     id: 'node009-47',
        members: 2,
  +     name: 'node010 room 47'
  -     name: 'node009 room 47'
      },
      {
  +     id: 'node010-48',
  -     id: 'node009-48',
        members: 2,
  +     name: 'node010 room 48'
  -     name: 'node009 room 48'
      },
      {
  +     id: 'node010-49',
  -     id: 'node009-49',
        members: 2,
  +     name: 'node010 room 49'
  -     name: 'node009 room 49'
      },
      {
  +     id: 'node010-50',
  -     id: 'node009-50',
        members: 2,
  +     name: 'node010 room 50'
  -     name: 'node009 room 50'
      },
      {
  +     id: 'node010-51',
  -     id: 'node009-51',
        members: 2,
  +     name: 'node010 room 51'
  -     name: 'node009 room 51'
      },
      {
  +     id: 'node010-52',
  -     id: 'node009-52',
        members: 2,
  +     name: 'node010 room 52'
  -     name: 'node009 room 52'
      },
      {
  +     id: 'node010-53',
  -     id: 'node009-53',
        members: 2,
  +     name: 'node010 room 53'
  -     name: 'node009 room 53'
      },
      {
  +     id: 'node010-54',
  -     id: 'node009-54',
        members: 2,
  +     name: 'node010 room 54'
  -     name: 'node009 room 54'
      },
      {
  +     id: 'node010-55',
  -     id: 'node009-55',
        members: 2,
  +     name: 'node010 room 55'
  -     name: 'node009 room 55'
      },
      {
  +     id: 'node010-56',
  -     id: 'node009-56',
        members: 2,
  +     name: 'node010 room 56'
  -     name: 'node009 room 56'
      },
      {
  +     id: 'node010-57',
  -     id: 'node009-57',
        members: 2,
  +     name: 'node010 room 57'
  -     name: 'node009 room 57'
      },
      {
  +     id: 'node010-58',
  -     id: 'node009-58',
        members: 2,
  +     name: 'node010 room 58'
  -     name: 'node009 room 58'
      },
      {
  +     id: 'node010-59',
  -     id: 'node009-59',
        members: 2,
  +     name: 'node010 room 59'
  -     name: 'node009 room 59'
      },
      {
  +     id: 'node010-60',
  -     id: 'node009-60',
        members: 2,
  +     name: 'node010 room 60'
  -     name: 'node009 room 60'
      },
      {
  +     id: 'node010-61',
  -     id: 'node009-61',
        members: 2,
  +     name: 'node010 room 61'
  -     name: 'node009 room 61'
      },
      {
  +     id: 'node010-62',
  -     id: 'node009-62',
        members: 2,
  +     name: 'node010 room 62'
  -     name: 'node009 room 62'
      },
      {
  +     id: 'node010-63',
  -     id: 'node009-63',
        members: 2,
  +     name: 'node010 room 63'
  -     name: 'node009 room 63'
      },
      {
  +     id: 'node010-64',
  -     id: 'node009-64',
        members: 2,
  +     name: 'node010 room 64'
  -     name: 'node009 room 64'
      },
      {
  +     id: 'node010-65',
  -     id: 'node009-65',
        members: 2,
  +     name: 'node010 room 65'
  -     name: 'node009 room 65'
      },
      {
  +     id: 'node010-66',
  -     id: 'node009-66',
        members: 2,
  +     name: 'node010 room 66'
  -     name: 'node009 room 66'
      },
      {
  +     id: 'node010-67',
  -     id: 'node009-67',
        members: 2,
  +     name: 'node010 room 67'
  -     name: 'node009 room 67'
      },
      {
  +     id: 'node010-68',
  -     id: 'node009-68',
        members: 2,
  +     name: 'node010 room 68'
  -     name: 'node009 room 68'
      },
      {
  +     id: 'node010-69',
  -     id: 'node009-69',
        members: 2,
  +     name: 'node010 room 69'
  -     name: 'node009 room 69'
      },
      {
  +     id: 'node010-70',
  -     id: 'node009-70',
        members: 2,
  +     name: 'node010 room 70'
  -     name: 'node009 room 70'
      },
      {
  +     id: 'node010-71',
  -     id: 'node009-71',
        members: 2,
  +     name: 'node010 room 71'
  -     name: 'node009 room 71'
      },
      {
  +     id: 'node010-72',
  -     id: 'node009-72',
        members: 2,
  +     name: 'node010 room 72'
  -     name: 'node009 room 72'
      },
      {
  +     id: 'node010-73',
  -     id: 'node009-73',
        members: 2,
  +     name: 'node010 room 73'
  -     name: 'node009 room 73'
      },
      {
  +     id: 'node010-74',
  -     id: 'node009-74',
        members: 2,
  +     name: 'node010 room 74'
  -     name: 'node009 room 74'
      },
      {
  +     id: 'node010-75',
  -     id: 'node009-75',
        members: 2,
  +     name: 'node010 room 75'
  -     name: 'node009 room 75'
      },
      {
  +     id: 'node010-76',
  -     id: 'node009-76',
        members: 2,
  +     name: 'node010 room 76'
  -     name: 'node009 room 76'
      },
      {
  +     id: 'node010-77',
  -     id: 'node009-77',
        members: 2,
  +     name: 'node010 room 77'
  -     name: 'node009 room 77'
      },
      {
  +     id: 'node010-78',
  -     id: 'node009-78',
        members: 2,
  +     name: 'node010 room 78'
  -     name: 'node009 room 78'
      },
      {
  +     id: 'node010-79',
  -     id: 'node009-79',
        members: 2,
  +     name: 'node010 room 79'
  -     name: 'node009 room 79'
      },
      {
  +     id: 'node010-80',
  -     id: 'node009-80',
        members: 2,
  +     name: 'node010 room 80'
  -     name: 'node009 room 80'
      },
      {
  +     id: 'node010-81',
  -     id: 'node009-81',
        members: 2,
  +     name: 'node010 room 81'
  -     name: 'node009 room 81'
      },
      {
  +     id: 'node010-82',
  -     id: 'node009-82',
        members: 2,
  +     name: 'node010 room 82'
  -     name: 'node009 room 82'
      },
      {
  +     id: 'node010-83',
  -     id: 'node009-83',
        members: 2,
  +     name: 'node010 room 83'
  -     name: 'node009 room 83'
      },
      {
  +     id: 'node010-84',
  -     id: 'node009-84',
        members: 2,
  +     name: 'node010 room 84'
  -     name: 'node009 room 84'
      },
      {
  +     id: 'node010-85',
  -     id: 'node009-85',
        members: 2,
  +     name: 'node010 room 85'
  -     name: 'node009 room 85'
      },
      {
  +     id: 'node010-86',
  -     id: 'node009-86',
        members: 2,
  +     name: 'node010 room 86'
  -     name: 'node009 room 86'
      },
      {
  +     id: 'node010-87',
  -     id: 'node009-87',
        members: 2,
  +     name: 'node010 room 87'
  -     name: 'node009 room 87'
      },
      {
  +     id: 'node010-88',
  -     id: 'node009-88',
        members: 2,
  +     name: 'node010 room 88'
  -     name: 'node009 room 88'
      },
      {
  +     id: 'node010-89',
  -     id: 'node009-89',
        members: 2,
  +     name: 'node010 room 89'
  -     name: 'node009 room 89'
      },
      {
  +     id: 'node010-90',
  -     id: 'node009-90',
        members: 2,
  +     name: 'node010 room 90'
  -     name: 'node009 room 90'
      },
      {
  +     id: 'node010-91',
  -     id: 'node009-91',
        members: 2,
  +     name: 'node010 room 91'
  -     name: 'node009 room 91'
      },
      {
  +     id: 'node010-92',
  -     id: 'node009-92',
        members: 2,
  +     name: 'node010 room 92'
  -     name: 'node009 room 92'
      },
      {
  +     id: 'node010-93',
  -     id: 'node009-93',
        members: 2,
  +     name: 'node010 room 93'
  -     name: 'node009 room 93'
      },
      {
  +     id: 'node010-94',
  -     id: 'node009-94',
        members: 2,
  +     name: 'node010 room 94'
  -     name: 'node009 room 94'
      },
      {
  +     id: 'node010-95',
  -     id: 'node009-95',
        members: 2,
  +     name: 'node010 room 95'
  -     name: 'node009 room 95'
      },
      {
  +     id: 'node010-96',
  -     id: 'node009-96',
        members: 2,
  +     name: 'node010 room 96'
  -     name: 'node009 room 96'
      },
      {
  +     id: 'node010-97',
  -     id: 'node009-97',
        members: 2,
  +     name: 'node010 room 97'
  -     name: 'node009 room 97'
      },
      {
  +     id: 'node010-98',
  -     id: 'node009-98',
        members: 2,
  +     name: 'node010 room 98'
  -     name: 'node009 room 98'
      },
      {
  +     id: 'node010-99',
  -     id: 'node009-99',
        members: 2,
  +     name: 'node010 room 99'
  -     name: 'node009 room 99'
      }
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/peer-rooms-membership.test.js:98:12)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [
      { id: 'node010-0', name: 'node010 room 0', members: 2 },   { id: 'node010-1', name: 'node010 room 1', members: 2 },
      { id: 'node010-2', name: 'node010 room 2', members: 2 },   { id: 'node010-3', name: 'node010 room 3', members: 2 },
      { id: 'node010-4', name: 'node010 room 4', members: 2 },   { id: 'node010-5', name: 'node010 room 5', members: 2 },
      { id: 'node010-6', name: 'node010 room 6', members: 2 },   { id: 'node010-7', name: 'node010 room 7', members: 2 },
      { id: 'node010-8', name: 'node010 room 8', members: 2 },   { id: 'node010-9', name: 'node010 room 9', members: 2 },
      { id: 'node010-10', name: 'node010 room 10', members: 2 }, { id: 'node010-11', name: 'node010 room 11', members: 2 },
      { id: 'node010-12', name: 'node010 room 12', members: 2 }, { id: 'node010-13', name: 'node010 room 13', members: 2 },
      { id: 'node010-14', name: 'node010 room 14', members: 2 }, { id: 'node010-15', name: 'node010 room 15', members: 2 },
      { id: 'node010-16', name: 'node010 room 16', members: 2 }, { id: 'node010-17', name: 'node010 room 17', members: 2 },
      { id: 'node010-18', name: 'node010 room 18', members: 2 }, { id: 'node010-19', name: 'node010 room 19', members: 2 },
      { id: 'node010-20', name: 'node010 room 20', members: 2 }, { id: 'node010-21', name: 'node010 room 21', members: 2 },
      { id: 'node010-22', name: 'node010 room 22', members: 2 }, { id: 'node010-23', name: 'node010 room 23', members: 2 },
      { id: 'node010-24', name: 'node010 room 24', members: 2 }, { id: 'node010-25', name: 'node010 room 25', members: 2 },
      { id: 'node010-26', name: 'node010 room 26', members: 2 }, { id: 'node010-27', name: 'node010 room 27', members: 2 },
      { id: 'node010-28', name: 'node010 room 28', members: 2 }, { id: 'node010-29', name: 'node010 room 29', members: 2 },
      { id: 'node010-30', name: 'node010 room 30', members: 2 }, { id: 'node010-31', name: 'node010 room 31', members: 2 },
      { id: 'node010-32', name: 'node010 room 32', members: 2 }, { id: 'node010-33', name: 'node010 room 33', members: 2 },
      { id: 'node010-34', name: 'node010 room 34', members: 2 }, { id: 'node010-35', name: 'node010 room 35', members: 2 },
      { id: 'node010-36', name: 'node010 room 36', members: 2 }, { id: 'node010-37', name: 'node010 room 37', members: 2 },
      { id: 'node010-38', name: 'node010 room 38', members: 2 }, { id: 'node010-39', name: 'node010 room 39', members: 2 },
      { id: 'node010-40', name: 'node010 room 40', members: 2 }, { id: 'node010-41', name: 'node010 room 41', members: 2 },
      { id: 'node010-42', name: 'node010 room 42', members: 2 }, { id: 'node010-43', name: 'node010 room 43', members: 2 },
      { id: 'node010-44', name: 'node010 room 44', members: 2 }, { id: 'node010-45', name: 'node010 room 45', members: 2 },
      { id: 'node010-46', name: 'node010 room 46', members: 2 }, { id: 'node010-47', name: 'node010 room 47', members: 2 },
      { id: 'node010-48', name: 'node010 room 48', members: 2 }, { id: 'node010-49', name: 'node010 room 49', members: 2 },
      { id: 'node010-50', name: 'node010 room 50', members: 2 }, { id: 'node010-51', name: 'node010 room 51', members: 2 },
      { id: 'node010-52', name: 'node010 room 52', members: 2 }, { id: 'node010-53', name: 'node010 room 53', members: 2 },
      { id: 'node010-54', name: 'node010 room 54', members: 2 }, { id: 'node010-55', name: 'node010 room 55', members: 2 },
      { id: 'node010-56', name: 'node010 room 56', members: 2 }, { id: 'node010-57', name: 'node010 room 57', members: 2 },
      { id: 'node010-58', name: 'node010 room 58', members: 2 }, { id: 'node010-59', name: 'node010 room 59', members: 2 },
      { id: 'node010-60', name: 'node010 room 60', members: 2 }, { id: 'node010-61', name: 'node010 room 61', members: 2 },
      { id: 'node010-62', name: 'node010 room 62', members: 2 }, { id: 'node010-63', name: 'node010 room 63', members: 2 },
      { id: 'node010-64', name: 'node010 room 64', members: 2 }, { id: 'node010-65', name: 'node010 room 65', members: 2 },
      { id: 'node010-66', name: 'node010 room 66', members: 2 }, { id: 'node010-67', name: 'node010 room 67', members: 2 },
      { id: 'node010-68', name: 'node010 room 68', members: 2 }, { id: 'node010-69', name: 'node010 room 69', members: 2 },
      { id: 'node010-70', name: 'node010 room 70', members: 2 }, { id: 'node010-71', name: 'node010 room 71', members: 2 },
      { id: 'node010-72', name: 'node010 room 72', members: 2 }, { id: 'node010-73', name: 'node010 room 73', members: 2 },
      { id: 'node010-74', name: 'node010 room 74', members: 2 }, { id: 'node010-75', name: 'node010 room 75', members: 2 },
      { id: 'node010-76', name: 'node010 room 76', members: 2 }, { id: 'node010-77', name: 'node010 room 77', members: 2 },
      { id: 'node010-78', name: 'node010 room 78', members: 2 }, { id: 'node010-79', name: 'node010 room 79', members: 2 },
      { id: 'node010-80', name: 'node010 room 80', members: 2 }, { id: 'node010-81', name: 'node010 room 81', members: 2 },
      { id: 'node010-82', name: 'node010 room 82', members: 2 }, { id: 'node010-83', name: 'node010 room 83', members: 2 },
      { id: 'node010-84', name: 'node010 room 84', members: 2 }, { id: 'node010-85', name: 'node010 room 85', members: 2 },
      { id: 'node010-86', name: 'node010 room 86', members: 2 }, { id: 'node010-87', name: 'node010 room 87', members: 2 },
      { id: 'node010-88', name: 'node010 room 88', members: 2 }, { id: 'node010-89', name: 'node010 room 89', members: 2 },
      { id: 'node010-90', name: 'node010 room 90', members: 2 }, { id: 'node010-91', name: 'node010 room 91', members: 2 },
      { id: 'node010-92', name: 'node010 room 92', members: 2 }, { id: 'node010-93', name: 'node010 room 93', members: 2 },
      { id: 'node010-94', name: 'node010 room 94', members: 2 }, { id: 'node010-95', name: 'node010 room 95', members: 2 },
      { id: 'node010-96', name: 'node010 room 96', members: 2 }, { id: 'node010-97', name: 'node010 room 97', members: 2 },
      { id: 'node010-98', name: 'node010 room 98', members: 2 }, { id: 'node010-99', name: 'node010 room 99', members: 2 }
    ],
    expected: [
      { id: 'node009-0', name: 'node009 room 0', members: 2 },   { id: 'node009-1', name: 'node009 room 1', members: 2 },
      { id: 'node009-2', name: 'node009 room 2', members: 2 },   { id: 'node009-3', name: 'node009 room 3', members: 2 },
      { id: 'node009-4', name: 'node009 room 4', members: 2 },   { id: 'node009-5', name: 'node009 room 5', members: 2 },
      { id: 'node009-6', name: 'node009 room 6', members: 2 },   { id: 'node009-7', name: 'node009 room 7', members: 2 },
      { id: 'node009-8', name: 'node009 room 8', members: 2 },   { id: 'node009-9', name: 'node009 room 9', members: 2 },
      { id: 'node009-10', name: 'node009 room 10', members: 2 }, { id: 'node009-11', name: 'node009 room 11', members: 2 },
      { id: 'node009-12', name: 'node009 room 12', members: 2 }, { id: 'node009-13', name: 'node009 room 13', members: 2 },
      { id: 'node009-14', name: 'node009 room 14', members: 2 }, { id: 'node009-15', name: 'node009 room 15', members: 2 },
      { id: 'node009-16', name: 'node009 room 16', members: 2 }, { id: 'node009-17', name: 'node009 room 17', members: 2 },
      { id: 'node009-18', name: 'node009 room 18', members: 2 }, { id: 'node009-19', name: 'node009 room 19', members: 2 },
      { id: 'node009-20', name: 'node009 room 20', members: 2 }, { id: 'node009-21', name: 'node009 room 21', members: 2 },
      { id: 'node009-22', name: 'node009 room 22', members: 2 }, { id: 'node009-23', name: 'node009 room 23', members: 2 },
      { id: 'node009-24', name: 'node009 room 24', members: 2 }, { id: 'node009-25', name: 'node009 room 25', members: 2 },
      { id: 'node009-26', name: 'node009 room 26', members: 2 }, { id: 'node009-27', name: 'node009 room 27', members: 2 },
      { id: 'node009-28', name: 'node009 room 28', members: 2 }, { id: 'node009-29', name: 'node009 room 29', members: 2 },
      { id: 'node009-30', name: 'node009 room 30', members: 2 }, { id: 'node009-31', name: 'node009 room 31', members: 2 },
      { id: 'node009-32', name: 'node009 room 32', members: 2 }, { id: 'node009-33', name: 'node009 room 33', members: 2 },
      { id: 'node009-34', name: 'node009 room 34', members: 2 }, { id: 'node009-35', name: 'node009 room 35', members: 2 },
      { id: 'node009-36', name: 'node009 room 36', members: 2 }, { id: 'node009-37', name: 'node009 room 37', members: 2 },
      { id: 'node009-38', name: 'node009 room 38', members: 2 }, { id: 'node009-39', name: 'node009 room 39', members: 2 },
      { id: 'node009-40', name: 'node009 room 40', members: 2 }, { id: 'node009-41', name: 'node009 room 41', members: 2 },
      { id: 'node009-42', name: 'node009 room 42', members: 2 }, { id: 'node009-43', name: 'node009 room 43', members: 2 },
      { id: 'node009-44', name: 'node009 room 44', members: 2 }, { id: 'node009-45', name: 'node009 room 45', members: 2 },
      { id: 'node009-46', name: 'node009 room 46', members: 2 }, { id: 'node009-47', name: 'node009 room 47', members: 2 },
      { id: 'node009-48', name: 'node009 room 48', members: 2 }, { id: 'node009-49', name: 'node009 room 49', members: 2 },
      { id: 'node009-50', name: 'node009 room 50', members: 2 }, { id: 'node009-51', name: 'node009 room 51', members: 2 },
      { id: 'node009-52', name: 'node009 room 52', members: 2 }, { id: 'node009-53', name: 'node009 room 53', members: 2 },
      { id: 'node009-54', name: 'node009 room 54', members: 2 }, { id: 'node009-55', name: 'node009 room 55', members: 2 },
      { id: 'node009-56', name: 'node009 room 56', members: 2 }, { id: 'node009-57', name: 'node009 room 57', members: 2 },
      { id: 'node009-58', name: 'node009 room 58', members: 2 }, { id: 'node009-59', name: 'node009 room 59', members: 2 },
      { id: 'node009-60', name: 'node009 room 60', members: 2 }, { id: 'node009-61', name: 'node009 room 61', members: 2 },
      { id: 'node009-62', name: 'node009 room 62', members: 2 }, { id: 'node009-63', name: 'node009 room 63', members: 2 },
      { id: 'node009-64', name: 'node009 room 64', members: 2 }, { id: 'node009-65', name: 'node009 room 65', members: 2 },
      { id: 'node009-66', name: 'node009 room 66', members: 2 }, { id: 'node009-67', name: 'node009 room 67', members: 2 },
      { id: 'node009-68', name: 'node009 room 68', members: 2 }, { id: 'node009-69', name: 'node009 room 69', members: 2 },
      { id: 'node009-70', name: 'node009 room 70', members: 2 }, { id: 'node009-71', name: 'node009 room 71', members: 2 },
      { id: 'node009-72', name: 'node009 room 72', members: 2 }, { id: 'node009-73', name: 'node009 room 73', members: 2 },
      { id: 'node009-74', name: 'node009 room 74', members: 2 }, { id: 'node009-75', name: 'node009 room 75', members: 2 },
      { id: 'node009-76', name: 'node009 room 76', members: 2 }, { id: 'node009-77', name: 'node009 room 77', members: 2 },
      { id: 'node009-78', name: 'node009 room 78', members: 2 }, { id: 'node009-79', name: 'node009 room 79', members: 2 },
      { id: 'node009-80', name: 'node009 room 80', members: 2 }, { id: 'node009-81', name: 'node009 room 81', members: 2 },
      { id: 'node009-82', name: 'node009 room 82', members: 2 }, { id: 'node009-83', name: 'node009 room 83', members: 2 },
      { id: 'node009-84', name: 'node009 room 84', members: 2 }, { id: 'node009-85', name: 'node009 room 85', members: 2 },
      { id: 'node009-86', name: 'node009 room 86', members: 2 }, { id: 'node009-87', name: 'node009 room 87', members: 2 },
      { id: 'node009-88', name: 'node009 room 88', members: 2 }, { id: 'node009-89', name: 'node009 room 89', members: 2 },
      { id: 'node009-90', name: 'node009 room 90', members: 2 }, { id: 'node009-91', name: 'node009 room 91', members: 2 },
      { id: 'node009-92', name: 'node009 room 92', members: 2 }, { id: 'node009-93', name: 'node009 room 93', members: 2 },
      { id: 'node009-94', name: 'node009 room 94', members: 2 }, { id: 'node009-95', name: 'node009 room 95', members: 2 },
      { id: 'node009-96', name: 'node009 room 96', members: 2 }, { id: 'node009-97', name: 'node009 room 97', members: 2 },
      { id: 'node009-98', name: 'node009 room 98', members: 2 }, { id: 'node009-99', name: 'node009 room 99', members: 2 }
    ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/peer-rooms-membership.test.js:103:1
✖ replacing a member from another node republishes even when the member count stays the same (7.599667ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  0 !== 4
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/peer-rooms-membership.test.js:117:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 4,
    operator: 'strictEqual',
    diff: 'simple'
  }

```
## First green new-file run

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `0`.

```sh
export DSH_HOME=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
node --test --test-force-exit --test-timeout=120000 test/peer-rooms-membership.test.js
```

Exact captured output (stdout and stderr combined):

```text
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63801
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
✔ node009 receives a room containing its roster bot and preserves the payload shape (101.47775ms)
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63804
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
✔ node009 cannot see a room whose members belong only to node010 (10.166583ms)
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63807
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
✔ a room containing bots from both nodes is visible to both (7.656333ms)
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63810
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63813
✔ private rooms are excluded from every node including the hub (8.39175ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63816
✔ the hub keeps every non-private room and a node without member bots sees none (9.044375ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63819
✔ the 100-room cap applies after filtering for each node (7.541166ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63822
✔ replacing a member from another node republishes even when the member count stays the same (8.61225ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
✔ a failed directory send warns and continues to the next node (7.669833ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 283.834584

```
## Restore knife

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `0`.

```sh
export DSH_HOME=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
python3 - <<'PY'
import hashlib
from pathlib import Path
import subprocess

source = Path('src/host/bot-network.js')
test = Path('test/peer-rooms-membership.test.js')
fixed = source.read_bytes()
before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, test)]
print('Before knife:', *before, sep='\n', flush=True)
try:
    original = subprocess.check_output(['git', 'show', 'f915e61f:ds-bot/src/host/bot-network.js'])
    source.write_bytes(original)
    command = ['node', '--test', '--test-force-exit', '--test-timeout=120000', '--test-name-pattern=node009 cannot see', 'test/peer-rooms-membership.test.js']
    print('Red command:', ' '.join(command), flush=True)
    result = subprocess.run(command)
    print('Red exit:', result.returncode, flush=True)
    assert result.returncode == 1
finally:
    source.write_bytes(fixed)
    after = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, test)]
    print('After knife:', *after, sep='\n', flush=True)
    assert before == after
    print('Restore-check: source and test SHA-256 MATCH', flush=True)
PY
```

Exact captured output (stdout and stderr combined):

```text
Before knife:
3546b0e66061d44fe021c6db79dbfbf4ee0d59865d55a66a86288a5d525c2e3c
84e74268338ae3cafb238962bb4459e40e0624a01e9cf3ef20360d260357972c
Red command: node --test --test-force-exit --test-timeout=120000 --test-name-pattern=node009 cannot see test/peer-rooms-membership.test.js
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63949
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
✖ node009 cannot see a room whose members belong only to node010 (98.347625ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 217.778833

✖ failing tests:

test at test/peer-rooms-membership.test.js:54:1
✖ node009 cannot see a room whose members belong only to node010 (98.347625ms)
  AssertionError [ERR_ASSERTION]: node009 must not receive node010-only rooms
  + actual - expected
  
  + [
  +   {
  +     id: 'session-2',
  +     members: 2,
  +     name: 'Ten only'
  +   }
  + ]
  - []
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/peer-rooms-membership.test.js:58:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ { id: 'session-2', name: 'Ten only', members: 2 } ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
Red exit: 1
After knife:
3546b0e66061d44fe021c6db79dbfbf4ee0d59865d55a66a86288a5d525c2e3c
84e74268338ae3cafb238962bb4459e40e0624a01e9cf3ef20360d260357972c
Restore-check: source and test SHA-256 MATCH

```
## Green after restoration

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `0`.

```sh
export DSH_HOME=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
node --test --test-force-exit --test-timeout=120000 test/peer-rooms-membership.test.js
```

Exact captured output (stdout and stderr combined):

```text
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63995
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
✔ node009 receives a room containing its roster bot and preserves the payload shape (96.141208ms)
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63996
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63997
✔ node009 cannot see a room whose members belong only to node010 (8.888917ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
✔ a room containing bots from both nodes is visible to both (7.508291ms)
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63998
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63999
✔ private rooms are excluded from every node including the hub (8.300417ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64000
✔ the hub keeps every non-private room and a node without member bots sees none (8.520375ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64001
✔ the 100-room cap applies after filtering for each node (6.892917ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64002
✔ replacing a member from another node republishes even when the member count stays the same (8.072042ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
✔ a failed directory send warns and continues to the next node (7.308708ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 269.654

```
## Requested combined room command

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `1`.

```sh
export DSH_HOME=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
node --test --test-force-exit --test-timeout=120000 test/peer-rooms-membership.test.js test/peer-rooms.test.js
```

Exact captured output (stdout and stderr combined):

```text
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63799
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63803
✔ node009 receives a room containing its roster bot and preserves the payload shape (97.855334ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63806
✔ node009 cannot see a room whose members belong only to node010 (10.559708ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63809
✔ a room containing bots from both nodes is visible to both (8.233792ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63812
✔ private rooms are excluded from every node including the hub (8.896833ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63815
✔ the hub keeps every non-private room and a node without member bots sees none (8.821708ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63818
✔ the 100-room cap applies after filtering for each node (7.617708ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63821
✔ replacing a member from another node republishes even when the member count stays the same (9.252541ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
✔ a failed directory send warns and continues to the next node (7.897125ms)
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63800
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63802
✔ a directory frame with rooms fills hubRooms and list_bots prints every room (96.530833ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63805
✔ a legacy bare array clears rooms and reports none you can see while the hub is online (10.153209ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63808
✔ invalid rooms are dropped and valid names are trimmed and capped at 40 characters (7.350542ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63811
✔ more than 100 valid rooms keeps exactly the first 100 (7.277459ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63814
✔ a stale directory clears rooms and peers using the injected time (8.028583ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-2 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-3 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-4 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63817
✖ hub payloads include real room member counts and exclude private rooms (9.694917ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-2 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-3 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63820
✖ room renames and membership changes republish without changing Bot rows (9.132375ms)
✔ hub room publication is capped at 100 visible rooms (0.335458ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:63823
✔ an untrusted directory cannot replace hub rooms (9.231875ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-2 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-3 needs the team tools but its Agent cannot register them yet
✔ a group or Bot scoped list suppresses the hub rooms (8.548334ms)
ℹ tests 18
ℹ suites 0
ℹ pass 16
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 287.646458

✖ failing tests:

test at test/peer-rooms.test.js:104:1
✖ hub payloads include real room member counts and exclude private rooms (9.694917ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
  + []
  - [
  -   {
  -     id: 'session-3',
  -     members: 2,
  -     name: 'Public'
  -   }
  - ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/peer-rooms.test.js:122:10)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [],
    expected: [ { id: 'session-3', name: 'Public', members: 2 } ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at test/peer-rooms.test.js:126:1
✖ room renames and membership changes republish without changing Bot rows (9.132375ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
  + []
  - [
  -   {
  -     id: 'session-3',
  -     members: 2,
  -     name: 'Renamed'
  -   }
  - ]
  
      at TestContext.<anonymous> (file:///private/tmp/ds-up038/ds-bot/test/peer-rooms.test.js:149:12)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [],
    expected: [ { id: 'session-3', name: 'Renamed', members: 2 } ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

```
## Requested bot-network command

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `0`.

```sh
export DSH_HOME=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-lDvdeA
node --test --test-force-exit --test-timeout=120000 test/bot-network.test.js
```

Exact captured output (stdout and stderr combined):

```text
✔ the plugin assembles the Bot network module (0.524042ms)
✔ directory includes local and joined Bots, omits peers, and falls back to id for a name (0.796459ms)
✔ publishDirectory sends the current directory to every online node (0.321792ms)
✔ hub passes joined routing arguments with defer:true (stubbed handler) (0.221041ms)
✔ hub routes local asks and replies to the addressed Bot with the sender name (0.171125ms)
✔ hub routes replies to joined Bots through joined delivery too (0.17425ms)
✔ depth >= 3 is dropped before routing (0.138083ms)
✔ duplicate ask is suppressed for 60 seconds, without suppressing replies (0.32125ms)
✔ unknown and peer destinations warn and never execute locally (0.111416ms)
✔ private Bots stay outside the network directory and cannot receive network messages (0.124291ms)
▶ install provides an absent receiver and only sets and restores a provided receiver
  ✔ not provided (0.536417ms)
  ✔ already provided (0.133583ms)
✔ install provides an absent receiver and only sets and restores a provided receiver (0.818917ms)
✔ install registers the hub receiver and publishes on online, roster changes, and a 60s fallback (0.325125ms)
✔ install tolerates a network service without onMessage (0.079875ms)
✔ hub-shaped network service does not break list_bots (2.261916ms)
✔ hub-shaped network service preserves the missing-Bot message_bot result (1.028166ms)
✔ node-shaped network service still lists and routes to remote Bots (1.155666ms)
✔ install subscribes to onMessage once and unsubscribes on cleanup (0.459583ms)
✔ message_bot uses the live remote directory when the local lookup misses (0.612083ms)
✔ remote send passes the node identity validator with all three sender fields (0.684625ms)
✔ remote send falls back to the local sender id when its name is empty (0.5215ms)
✔ remote send refuses missing or invalid node identity before calling send (0.63725ms)
✔ list_bots makes directory destinations discoverable without persisting shadows (0.529917ms)
✔ remote lookup is case sensitive and retains the old missing-Bot result (1.621458ms)
✔ local names take precedence over a duplicate name in the remote directory (0.620416ms)
✔ remote send failure never reports success (0.613917ms)
✔ empty messages and group calls never leave through the network (0.589834ms)
✔ incoming ask injects a named user message, keeps the exchange id, and returns no automatic reply (3.282042ms)
✔ a node tool carries sender identity through the real joined handler to bot/turn (2.479333ms)
✔ node receiver ignores replies and warns about unknown or nonlocal ask destinations (0.643291ms)
✔ older remote-agent versions leave network support absent and preserve missing-Bot behavior (1.013958ms)
ℹ tests 32
ℹ suites 0
ℹ pass 32
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 155.32275

```
## Syntax check

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `0`.

```sh
node --check src/host/bot-network.js
```

Exact captured output (stdout and stderr combined):

```text
(no output)

```
## Whitespace check

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `0`.

```sh
git diff --check
```

Exact captured output (stdout and stderr combined):

```text
(no output)

```
## Repository lint

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `2`.

```sh
npm run lint
```

Exact captured output (stdout and stderr combined):

```text
npm warn Unknown env config "side-effects-cache". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> ds-bot@0.3.8-fork.55 lint
> node scripts/lint.mjs

lint: no oxlint found; run npm run harness, or set DSH_HARNESS to a deepseek-harness checkout

```


## Round 2

Both requested commands now exit 0: the combined room run has 18 passed / 0 failed (10 legacy room tests and the unchanged 8 membership tests); the bot-network run has 32 passed / 0 failed, including its two nested tests. Nothing was skipped.

Changes use the preferred approach; no fallback was needed:

- `test/peer-rooms.test.js:7` imports the existing `applyRosterReport` helper. No new harness or dependencies.
- `test/peer-rooms.test.js:112` creates a real joined bot for `n9`. Lines 113–114 include that bot in both public and private rooms alongside the two hub bots. Line 116 asserts the exact roster-ID array. The exact room summaries at lines 117 and 124 now assert three members in both the hub view and `n9`'s legitimate view, while excluding the private room even though `n9` has a member in it. Lines 120–125 retain the exact frame count, destination, type, bot directory and numeric timestamp assertions.
- `test/peer-rooms.test.js:136` creates an `n9` joined bot in the rename/membership test. Line 137 starts the room with three members. Line 142 retains that joined bot when dropping the other hub bot, leaving two members and keeping the room visible to `n9`. Lines 147 and 150 still prove no early frame and exactly one frame after the one-second debounce. Line 151 proves the bot directory stays unchanged. Line 152 proves the renamed room is sent with three members, then the membership update is sent with two members.
- The hub cap test at `test/peer-rooms.test.js:156` is untouched. No coverage moved, no tests were deleted, and no assertions were weakened. `test/peer-rooms-membership.test.js` is unchanged.

`src/host/bot-network.js` was not edited in Round 2 and is byte-identical to the accepted Round 1 version. Its SHA-256 before and after this round is:

```text
3546b0e66061d44fe021c6db79dbfbf4ee0d59865d55a66a86288a5d525c2e3c  src/host/bot-network.js
```

The unchanged Round 1 membership test SHA-256 is:

```text
84e74268338ae3cafb238962bb4459e40e0624a01e9cf3ef20360d260357972c  test/peer-rooms-membership.test.js
```

The only Round 2 edits are the legacy test file and this appended report section. `git diff --check` passed with no output. No whole-repository suite, installations, commits, pushes, protocol changes, timeout changes or service restarts. Tests used an isolated `DSH_HOME` with a synthetic settings file selecting loopback and port 0; temporary settings and runtime directories were removed after the runs, and fixture-owned listeners were disposed.

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `0`.

```sh
export DSH_HOME=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
node --test --test-force-exit --test-timeout=120000 test/peer-rooms.test.js test/peer-rooms-membership.test.js
```

Exact captured output (stdout and stderr combined):

```text
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64552
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64554
✔ node009 receives a room containing its roster bot and preserves the payload shape (96.503333ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64556
✔ node009 cannot see a room whose members belong only to node010 (10.26525ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64558
✔ a room containing bots from both nodes is visible to both (8.345958ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64560
✔ private rooms are excluded from every node including the hub (7.800333ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64562
✔ the hub keeps every non-private room and a node without member bots sees none (8.22375ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64564
✔ the 100-room cap applies after filtering for each node (7.416459ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64566
✔ replacing a member from another node republishes even when the member count stays the same (8.640334ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
✔ a failed directory send warns and continues to the next node (6.736875ms)
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64551
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64553
✔ a directory frame with rooms fills hubRooms and list_bots prints every room (95.907417ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64555
✔ a legacy bare array clears rooms and reports none you can see while the hub is online (9.818583ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64557
✔ invalid rooms are dropped and valid names are trimmed and capped at 40 characters (6.989708ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64559
✔ more than 100 valid rooms keeps exactly the first 100 (7.4545ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64561
✔ a stale directory clears rooms and peers using the injected time (7.678791ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-2 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-3 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-4 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64563
✔ hub payloads include real room member counts and exclude private rooms (8.595292ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-2 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-3 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64565
✔ room renames and membership changes republish without changing Bot rows (7.716542ms)
✔ hub room publication is capped at 100 visible rooms (0.224667ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: settingsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz credsDir=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
[ds-bot] ds-bot: gateway config host=127.0.0.1 port=0 from=yaml:/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz/settings.yaml
[ds-bot] ds-bot: gateway listening on 127.0.0.1:64567
✔ an untrusted directory cannot replace hub rooms (8.196958ms)
[ds-bot] ds-bot: session-1 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-2 needs the team tools but its Agent cannot register them yet
[ds-bot] ds-bot: session-3 needs the team tools but its Agent cannot register them yet
✔ a group or Bot scoped list suppresses the hub rooms (8.584792ms)
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 275.9035
```

Cwd: `/private/tmp/ds-up038/ds-bot`. Exit code: `0`.

```sh
export DSH_HOME=/private/tmp/ds-up038/ds-bot/.dsh-test-s6-1-round2-43zm6qvz
node --test --test-force-exit --test-timeout=120000 test/bot-network.test.js
```

Exact captured output (stdout and stderr combined):

```text
✔ the plugin assembles the Bot network module (0.501625ms)
✔ directory includes local and joined Bots, omits peers, and falls back to id for a name (0.658916ms)
✔ publishDirectory sends the current directory to every online node (0.269958ms)
✔ hub passes joined routing arguments with defer:true (stubbed handler) (0.202542ms)
✔ hub routes local asks and replies to the addressed Bot with the sender name (0.1605ms)
✔ hub routes replies to joined Bots through joined delivery too (0.166417ms)
✔ depth >= 3 is dropped before routing (0.129833ms)
✔ duplicate ask is suppressed for 60 seconds, without suppressing replies (0.3045ms)
✔ unknown and peer destinations warn and never execute locally (0.110916ms)
✔ private Bots stay outside the network directory and cannot receive network messages (0.117666ms)
▶ install provides an absent receiver and only sets and restores a provided receiver
  ✔ not provided (0.508542ms)
  ✔ already provided (0.132125ms)
✔ install provides an absent receiver and only sets and restores a provided receiver (0.778708ms)
✔ install registers the hub receiver and publishes on online, roster changes, and a 60s fallback (0.327833ms)
✔ install tolerates a network service without onMessage (0.0805ms)
✔ hub-shaped network service does not break list_bots (2.437375ms)
✔ hub-shaped network service preserves the missing-Bot message_bot result (0.971458ms)
✔ node-shaped network service still lists and routes to remote Bots (1.122209ms)
✔ install subscribes to onMessage once and unsubscribes on cleanup (0.554541ms)
✔ message_bot uses the live remote directory when the local lookup misses (0.608834ms)
✔ remote send passes the node identity validator with all three sender fields (0.711834ms)
✔ remote send falls back to the local sender id when its name is empty (0.520292ms)
✔ remote send refuses missing or invalid node identity before calling send (0.655708ms)
✔ list_bots makes directory destinations discoverable without persisting shadows (0.5095ms)
✔ remote lookup is case sensitive and retains the old missing-Bot result (1.622792ms)
✔ local names take precedence over a duplicate name in the remote directory (0.629625ms)
✔ remote send failure never reports success (0.635875ms)
✔ empty messages and group calls never leave through the network (2.883833ms)
✔ incoming ask injects a named user message, keeps the exchange id, and returns no automatic reply (0.555291ms)
✔ a node tool carries sender identity through the real joined handler to bot/turn (2.3445ms)
✔ node receiver ignores replies and warns about unknown or nonlocal ask destinations (0.628833ms)
✔ older remote-agent versions leave network support absent and preserve missing-Bot behavior (0.535959ms)
ℹ tests 32
ℹ suites 0
ℹ pass 32
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 141.363084
```
