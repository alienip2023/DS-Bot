// Node Bots have no screen: what they wait on (a tool approval, an ask_user question, a learned-skill
// proposal) is reported to the hub, shown there where a local Bot's cards appear, and the user's
// answer comes back as a bot/action the node applies. Unit level: the node half and the hub half.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotActionReceiver, installHub, nodeCardsOf, sendBotAction } from '../src/host/node-cards.js'
import { applyRosterReport, reportableBots } from '../src/host/roster-join.js'

// ── the node ────────────────────────────────────────────────────────────────

function nodeRt(over = {}) {
  const calls = []
  const rt = {
    state: { bots: { b1: { id: 'b1', name: 'Worker', tasks: [{ id: 't1', title: 'Build', status: 'running' }] } }, questions: {} },
    botOf: id => rt.state.bots[id],
    chatOf: id => `chat-${id}`,
    approvalsView: () => [],
    learningView: () => ({}),
    learningEndpoint: async (...args) => { calls.push(['learning', ...args]); return { applied: true } },
    answerApproval: async (...args) => { calls.push(['approval', ...args]) },
    answerQuestion: async (...args) => { calls.push(['question', ...args]) },
    stopTask: async (...args) => { calls.push(['stopTask', ...args]); return true },
    deliverToTask: async (...args) => { calls.push(['deliverToTask', ...args]) },
    ...over,
  }
  return { rt, calls }
}

test('the cards a Bot waits on: approvals, the ask_user question, skill and rule proposals', () => {
  const { rt } = nodeRt({
    approvalsView: () => [
      { id: 'a1', botId: 'b1', sessionId: 'chat-b1', fingerprint: 'fp', tool: 'bash', reason: 'needs to run', detail: { text: 'rm -rf build' }, answerable: true, at: 5 },
      { id: 'a2', botId: 'other', answerable: true },
      { id: 'a3', botId: 'b1', answerable: false },
    ],
    learningView: () => ({ b1: [
      { id: 'p1', kind: 'skill', action: 'create', botId: 'b1', name: 'release-notes', description: 'How to write them', content: 'Step one' },
      { id: 'p2', kind: 'agents', botId: 'b1', folder: '/repo', edits: [{ op: 'add', text: 'Use pnpm' }] },
    ] }),
  })
  rt.state.questions['chat-b1'] = { id: 'q1', question: 'Which branch?', detail: 'for the release', options: [{ label: 'main' }, { label: 'dev', description: 'unstable' }], allowCustom: true, askedAt: 7 }
  const cards = nodeCardsOf(rt, rt.state.bots.b1)
  assert.deepEqual(cards.map(card => [card.id, card.kind]), [['approval:a1', 'approval'], ['question:q1', 'question'], ['learning:p1', 'skill'], ['learning:p2', 'rule']])
  assert.deepEqual(cards[1].options, [{ id: '0', label: 'main' }, { id: '1', label: 'dev' }])
  assert.equal(cards[1].input, true)
  assert.deepEqual(cards[2].options.map(option => option.id), ['approve', 'approve-team', 'decline'])
  assert.deepEqual(cards[3].options.map(option => option.id), ['approve', 'decline'], 'a rule is not shared as a team skill')
  assert.equal(nodeCardsOf(rt, { id: 'j', origin: 'joined' }).length, 0, 'a shadow row reports nothing')
})

test('the roster entry carries the cards only when a card view is given', () => {
  const bots = { b1: { id: 'b1', name: 'W' } }
  assert.equal('cards' in reportableBots(bots)[0], false)
  assert.deepEqual(reportableBots(bots, undefined, () => [])[0].cards, [])
})

test('answering: an approval, a question (by option or in words), a proposal, each applied on the node', async () => {
  const { rt, calls } = nodeRt({
    approvalsView: () => [{ id: 'a1', botId: 'b1', sessionId: 'chat-b1', fingerprint: 'fp', answerable: true }],
    learningView: () => ({ b1: [{ id: 'p1', kind: 'skill', botId: 'b1', name: 'x' }] }),
  })
  rt.state.questions['chat-b1'] = { id: 'q1', question: 'Which?', options: [{ label: 'main' }, { label: 'dev' }] }
  const act = createBotActionReceiver(rt)
  assert.deepEqual(await act({ remoteBotId: 'b1', action: 'card-answer', params: { cardId: 'approval:a1', choice: 'allow' } }), { ok: true })
  assert.deepEqual(calls.at(-1), ['approval', 'a1', 'allow', { sessionId: 'chat-b1', fingerprint: 'fp' }])
  assert.deepEqual(await act({ remoteBotId: 'b1', action: 'card-answer', params: { cardId: 'question:q1', choice: '1' } }), { ok: true })
  assert.deepEqual(calls.at(-1), ['question', 'chat-b1', 'q1', { selected: ['dev'] }])
  await act({ remoteBotId: 'b1', action: 'card-answer', params: { cardId: 'question:q1', text: 'release/2' } })
  assert.deepEqual(calls.at(-1), ['question', 'chat-b1', 'q1', { selected: [], custom: 'release/2' }])
  assert.equal((await act({ remoteBotId: 'b1', action: 'card-answer', params: { cardId: 'learning:p1', choice: 'approve-team' } })).detail, 'applied')
  assert.deepEqual(calls.at(-1), ['learning', 'learning-answer', { id: 'p1', approve: true, teamReusable: true }])
})

test('a card or task that is gone, a bad choice, an unknown bot, a throw: each a refusal, never a crash', async () => {
  const { rt } = nodeRt({ answerApproval: async () => { throw Object.assign(new Error('closed'), { code: 'bot/stale' }) }, approvalsView: () => [{ id: 'a1', botId: 'b1', sessionId: 's', fingerprint: 'f', answerable: true }] })
  const act = createBotActionReceiver(rt)
  assert.equal((await act({ remoteBotId: 'b1', action: 'card-answer', params: { cardId: 'approval:zzz', choice: 'allow' } })).error, 'card-stale')
  assert.equal((await act({ remoteBotId: 'b1', action: 'card-answer', params: { cardId: 'approval:a1', choice: 'maybe' } })).error, 'choice-invalid')
  assert.equal((await act({ remoteBotId: 'b1', action: 'card-answer', params: { cardId: 'approval:a1', choice: 'allow' } })).error, 'bot/stale')
  assert.equal((await act({ remoteBotId: 'nope', action: 'task-stop', params: { taskId: 't1' } })).error, 'bot-not-on-roster')
  assert.equal((await act({ remoteBotId: 'b1', action: 'task-stop', params: { taskId: 'tx' } })).error, 'task-unknown')
  assert.equal((await act({ remoteBotId: 'b1', action: 'card-answer', params: { cardId: 'weird' } })).error, 'card-id-invalid')
})

test('stopping and following up a task go to the node Bot\'s own task', async () => {
  const { rt, calls } = nodeRt()
  const act = createBotActionReceiver(rt)
  assert.deepEqual(await act({ remoteBotId: 'b1', action: 'task-stop', params: { taskId: 't1' } }), { ok: true, detail: 'stopped' })
  assert.equal(calls.at(-1)[0], 'stopTask')
  await act({ remoteBotId: 'b1', action: 'task-send', params: { taskId: 't1', text: 'also x' } })
  assert.deepEqual(calls.at(-1), ['deliverToTask', 't1', { text: 'also x' }])
})

// ── the hub ─────────────────────────────────────────────────────────────────

function hubWorld() {
  const sent = []
  const listeners = []
  const registry = {
    send: (nodeId, type, payload) => { sent.push({ nodeId, type, payload }); return true },
    on: (name, fn) => listeners.push({ name, fn }),
    off: (name, fn) => { const at = listeners.findIndex(item => item.fn === fn); if (at >= 0) listeners.splice(at, 1) },
  }
  const bot = { id: 'joined:n1:b1', name: 'W', origin: 'joined', type: 'remote-worker', sessionId: 'mirror-1', worker: { nodeId: 'n1', remoteBotId: 'b1', home: 'remote', online: true } }
  const calls = []
  const rt = {
    ctx: { get: name => (name === 'remote-agent:registry' ? registry : undefined) },
    state: { bots: { [bot.id]: bot } },
    botOf: id => rt.state.bots[id],
    chatOf: id => rt.state.bots[id]?.sessionId ?? id,
    save: async () => {},
    approvalsView: () => [{ id: 'local', botId: 'x' }],
    learningView: () => ({ other: [{ id: 'keep' }] }),
    answerApproval: async (...args) => { calls.push(['local-approval', ...args]) },
    answerQuestion: async (...args) => { calls.push(['local-question', ...args]) },
    learningEndpoint: async (...args) => { calls.push(['local-learning', ...args]); return { applied: true } },
    stopTask: async (...args) => { calls.push(['local-stop', ...args]); return true },
    deliverToTask: async (...args) => { calls.push(['local-send', ...args]) },
  }
  installHub(rt)
  // the node answers every bot/action it is sent
  const reply = (over = {}) => {
    const request = sent.at(-1).payload
    for (const item of [...listeners]) if (item.name === 'botActionResult') item.fn({ requestId: request.requestId, nodeId: 'n1', ok: true, error: null, detail: null, ...over })
  }
  return { rt, bot, sent, calls, reply, listeners }
}
const nodeCard = (over = {}) => ({ id: 'question:q1', kind: 'question', title: 'Which branch?', body: '', options: [{ id: '0', label: 'main' }, { id: '1', label: 'dev' }], input: true, at: 3, ...over })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('node cards show where a local Bot\'s do: the question, the approval, the proposal', () => {
  const w = hubWorld()
  w.bot.nodeCards = [
    nodeCard(),
    nodeCard({ id: 'approval:a1', kind: 'approval', title: 'bash', body: 'rm -rf build', options: [] }),
    nodeCard({ id: 'learning:p1', kind: 'skill', title: 'release-notes', body: 'Step one', options: [] }),
  ]
  assert.deepEqual(w.rt.nodeQuestionsView()['mirror-1'], { id: 'question:q1', question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }], multiSelect: false, allowCustom: true, askedAt: 3, remote: true })
  assert.deepEqual(w.rt.approvalsView().map(item => item.id), ['local', 'approval:a1'])
  assert.equal(w.rt.approvalsView()[1].answerable, true)
  assert.deepEqual(w.rt.learningView().other, [{ id: 'keep' }])
  assert.equal(w.rt.learningView()[w.bot.id][0].content, 'Step one')
  w.bot.worker.online = false
  assert.deepEqual(w.rt.nodeQuestionsView(), {}, 'a node that is down shows none')
})

test('answering a node card sends a bot/action, waits for the result, and the card leaves the page', async () => {
  const w = hubWorld()
  w.bot.nodeCards = [nodeCard()]
  const done = w.rt.answerQuestion('mirror-1', 'question:q1', { selected: ['dev'] })
  await tick()
  assert.equal(w.sent[0].type, 'bot/action')
  assert.deepEqual(w.sent[0].payload.params, { cardId: 'question:q1', choice: '1' })
  assert.equal(w.sent[0].payload.remoteBotId, 'b1')
  w.reply()
  assert.equal(await done, true)
  assert.deepEqual(w.bot.nodeCards, [])
  assert.equal(w.calls.length, 0, 'the local answer path was not touched')
  assert.equal(w.listeners.length, 0, 'the result listener is gone')
})

test('a local card still takes the local path; the node\'s refusals reach the user as a reason', async () => {
  const w = hubWorld()
  await w.rt.answerApproval('local-id', 'allow')
  await w.rt.answerQuestion('s', 'local-q', { selected: ['x'] })
  assert.deepEqual(w.calls.map(call => call[0]), ['local-approval', 'local-question'])
  w.bot.nodeCards = [nodeCard({ id: 'approval:a1', kind: 'approval', options: [] })]
  const refused = w.rt.answerApproval('approval:a1', 'allow')
  await tick()
  w.reply({ ok: false, error: 'card-stale' })
  await assert.rejects(refused, error => error.code === 'bot/stale' && /不在节点上/.test(error.message))
  assert.equal(w.bot.nodeCards.length, 1, 'a refused answer leaves the card')
})

test('proposals, task stop and follow-up go to the node; an offline node and a timeout are refusals', async () => {
  const w = hubWorld()
  w.bot.nodeCards = [nodeCard({ id: 'learning:p1', kind: 'skill', options: [] })]
  w.bot.nodeTasks = [{ id: 't1', title: 'Build', status: 'running', startedAt: 1 }]
  const learn = w.rt.learningEndpoint('learning-answer', { id: 'learning:p1', approve: true, teamReusable: true })
  await tick(); assert.equal(w.sent.at(-1).payload.params.choice, 'approve-team'); w.reply()
  assert.deepEqual(await learn, { applied: true })
  const stop = w.rt.stopTask(w.bot.id, 't1')
  await tick(); assert.equal(w.sent.at(-1).payload.action, 'task-stop'); w.reply({ detail: 'stopped' })
  assert.equal(await stop, true)
  const send = w.rt.deliverToTask('t1', { text: 'also x' })
  await tick(); assert.deepEqual(w.sent.at(-1).payload.params, { taskId: 't1', text: 'also x' }); w.reply()
  assert.equal(await send, true)
  assert.equal(w.rt.nodeTaskOf(w.bot, 't1').id, 't1')
  await w.rt.stopTask('local-bot', 'tx'); assert.equal(w.calls.at(-1)[0], 'local-stop')
  await assert.rejects(sendBotAction(w.rt, w.bot, 'task-stop', { taskId: 't1' }, { timeoutMs: 10 }), /没有及时回应/)
  w.rt.ctx.get = () => ({ send: () => false, on() {}, off() {} })
  await assert.rejects(sendBotAction(w.rt, w.bot, 'task-stop', { taskId: 't1' }), /不在线/)
})

test('the hub keeps the reported cards on the shadow row, clears them on an empty list', () => {
  const state = { bots: {}, mainBotIds: [] }
  const report = cards => ({ nodeId: 'n1', hostname: 'h', online: true, bots: [{ id: 'b1', name: 'W', role: '', cards }] })
  applyRosterReport(state, report([nodeCard()]))
  const row = Object.values(state.bots)[0]
  assert.equal(row.nodeCards[0].id, 'question:q1')
  const same = row.nodeCards
  applyRosterReport(state, report([nodeCard()]))
  assert.equal(Object.values(state.bots)[0].nodeCards, same, 'an unchanged list keeps the same array')
  applyRosterReport(state, report([]))
  assert.deepEqual(Object.values(state.bots)[0].nodeCards, [])
})
