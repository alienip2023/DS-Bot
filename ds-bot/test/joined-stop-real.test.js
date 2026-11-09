// fork.70: Stop on a REAL Agent. The controller's original cancel here does what the core's
// commands.cancel does (dsh-api-session-controller index.js:1026): look the Session up among the live
// Agents and cancel that Agent, or throw session/not-found. Needs the agent-loop-testkit (test/real-agent.js).
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { makeWorld, textRequest, types } from './joined-world.js'
import { realAgentWorld, REAL_AGENT_SKIP } from './real-agent.js'

const MIRROR = 'mirror-1'

async function worldWithAgents() {
  const real = await realAgentWorld()
  const agents = new Map()
  const w = makeWorld({
    cancelImpl: async (request) => {
      const agent = agents.get(request.sessionId)
      if (agent === undefined) throw Object.assign(new Error(`session "${request.sessionId}" not found (not attached)`), { code: 'session/not-found' })
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return { accepted: true, from: 'core-cancel' }
    },
  })
  for (const id of ['ordinary-1', MIRROR]) {
    const agent = await real.create(id)
    mock.method(agent, 'cancel')
    agents.set(id, agent)
  }
  return { real, w, agents }
}

describe('S33-real: Stop and a real Agent', { skip: REAL_AGENT_SKIP }, () => {
  it('S33-real-a: Stop on a joined mirror Session never touches an Agent — not the ordinary Session\'s, not even one attached to the mirror Session itself — and the page turn ends', async () => {
    const { real, w, agents } = await worldWithAgents()
    try {
      await w.prompt(textRequest('stuck'))
      const ack = await w.cancel(MIRROR)
      assert.deepEqual(ack, { accepted: true })
      for (const [id, agent] of agents) assert.equal(agent.cancel.mock.callCount(), 0, `${id}: Agent.cancel was not called`)
      assert.equal(w.cancelCalls.length, 0, 'the original cancel was not called')
      assert.equal(w.sessionOf(MIRROR).log.at(-1).data.reason.kind, 'aborted')
      assert.equal(types(agents.get(MIRROR).session).includes('turn/start'), false, 'the mirror Agent started no turn')
    } finally { await real.dispose() }
  })

  it('S33-real-b: Stop on an ordinary Session still takes the original path — the real Agent is cancelled once with the core\'s arguments, the joined page turn is left in flight', async () => {
    const { real, w, agents } = await worldWithAgents()
    try {
      await w.prompt(textRequest('stuck'))
      const result = await w.controller.cancel({ sessionId: 'ordinary-1' })
      assert.equal(result.from, 'core-cancel')
      assert.equal(agents.get('ordinary-1').cancel.mock.callCount(), 1)
      assert.deepEqual(agents.get('ordinary-1').cancel.mock.calls[0].arguments, [{ kind: 'user' }, { keepInbox: true }])
      assert.equal(agents.get(MIRROR).cancel.mock.callCount(), 0)
      assert.equal(w.cancelCalls.length, 1)
      assert.equal(w.rt.joinedInFlight.has(w.bot.id), true, 'the joined turn was not stopped by an ordinary Stop')
    } finally { await real.dispose() }
  })

  it('S33-real-c: the session list and the running bit of an ordinary Session with a live Agent are not changed by a joined page turn in flight', async () => {
    const { real, w } = await worldWithAgents()
    try {
      await w.prompt(textRequest('stuck'))
      const list = await w.controller.list({}, new AbortController().signal)
      assert.equal(list.items.find(item => item.sessionId === 'ordinary-1'), w.listItems[1], 'the same object')
      assert.equal(list.items.find(item => item.sessionId === 'ordinary-2'), w.listItems[2])
      assert.deepEqual(w.statuses().filter(([id]) => id !== MIRROR), [], 'no status event for any other Session')
    } finally { await real.dispose() }
  })
})
