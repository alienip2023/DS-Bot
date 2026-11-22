// steer-ask.js — "ask me first" for a steer sent to a busy Bot (opt-in: prefs.steerAsk).
//
// Only a message the user typed in the composer can reach this: the composer's prompt is the one entry
// the gate in thread-prompt.js / joined-prompt.js wraps. A schedule, a routine, a Bot's request or an IM
// bridge never goes through it, so automation is never asked and never held up.
//
// The question is the page's ordinary question card (state.questions), so the page needs nothing new and
// the phone and IM show it too. It never blocks: the running work goes on, and if nobody answers within a
// few seconds the message goes the way a plain steer does (joins the running turn).
import { randomUUID } from 'node:crypto'

export const STEER_ASK_TIMEOUT_MS = 12_000
const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export const STEER_ASK_CHOICES = Object.freeze({
  steer: '加到正在做的这件事里（插话）',
  independent: '另开会话做，和正在做的事无关',
  related: '另开会话做，和正在做的事相关（带上下文）',
  queue: '排队，等正在做的做完再做',
})

export function install(rt) {
  const { state } = rt
  /** card id → { sessionId, settle } for the cards waiting on an answer */
  const open = new Map()

  /**
   * Put the question to the user. `choices` says which of the four apply (a node Bot has no
   * separate related/independent session of its own to open from here, a local one has);
   * `apply(choice)` carries the message out. Returns false when it cannot ask (another card is open
   * on that Session) — the caller then does what a plain steer does.
   */
  rt.askSteer = ({ sessionId, text, choices = Object.keys(STEER_ASK_CHOICES), apply }) => {
    if (typeof sessionId !== 'string' || sessionId === '' || state.questions[sessionId] !== undefined) return false
    const card = {
      id: `ask-${randomUUID()}`,
      question: '这条消息怎么处理？',
      detail: oneLine(text, 80),
      options: choices.map(id => ({ label: STEER_ASK_CHOICES[id], description: undefined })).map(({ label }) => ({ label })),
      multiSelect: false,
      askedAt: Date.now(),
    }
    state.questions[sessionId] = card
    let timer
    const settle = (choice) => {
      if (!open.delete(card.id)) return false
      clearTimeout(timer)
      if (state.questions[sessionId]?.id === card.id) delete state.questions[sessionId]
      void rt.save?.().catch(() => {})
      Promise.resolve().then(() => apply(choice)).catch(error => rt.warn?.('ds-bot: a steer sent after asking did not go: %s', error?.message ?? error))
      return true
    }
    open.set(card.id, { sessionId, choices, settle })
    const wait = Number.isFinite(rt.steerAskTimeoutMs) ? rt.steerAskTimeoutMs : STEER_ASK_TIMEOUT_MS
    timer = setTimeout(() => {
      if (state.questions[sessionId]?.id === card.id) rt.closeCard?.(sessionId, card, 'dismissed')
      settle('steer')
    }, wait)
    timer.unref?.()
    void rt.save?.().catch(() => {})
    rt.cardShown?.(sessionId, 'question', card.question)
    return true
  }

  // An answer to one of these cards carries the message out; every other question goes on as before.
  const answerQuestion = rt.answerQuestion
  if (typeof answerQuestion === 'function') {
    rt.answerQuestion = async function (sessionRef, questionId, answer, ...rest) {
      const entry = open.get(String(questionId ?? ''))
      if (entry === undefined) return answerQuestion.call(this, sessionRef, questionId, answer, ...rest)
      const label = Array.isArray(answer?.selected) ? answer.selected[0] : undefined
      const choice = entry.choices.find(id => STEER_ASK_CHOICES[id] === label)
      if (choice === undefined) throw Object.assign(new Error('Nothing to send'), { code: 'bot/invalid' })
      entry.settle(choice)
      return true
    }
  }
}
