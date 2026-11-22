// "Ask me first" cards: one left over from a run before a restart has no waiter and is dropped, and a
// message that was asked about and then did not go says so on the page instead of vanishing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, STEER_ASK_CHOICES } from '../src/host/steer-ask.js'

function fakeRt(questions = {}) {
  const warns = []
  const shown = []
  const answered = []
  let saves = 0
  const rt = {
    state: { questions },
    warn: (...args) => { warns.push(args) },
    save: async () => { saves += 1 },
    cardShown: (...args) => { shown.push(args) },
    load: async () => {},
    answerQuestion: async (...args) => { answered.push(args); return 'original' },
    steerAskTimeoutMs: 60_000,
  }
  install(rt)
  return { rt, warns, shown, answered, saves: () => saves }
}
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)) }

test('after a restart the leftover ask card is dropped on load, other questions stay', async () => {
  const { rt, saves } = fakeRt({
    s1: { id: 'ask-123', question: '这条消息怎么处理？', options: [] },
    s2: { id: 'call-9', question: 'Real question', options: [] },
  })
  await rt.load()
  assert.equal(rt.state.questions.s1, undefined)
  assert.equal(rt.state.questions.s2.id, 'call-9')
  assert.ok(saves() > 0, 'the cleaned state is saved')
})

test('an orphan ask card does not block asking again on that Session', async () => {
  const { rt } = fakeRt({ s1: { id: 'ask-old', question: 'old', options: [] } })
  const asked = rt.askSteer({ sessionId: 's1', text: 'hello', apply: async () => {} })
  assert.equal(asked, true)
  assert.notEqual(rt.state.questions.s1.id, 'ask-old')
})

test('a card that is still waiting for its answer is not dropped', async () => {
  const { rt } = fakeRt()
  rt.askSteer({ sessionId: 's1', text: 'hello', apply: async () => {} })
  const id = rt.state.questions.s1.id
  await rt.load()
  assert.equal(rt.state.questions.s1.id, id)
})

test('when carrying the message out fails, the page gets a card that says so, and the user closes it', async () => {
  const { rt, warns, shown, answered } = fakeRt()
  rt.askSteer({ sessionId: 's1', text: 'please stop and look', apply: async () => { throw new Error('node is offline') } })
  const asking = rt.state.questions.s1
  await rt.answerQuestion('s1', asking.id, { selected: [STEER_ASK_CHOICES.steer] })
  await settle()
  assert.equal(warns.length, 1, 'the failure is logged')
  const notice = rt.state.questions.s1
  assert.ok(notice, 'a card replaces the vanished question')
  assert.notEqual(notice.id, asking.id)
  assert.match(notice.question, /没有送出/)
  assert.match(notice.detail, /node is offline/)
  assert.match(notice.detail, /please stop and look/)
  assert.deepEqual(notice.options, [{ label: '知道了' }])
  assert.ok(shown.some(([sessionId, kind]) => sessionId === 's1' && kind === 'question'))

  await rt.answerQuestion('s1', notice.id, { selected: ['知道了'] })
  assert.equal(rt.state.questions.s1, undefined, 'answering closes the notice')
  assert.deepEqual(answered, [], 'the notice never reaches the ordinary question path')
})

test('a failure while another card holds the Session keeps that card and still logs', async () => {
  const { rt, warns } = fakeRt()
  rt.askSteer({ sessionId: 's1', text: 'hello', apply: async () => { rt.state.questions.s1 = { id: 'call-2', question: 'other' }; throw new Error('boom') } })
  await rt.answerQuestion('s1', rt.state.questions.s1.id, { selected: [STEER_ASK_CHOICES.queue] })
  await settle()
  assert.equal(rt.state.questions.s1.id, 'call-2')
  assert.equal(warns.length, 1)
})

test('a successful apply leaves no notice', async () => {
  const { rt } = fakeRt()
  let applied
  rt.askSteer({ sessionId: 's1', text: 'hello', apply: async (choice) => { applied = choice } })
  await rt.answerQuestion('s1', rt.state.questions.s1.id, { selected: [STEER_ASK_CHOICES.queue] })
  await settle()
  assert.equal(applied, 'queue')
  assert.equal(rt.state.questions.s1, undefined)
})
