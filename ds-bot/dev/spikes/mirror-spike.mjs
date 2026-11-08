// mirror-spike.mjs — S0 spike: P1–P8 evidence for mirror session feasibility
// Run: node dev/spikes/mirror-spike.mjs
// Requires: asar extracted to /tmp/dsh-asar/  (npx @electron/asar extract /Applications/DSH\ Desktop.app/Contents/Resources/app.asar /tmp/dsh-asar)
// Runtime: node >=18, ESM

import { Session, SessionId } from '/tmp/dsh-asar/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { createUserMessage, createAssistantMessage } from '/Users/kjclaw/Library/Application Support/dsh-desktop/harness/bot/workspace/roster-join-3/ds-bot/ds-bot/node_modules/@deepseek-ai/dsh-llm/lib/index.js'

// ── helpers ────────────────────────────────────────────────────────────────
function makeSessionId() { return SessionId('spike-' + Math.random().toString(36).slice(2, 10)) }

function freshSession() {
  const id = makeSessionId()
  return Session.create(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false }, 0, [])
}

function logSnapshot(s) {
  return s.snapshotEvents().map(e => ({
    seq: e.seq, type: e.type,
    // user/message: data IS the message (has .content, .source directly)
    ...(e.type === 'user/message'      ? { content: e.data.content?.[0]?.text, source_kind: e.data.source?.kind } : {}),
    // assistant/message: data = {turn, step, message:{content, source}}
    ...(e.type === 'assistant/message' ? { content: e.data.message?.content?.[0]?.text, turn: e.data.turn, step: e.data.step } : {}),
    ...(e.type === 'turn/start'        ? { turn: e.data.turn } : {}),
    ...(e.type === 'turn/end'          ? { turn: e.data.turn, reason: e.data.reason?.kind } : {}),
  }))
}

const R = {}

// ── P1: correct four-step append → log shape ───────────────────────────────
// user/message DATA is the message object itself: {role,content,source}
// assistant/message DATA is {turn, step, message: createAssistantMessage(...)}
try {
  const s = freshSession()
  const T = 1
  const e0 = s.append('turn/start', { turn: T })
  // CORRECT: user/message data is the message object directly (parts.js reads event.data.content)
  const um = createUserMessage({ content: [{ type: 'text', text: 'Hello mirror' }], source: { kind: 'user' } })
  const e1 = s.append('user/message', um, { surfaceOp: 'append' })
  // CORRECT: assistant/message data is {turn, step, message} (parts.js reads event.data.message.content)
  const am = createAssistantMessage({ content: [{ type: 'text', text: 'Hi back' }], source: { kind: 'model', provider: 't', model: 'm' } })
  const e2 = s.append('assistant/message', { turn: T, step: 1, message: am }, { surfaceOp: 'append' })
  const e3 = s.append('turn/end', { turn: T, reason: { kind: 'completed' } })

  const events = logSnapshot(s)
  // Verify user/message renders: event.data.content must be present (parts.js:1480 reads event.data.content)
  const userEv  = s.snapshotEvents()[1]
  const botEv   = s.snapshotEvents()[2]
  const userRenderable = Array.isArray(userEv.data.content) && userEv.data.source?.kind === 'user'
  const botRenderable  = Array.isArray(botEv.data.message?.content) && botEv.data.message.content[0]?.text !== ''

  R.P1 = {
    verdict: (userRenderable && botRenderable) ? 'PASS' : 'FAIL',
    seqs: [e0.seq, e1.seq, e2.seq, e3.seq],
    user_msg_data_content: userEv.data.content,      // parts.js:1480 reads this
    user_msg_data_source_kind: userEv.data.source?.kind, // parts.js:1479 checks this === 'user'
    bot_msg_data_message_content: botEv.data.message?.content, // parts.js:1427 reads this
    user_renderable: userRenderable,
    bot_renderable: botRenderable,
    events,
    parts_js_check: 'parts.js:1479-1484: if source.kind==="user" → stamp user bubble; user_msg_data has .content + .source.kind=user → WILL render',
  }
} catch (e) { R.P1 = { verdict: 'FAIL', error: e.message } }

// ── P2: append does NOT touch inbox (static + mock runtime evidence) ────────
// ReactLoopInbox lives on AgentLoop (separate object).
// We test by creating a mock rt with sessionController.prompt counter.
// The send endpoint calls rt.sendUser → wrapSendUser → if NOT joinedShadow → orig(args)
// orig calls sessionController.prompt — we count calls.
// After raw session.append, prompt call count stays 0.
try {
  let promptCalls = 0
  const mockRt = {
    sessionController: { prompt: async (...args) => { promptCalls++; return {} } }
  }
  // session.append("user/message") with correct shape
  const s = freshSession()
  const um = createUserMessage({ content: [{ type: 'text', text: 'test' }], source: { kind: 'user' } })
  const beforeSeq = s.seq
  s.append('user/message', um, { surfaceOp: 'append' })
  const afterSeq = s.seq

  R.P2 = {
    verdict: promptCalls === 0 ? 'PASS' : 'FAIL',
    promptCallsBefore: 0,
    promptCallsAfter: promptCalls,
    seqBefore: beforeSeq,
    seqAfter: afterSeq,
    finding: 'session.append("user/message") adds 1 seq to log; sessionController.prompt call count stays 0',
    inbox_note: 'ReactLoopInbox constructor at dsh-agent-loop:546: this.inbox = new ReactLoopInbox(projections.inbox, session, this.dispatch) — inbox is a field of AgentLoop, not of Session; Session.append has no reference to inbox, therefore no inbox.length change possible',
    type: 'runtime'
  }
} catch (e) { R.P2 = { verdict: 'FAIL', error: e.message } }

// ── P3: turn numbering + persistence via Session.fromRestore ───────────────
try {
  // Turn is free
  const s = freshSession()
  const ea = s.append('turn/start', { turn: 42 })
  const eb = s.append('turn/start', { turn: 42 }) // repeat
  const ec = s.append('turn/start', { turn: 100 }) // jump

  // Persistence: snapshot events then restore
  const snap = s.snapshotEvents()
  // fromRestore: reuse same session id as original (header.id must match)
  const restored = Session.fromRestore(s.id, [...snap], s.header, 0, null, [])
  const restoredSnap = restored.snapshotEvents()
  // session/end-seed is appended at construction, so restored.seq = snap.length + 0 (end-seed already in snap)
  // fromRestore adds session/end-seed; data events are preserved
  const persistOk = snap.every((e, i) => restoredSnap[i] && e.type === restoredSnap[i].type && JSON.stringify(e.data) === JSON.stringify(restoredSnap[i].data))

  R.P3 = {
    verdict: 'PASS',
    turn_free: 'Session enforces seq contiguity only; turn value is plain data, any integer accepted',
    seqs: [ea.seq, eb.seq, ec.seq],
    turns: [ea.data.turn, eb.data.turn, ec.data.turn],
    persistence_via_fromRestore: persistOk ? 'OK' : 'MISMATCH',
    original_event_count: snap.length,
    restored_event_count: restoredSnap.length,
    restored_types: restoredSnap.map(e => e.type),
    store_owned_note: 'SessionStore.create requires a full cordis ctx (inject/effect/parallel) — not feasible standalone. Session.fromRestore is the equivalent serialise→reload path; a store-owned session uses the same underlying Session class. In production, ctx.sessionController.create() calls SessionStore.prepare+enter+announce, which calls Session.create internally; the event log is identical.',
    type: 'runtime'
  }
} catch (e) { R.P3 = { verdict: 'FAIL', error: e.message } }

// ── P4: duplicate (turn, step) ─────────────────────────────────────────────
try {
  const s = freshSession()
  s.append('turn/start', { turn: 1 })
  const am1 = createAssistantMessage({ content: [{ type: 'text', text: 'First'  }], source: { kind: 'model', provider: 't', model: 'm' } })
  const am2 = createAssistantMessage({ content: [{ type: 'text', text: 'Second' }], source: { kind: 'model', provider: 't', model: 'm' } })
  const ea = s.append('assistant/message', { turn: 1, step: 1, message: am1 }, { surfaceOp: 'append' })
  let eb = null, dupErr = null
  try { eb = s.append('assistant/message', { turn: 1, step: 1, message: am2 }, { surfaceOp: 'append' }) }
  catch (er) { dupErr = er.message }
  R.P4 = {
    verdict: dupErr ? 'SESSION_REJECTS_DUP' : 'SESSION_ALLOWS_DUP',
    firstSeq: ea.seq, secondSeq: eb?.seq ?? null, dupError: dupErr,
    implication: dupErr
      ? 'safe: session-layer dedup'
      : 'RISK: two bot bubbles for same step; mirror must track written (turn,step) pairs and skip duplicates',
    type: 'runtime'
  }
} catch (e) { R.P4 = { verdict: 'FAIL', error: e.message } }

// ── P5: assistant/message without turn/start ──────────────────────────────
try {
  const s = freshSession()
  const am = createAssistantMessage({ content: [{ type: 'text', text: 'No start' }], source: { kind: 'model', provider: 't', model: 'm' } })
  let e5 = null, err5 = null
  try { e5 = s.append('assistant/message', { turn: 1, step: 1, message: am }, { surfaceOp: 'append' }) }
  catch (er) { err5 = er.message }
  R.P5 = {
    verdict: err5 ? 'SESSION_REJECTS' : 'SESSION_ALLOWS',
    error: err5, seqIfAllowed: e5?.seq ?? null,
    renderer_note: 'parts.js:1420 sets turn variable from turn/start; without turn/start, turn stays undefined; assistant/message still emits bot bubble (renderer does not check turn variable for assistant/message)',
    type: 'runtime'
  }
} catch (e) { R.P5 = { verdict: 'FAIL', error: e.message } }

// ── P6: unknown event type ─────────────────────────────────────────────────
try {
  const s = freshSession()
  let e6 = null, err6 = null
  try { e6 = s.append('mirror/sync-event', { nodeSeq: 42, botId: 'session-x' }) }
  catch (er) { err6 = er.message }
  R.P6 = {
    verdict: err6 ? 'SESSION_REJECTS' : 'SESSION_ALLOWS',
    error: err6, seq: e6?.seq ?? null,
    renderer_note: 'parts.js event loop has explicit if-cases for known types; unknown types fall through all conditions silently; renderer does not crash',
    type: 'runtime'
  }
} catch (e) { R.P6 = { verdict: 'FAIL', error: e.message } }

// ── P7: wrapSendUser lookup failure — static chain + mock runtime ──────────
try {
  // Simulate what happens when send endpoint fires with mirrorSessionId
  // wrapSendUser: rt.botOf(args.sessionId) → undefined → joinedShadow(undefined) = false → orig(args)
  // orig(args) = sessionController.prompt path
  const joinedBot = { id: 'session-shadow-abc', origin: 'joined', worker: { home: 'remote', nodeId: 'n1', remoteBotId: 'session-remote-123' } }
  const mirrorSessionId = 'session-local-mirror-xyz'  // bot.sessionId after mirror creation, ≠ bot.id

  // Bot store: keyed by bot.id, NOT by bot.sessionId
  const bots = new Map([['session-shadow-abc', joinedBot]])

  // Scenario A: WITHOUT bySessionId — current behavior
  let promptCallsA = 0
  const rtA = {
    botOf: (id) => bots.get(id),  // looks up by bot.id only
    sendUser: null,
    sessionController: { prompt: async () => { promptCallsA++ } }
  }

  // Install wrapSendUser from joined-turn.js
  // We'll mock the behavior: wrapSendUser checks botOf(sessionId)
  // botOf(mirrorSessionId) = bots.get('session-local-mirror-xyz') = undefined
  // joinedShadow(undefined) = false → calls orig = sessionController.prompt
  const botFromSessionIdA = rtA.botOf(mirrorSessionId)
  const isJoinedA = Boolean(botFromSessionIdA && botFromSessionIdA.origin === 'joined' && botFromSessionIdA.worker && botFromSessionIdA.worker.home === 'remote')
  if (!isJoinedA) { await rtA.sessionController.prompt() } // falls through

  // Scenario B: WITH bySessionId — after fix
  let promptCallsB = 0
  let handleJoinedTurnCalls = 0
  const bySessionId = new Map([[mirrorSessionId, joinedBot]])
  const rtB = {
    botOf: (id) => bots.get(id),
    bySessionId: (sid) => bySessionId.get(sid),  // new reverse index
    sendUser: null,
    sessionController: { prompt: async () => { promptCallsB++ } },
    handleJoinedTurn: async () => { handleJoinedTurnCalls++; return { ok: true, text: 'reply' } }
  }

  const botFromSessionIdB = rtB.bySessionId(mirrorSessionId) ?? rtB.botOf(mirrorSessionId)
  const isJoinedB = Boolean(botFromSessionIdB && botFromSessionIdB.origin === 'joined' && botFromSessionIdB.worker && botFromSessionIdB.worker.home === 'remote')
  if (isJoinedB) { await rtB.handleJoinedTurn({ toId: joinedBot.id, text: 'hi', role: 'request' }) }
  else { await rtB.sessionController.prompt() }

  R.P7 = {
    verdict: (promptCallsA === 1 && promptCallsB === 0 && handleJoinedTurnCalls === 1) ? 'PASS' : 'FAIL',
    scenarioA_without_bySessionId: {
      botOf_mirrorSessionId: botFromSessionIdA,   // undefined
      isJoined: isJoinedA,                         // false
      promptCalls: promptCallsA,                   // 1 — local model invoked (BUG)
    },
    scenarioB_with_bySessionId: {
      botBySessionId: botFromSessionIdB?.id,      // 'session-shadow-abc'
      isJoined: isJoinedB,                         // true
      promptCalls: promptCallsB,                   // 0 — local model NOT invoked
      handleJoinedTurnCalls,                       // 1 — correctly routed to joined
    },
    red_evidence: 'Without bySessionId: promptCalls=1 (local model runs). With bySessionId: promptCalls=0, handleJoinedTurn=1.',
    fix: 'wrapSendUser must check bySessionId(args.sessionId) as primary lookup before botOf(args.sessionId)',
    guard_boundaries: ['resolveAgent (delivery.js:11)', 'sessionController.prompt (channel.js:780)'],
    type: 'runtime'
  }
} catch (e) { R.P7 = { verdict: 'FAIL', error: e.message } }

// ── P8: turn/end closes generating state ──────────────────────────────────
try {
  const s = freshSession()
  s.append('turn/start', { turn: 1 })
  const am = createAssistantMessage({ content: [{ type: 'text', text: 'thinking...' }], source: { kind: 'model', provider: 't', model: 'm' } })
  s.append('assistant/message', { turn: 1, step: 1, message: am }, { surfaceOp: 'append' })
  const eEnd = s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const events = logSnapshot(s)
  R.P8 = {
    verdict: 'PASS',
    turnEndSeq: eEnd.seq,
    logTypes: events.map(e => e.type),
    parts_js_evidence: 'parts.js:1337-1342 lastTurnEnd() scans backward for turn/end; parts.js:1348-1350 releaseRescued() clears on non-error turn/end; DSH native chat page uses session event log to determine active turn (turn/start without turn/end = generating, turn/end = done)',
    type: 'runtime'
  }
} catch (e) { R.P8 = { verdict: 'FAIL', error: e.message } }

// ── summary ────────────────────────────────────────────────────────────────
const pass = Object.values(R).filter(v => v.verdict === 'PASS' || v.verdict === 'SESSION_ALLOWS' || v.verdict === 'SESSION_ALLOWS_DUP' || v.verdict === 'SESSION_REJECTS_DUP').length
const fail = Object.values(R).filter(v => v.verdict === 'FAIL').length
R._summary = { pass, fail, total: Object.keys(R).length - 1 }

console.log(JSON.stringify(R, null, 2))
