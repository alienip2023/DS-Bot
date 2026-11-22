// Shared by the node-trace tests: how a Session's events read as a turn, and what a well-formed turn is.
import assert from 'node:assert/strict'

/** The events of a Session as short words: the shape of a turn, without its ids and times. */
export function skeleton(session) {
  return session.log.filter(event => event.type !== 'system/message').map((event) => {
    const data = event.data
    switch (event.type) {
      case 'step/start': case 'step/end': return `${event.type}:${data.step}`
      case 'user/message': return 'user'
      case 'assistant/message': return `assistant[${data.message.content.map(block => block.type).join('+')}]`
      case 'tool/call': return `call:${data.name}`
      case 'tool/result': return `result:${data.message.isError ? 'err' : 'ok'}`
      case 'turn/end': return `turn/end:${data.reason.kind}`
      default: return event.type
    }
  })
}
export const FULL_SKELETON = [
  'turn/start', 'step/start:1', 'user',
  'assistant[reasoning+tool-call]', 'call:bash', 'result:ok', 'step/end:1',
  'step/start:2', 'assistant[reasoning+tool-call]', 'call:read', 'result:ok', 'step/end:2',
  'step/start:3', 'assistant[reasoning+text]', 'step/end:3', 'turn/end:completed',
]

// The strict framing a Session restore applies, plus: every tool call answered inside its own step.
export function assertStrict(session) {
  let openTurn = null
  let openStep = null
  const asked = new Map()
  for (const event of session.log) {
    const { turn, step } = event.data ?? {}
    switch (event.type) {
      case 'turn/start': assert.equal(openTurn, null); openTurn = turn; break
      case 'step/start': assert.equal(openTurn, turn); assert.equal(openStep, null); openStep = step; break
      case 'assistant/message': case 'tool/call': assert.equal(openStep, step, `${event.type} outside its step`); break
      case 'tool/result': assert.equal(openStep, step, 'tool/result outside its step'); asked.delete(event.data.message.toolCallId); break
      case 'step/end': assert.equal(openStep, step); assert.equal(asked.size, 0, 'a step ended with an unanswered tool call'); openStep = null; break
      case 'turn/end': assert.equal(openStep, null, 'turn/end inside an open step'); assert.equal(openTurn, turn); openTurn = null; break
      default: break
    }
    if (event.type === 'tool/call') asked.set(event.data.callId, true)
  }
  assert.equal(openTurn, null, 'a turn is still open')
}

export const answers = session => session.log.filter(event => event.type === 'assistant/message')
export const reasoningOf = event => event.data.message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
export const textOf = event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')

