// joined-running.js — a joined Bot's page turn shows as RUNNING on its mirror Session.
//
// The composer's Stop button (dsh-client-ui-conversation client.js:21928 primaryStops =
// running && …) appears only while the Session's `running` bit is true. The core derives that
// bit from a live Agent: summaryFor/readState say `agent.status === "running"`
// (dsh-api-session-controller index.js:2523, :2915) and the Agent's status events become
// 'api-session/status' (:4197) which the client folds into the Session (client.js:3628
// handleSessionStatus → handleRunning). A mirror Session has no live Agent on purpose
// (mirror-guard.js), so the bit stayed false and the page had no Stop.
//
// The single choke point is that event plus the list summary the client reads on (re)open:
//   · rt.joinedRunning(bot, running) emits 'api-session/status' for the Bot's mirror Session
//     (startPageTurn calls it when the page turn starts and when its in-flight slot is released);
//   · controller.list is wrapped so a mirror Session whose page turn is in flight reports
//     running:true — every other item is passed through as the SAME object;
//   · an 'api-session/added' for that Session (the core re-sends the summary when an Agent
//     appears or goes) re-asserts the bit, so a stray running:false cannot hide the button.
// No Agent is faked. Only a joined mirror Session with its page turn in flight is touched.
import { wrapControllerMethod } from './controller-wrap.js'

/** The in-flight joined Bot of this Session, or undefined. */
export function runningJoinedBot(rt, sessionId, joinedBotOf) {
  const bot = joinedBotOf(rt, sessionId)
  return bot !== undefined && rt.joinedInFlight?.has(bot.id) === true ? bot : undefined
}

export function installRunning(rt, controller, joinedBotOf) {
  const { ctx } = rt
  rt.joinedRunning = (bot, running) => {
    if (typeof bot?.sessionId !== 'string' || bot.sessionId === '') return
    try { ctx?.emit?.('api-session/status', bot.sessionId, running) } catch (error) {
      rt.warn?.('ds-bot: the running state of a joined Bot page could not be announced: %s', error?.message ?? error)
    }
  }

  ctx?.on?.('api-session/added', (summary) => {
    const bot = runningJoinedBot(rt, summary?.sessionId, joinedBotOf)
    if (bot !== undefined && summary.running !== true) rt.joinedRunning(bot, true)
  })

  wrapControllerMethod(ctx, controller, 'list', original => async function (...args) {
    const result = await original.apply(this, args)
    const items = result?.items
    if (!Array.isArray(items) || !(rt.joinedInFlight?.size > 0)) return result
    let changed = false
    const next = items.map((item) => {
      if (item?.running === true || runningJoinedBot(rt, item?.sessionId, joinedBotOf) === undefined) return item
      changed = true
      return { ...item, running: true }
    })
    return changed ? { ...result, items: next } : result
  }, 'ds-bot: joined Bot running state in the session list')
}
