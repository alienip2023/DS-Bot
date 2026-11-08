# Mirror Session S0 Spike Report (v2 — re-run after review)

**Branch:** `feat/mirror-session` (from `745ac0c0`, fork.33)
**Date:** 2026-11-08
**Run command:** `node dev/spikes/mirror-spike.mjs` from ds-bot root

## Setup

Asar extracted: `npx @electron/asar extract "/Applications/DSH Desktop.app/Contents/Resources/app.asar" /tmp/dsh-asar`

Session construction:
```js
Session.create(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false }, 0, [])
```
Independent session (no SessionStore). `publicationEntry()` returns `undefined` for independent sessions → appends are permitted without announcement.

---

## P1 — Four-step append renders user/bot bubbles (runtime)

**Corrected shapes** (v1 had wrong user/message wrapper):
- `user/message`: data is the message object directly — `createUserMessage(...)` — NOT `{turn, message}`. `parts.js:1480` reads `event.data.content` and `event.data.source` directly.
- `assistant/message`: data is `{turn, step, message: createAssistantMessage(...)}`. `parts.js:1427` reads `event.data.message.content`.

**Output:**
```json
{
  "verdict": "PASS",
  "seqs": [0, 1, 2, 3],
  "user_msg_data_content": [{"type":"text","text":"Hello mirror"}],
  "user_msg_data_source_kind": "user",
  "bot_msg_data_message_content": [{"type":"text","text":"Hi back"}],
  "user_renderable": true,
  "bot_renderable": true,
  "events": [
    {"seq":0,"type":"turn/start","turn":1},
    {"seq":1,"type":"user/message","content":"Hello mirror","source_kind":"user"},
    {"seq":2,"type":"assistant/message","content":"Hi back","turn":1,"step":1},
    {"seq":3,"type":"turn/end","turn":1,"reason":"completed"}
  ]
}
```

**Renderer check (`src/host/parts.js:1479-1484`):**
- `event.data.source.kind === 'user'` → user bubble (✅ `user_msg_data_source_kind: "user"`)
- `Array.isArray(event.data.content)` → text content (✅ `user_msg_data_content` is array)
- `Array.isArray(event.data.message.content)` → bot bubble (✅ `bot_msg_data_message_content` is array)

**Persistence via fromRestore (surrogate):** Session.fromRestore with same id reloads all events with data equality verified (`eventsMatch: true`). `session/end-seed` is appended by fromRestore (expected behavior). **store-owned session (`sessionController.create`) deferred to S1** — SessionStore requires a full cordis ctx (inject/effect/parallel) not feasible in a standalone script; S1 first task is a sessionController.create integration test.

**Verdict: ✅ Feasible, primary route.**

---

## P2 — append does NOT trigger local model (runtime)

**Mock rt with `sessionController.prompt` call counter:**
```json
{
  "verdict": "PASS",
  "promptCallsBefore": 0,
  "promptCallsAfter": 0,
  "seqBefore": 0,
  "seqAfter": 1,
  "finding": "session.append(\"user/message\") adds 1 seq to log; sessionController.prompt call count stays 0"
}
```

**Evidence chain:**
- `dsh-agent-loop:546`: `this.inbox = new ReactLoopInbox(projections.inbox, session, this.dispatch)` — inbox is a field of AgentLoop, not of Session
- `session.append()` at `dsh-session:1524`: has no reference to inbox or sessionController
- Mock rt's `sessionController.prompt` counter = 0 before and after append

**Verdict: ✅ Feasible, primary route.**

---

## P3 — Turn numbering free; persistence via fromRestore (runtime)

```json
{
  "verdict": "PASS",
  "turn_free": "Session enforces seq contiguity only; turn value is plain data, any integer accepted",
  "seqs": [0, 1, 2],
  "turns": [42, 42, 100],
  "persistence_via_fromRestore": "OK",
  "original_event_count": 3,
  "restored_event_count": 4,
  "eventsMatch note": "all original events preserved; restored adds session/end-seed (expected)"
}
```

**Code evidence:** `dsh-session:1479`: `get seq() { return SessionLogOffset(this.log.length) }` — seq is internal; `validateSessionEventData` checks type string + JSON-serializability only.

**Idempotency:** Session has no dedup. Mirror must guard at application layer with `(botId, nodeSeq)` → already-written check before each append.

**Verdict: ✅ Feasible, primary route. Application-layer idempotency required.**

---

## P4 — Duplicate (turn, step) SESSION_ALLOWS_DUP (runtime)

```json
{
  "verdict": "SESSION_ALLOWS_DUP",
  "firstSeq": 1, "secondSeq": 2,
  "dupError": null,
  "implication": "RISK: two bot bubbles for same step; mirror must track written (turn,step) pairs and skip duplicates"
}
```

**Verdict: ⚠️ Application guard required. Session does not enforce (turn,step) uniqueness.**

---

## P5 — assistant/message without turn/start SESSION_ALLOWS (runtime)

```json
{"verdict":"SESSION_ALLOWS","seqIfAllowed":0,"renderer_note":"parts.js:1420 sets turn from turn/start; without it turn=undefined; assistant/message still emits bot bubble"}
```

**Verdict: ✅ Session allows; mirror should always write turn/start first for correct turn tracking.**

---

## P6 — Unknown event type SESSION_ALLOWS (runtime)

```json
{"verdict":"SESSION_ALLOWS","seq":0,"renderer_note":"parts.js falls through all if-cases; unknown types silently skipped; renderer does not crash"}
```

**Verdict: ✅ Safe. Mirror can write custom `mirror/sync-event` types for bookkeeping.**

---

## P7 — wrapSendUser lookup failure: real `install(rt)` evidence (runtime)

**Method:** `install(rt)` imported from real `src/host/joined-turn.js:205` (not a mock). Two scenarios.

```json
{
  "verdict": "RED_CONFIRMS_FIX_REQUIRED",
  "method": "real install(rt) from src/host/joined-turn.js:205, not mock",
  "scenarioA_without_bySessionId": {
    "botOf_mirrorSessionId": null,
    "isJoined": false,
    "promptCalls": 1,
    "handleJoinedTurnCalls": 0
  },
  "scenarioB_with_bySessionId_but_not_checked": {
    "bySessionId_exists": "function",
    "botOf_still_returns": null,
    "promptCalls": 1,
    "handleJoinedTurnCalls": 0
  },
  "red_evidence": "Scenario A: promptCalls=1 (local model runs). Scenario B: bySessionId exists on rt but wrapSendUser does not read it → promptCalls=1 still. This confirms the fix (adding bySessionId check in wrapSendUser) is REQUIRED."
}
```

**Root cause chain (`src/host/joined-turn.js:176-196`):**
1. `wrapSendUser:180`: `const bot = rt.botOf?.(args?.sessionId)` — looks up by `bot.id` only
2. After mirror: `bot.sessionId = realLocalSessionId ≠ bot.id` → `rt.botOf(mirrorSessionId) = undefined`
3. `joinedShadow(undefined) = false` → falls through to `orig(args)` → local model handles it (BUG)
4. Scenario B confirms: even with `rt.bySessionId` function present, wrapSendUser ignores it — `promptCalls=1` both scenarios

**Fix:** `joined-turn.js:180` must check `rt.bySessionId?.(args.sessionId)` before `rt.botOf(args.sessionId)`.

**`channel.js:780 sessionController.prompt` is the only direct-prompt entry bypassing `agent.followup`.**
Guard boundaries: `resolveAgent` (delivery.js:11) + `sessionController.prompt` (channel.js:780).

**Verdict: ✅ RED evidence confirmed. Fix is required before S1.**

## P8 — turn/end closes generating state (runtime)

```json
{
  "verdict": "PASS",
  "turnEndSeq": 2,
  "logTypes": ["turn/start","assistant/message","turn/end"],
  "parts_js_evidence": "parts.js:1337-1342 lastTurnEnd() scans backward; parts.js:1348-1350 releaseRescued() clears on non-error turn/end"
}
```

**Verdict: ✅ Writing turn/end closes generating state.**

---

## Summary

| P# | Verdict | Type | Route |
|----|---------|------|-------|
| P1 | ✅ PASS | runtime | Primary |
| P2 | ✅ PASS | runtime | Primary |
| P3 | ✅ PASS (store-owned deferred to S1) | runtime | Primary + app idempotency |
| P4 | ⚠️ SESSION_ALLOWS_DUP | runtime | Primary + app (turn,step) dedup |
| P5 | ✅ SESSION_ALLOWS | runtime | Primary (write turn/start first) |
| P6 | ✅ SESSION_ALLOWS | runtime | Primary (safe) |
| P7 | ✅ PASS | runtime | Primary + bySessionId reverse index |
| P8 | ✅ PASS | runtime | Primary |

**Overall: ✅ Primary route (session.append) is feasible. No fallback routes (A/B/C) needed.**

Two application-layer guards required for S1:
1. **(turn, step) dedup** — track written pairs, skip re-append
2. **bySessionId reverse index** — populate at bot.sessionId assignment; check in wrapSendUser before botOf

## Reproducibility

Script: `dev/spikes/mirror-spike.mjs`
Prerequisite: `npx @electron/asar extract "/Applications/DSH Desktop.app/Contents/Resources/app.asar" /tmp/dsh-asar`
Run: `node dev/spikes/mirror-spike.mjs` from ds-bot root
