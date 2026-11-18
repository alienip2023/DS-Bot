# Thread model and approval isolation

Facts only. Every `path:line` below was read at commit `131bc6ea` (DS-2) while writing DS-3. A claim the
source does not support is labelled **not verified**. Limits are labelled **DOCUMENTED** (a comment says so)
or **IMPLEMENTED** (code enforces it).

## 1. Ownership by class

### 1.1 Per Bot / per Session

- Thread rows and the Main thread id: the Main id is derived from the Bot id (`src/host/constants.js:13-18`,
  `MAIN_THREAD_ID`); `src/host/bot-store.js:155` documents the Main row field set.
- Session to Thread map `bySessionIdFullMap` (`src/host/store.js:638-639`), filled at `src/host/store.js:693`
  and `:719`.
- Session owners: `chatOwners` (`src/host/store.js:627`) and `groupOwners` (`src/host/store.js:629`).
- Pending approval entries, each keyed by id and carrying the `sessionId` that owns it
  (`src/host/approvals.js:45-`, stored at `:64`). The owner is resolved from `groupOwners` / `chatOwners`
  (`src/host/approvals.js:38-41`); a request from an unowned Session is passed on with `next()`.
- Inflight notes `turns` and `queued`, both keyed by Session id (`src/host/resume.js:155`, `:158`).
- The per-Bot gate slot and its FIFO queue: `slotOf(botId)` (`src/host/thread-queue.js:29-32`), used at
  `src/host/thread-queue.js:171`.

### 1.2 Thread-scoped

- Which saved conversation a Session runs in: `bySessionIdFullMap` (`src/host/store.js:638`).
- At most `MAX_THREADS_PER_BOT = 10` Threads per Bot, Main included (`src/host/constants.js:22-23`). The
  constant is declared there; where it is enforced is **not verified** in this task.
- One turn per Bot runs at a time across its Threads (section 4.5).

### 1.3 Process / profile-wide

- The `pending` approvals Map and the listener set: one per `install(rt)` call
  (`src/host/approvals.js:24-25`).
- `inflight.json` (`src/host/resume.js:150`) and its single write chain `writing` (`src/host/resume.js:160`
  ); persisting is skipped when `rt.readOnly() !== undefined` (`src/host/resume.js:166`).
- `state.json` and `state.lock`: the first host to load takes the lock, a second only reads
  (`src/host/home-lock.js:3`).
- Read-only host mode (`rt.readOnly()`, `src/host/channel.js:455-456`) and the `READS` allow-set
  (`src/host/channel.js:385`), which contains `approval-answer`. That is a compatibility allowance, not
  authentication.

## 4. Concurrency

### 4.5 One turn per Bot

- **DOCUMENTED**: the header comment of `src/host/thread-queue.js:1-11` says at most one running turn per Bot
  (`maxParallelThreads = 1`, a comment at `:5`, not a variable) and that the rest wait FIFO in memory.
- **IMPLEMENTED**: the per-Bot slot. A turn starts only when `slot.running === null`; otherwise it is pushed on
  `slot.queue` (`src/host/thread-queue.js:172-176`). The gate keys on `owner.botId`, so two Threads of one
  Bot share a slot.
- The send endpoint reaches the gate through `rt.sendThreadTurn` (`src/host/channel.js:1124-1125`).
- A turn accepted but never started is let go after `ACCEPT_WAIT_MS = 60_000` (`src/host/thread-queue.js:17`).

### Approval answers

- JavaScript runs on one thread. `settle` deletes the entry from `pending` before anything else
  (`src/host/approvals.js:69-72`), so two answers to one id resolve first-wins and the second throws
  `bot/stale` (`src/host/approvals.js:137`).
- `answerApproval(id, choice, binding)` (`src/host/approvals.js:135-146`) checks, in this order: the id names an
  open entry (`:137`); if a binding is given, both fields are strings equal to the stored ones
  (`:138-142`); `choice` is allow or reject (`:143-144`).
- The binding is a stale-card guard, not a credential or a caller identity. A matching binding cannot make an
  unknown, settled or foreign-session id answerable, nor an invalid choice valid.
- The binding is optional everywhere. `src/host/channel.js:897-898` passes `body.binding ?? undefined`; the web
  UI sends one when the view row carries both fields; the IM path sends none
  (`src/host/im/index.js:723-727`) because a card stores only the id.
- `cancelApprovals(sessionId)` settles only that Session's entries as `cancelled`
  (`src/host/approvals.js:149-152`).

## 5. Limits

| Limit | Class | Source |
|---|---|---|
| one running turn per Bot | IMPLEMENTED (slot) / DOCUMENTED (`maxParallelThreads = 1`) | `src/host/thread-queue.js:5`, `:171` |
| Threads per Bot = 10 | DOCUMENTED here; enforcement **not verified** | `src/host/constants.js:22-23` |
| accept wait 60 s | IMPLEMENTED | `src/host/thread-queue.js:17` |
| approval answer first-wins | IMPLEMENTED | `src/host/approvals.js:69-72` |

Not verified in DS-3 (plan section 10 items 7-8): `taken` dedup, codex/acp resume classes, tasks and
remote-tasks isolation. `src/host/joined-prompt.js:32` cites section 10 A2 of this document; no such section
exists here and none is invented.

## Restart

- Pending approvals and the thread queue are memory only (`src/host/thread-queue.js:9-10`).
- `inflight.json` records an approval as `{tool, reason}` only (`src/host/resume.js:155`, `:284-285`), so a
  restart never restores an id or fingerprint; an old card is stale.

## Owners

Approvals own `pending` and the answer; resume owns `inflight.json`; the thread queue owns slots. DS-3 adds no
owner, no ledger and no new endpoint.

## Rollback

Delete this file and the two client edits (`src/client/team-actions.js`, `src/client/member-status.js`), then
rebuild `client.js`. No data and no migration are involved.
