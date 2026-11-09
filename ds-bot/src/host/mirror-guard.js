// mirror-guard.js — no LOCAL agent turn on a joined Bot's mirror Session (S2-4 contract I2).
//
// joined-prompt.js takes over the page's composer (ctx.sessionController.prompt). It cannot
// see the other ways a message reaches a live Agent: plugins call `agent.followup/steer/inject`
// directly (dsh-client-auto-continue engine.ts:1195-1211 sends "继续" three seconds after a
// turn ends; dsh-tool-jobs, dsh-schedule, dsh-webhook, dsh-acp, dsh-headless, goal drivers do
// the same). Such a message makes the core open a native turn on the mirror Session: a local
// model runs there and its turn/start carries the Agent's own counter, which collides with the
// turns this plugin wrote (allocateTurn) — the stored log then fails to load ("turn/start does
// not open the expected turn").
//
// Where the guard sits (dsh-agent-loop lib/index.js):
//   ReactLoopAgent.send(message, target, wakeup)   :565  — every followup/steer/inject lands here
//   ReactLoopAgent.wakeDriver()                    :618  — the ONLY function that starts a turn
//                                                          (callers: send, runMaintenance and
//                                                          kick's own tail; all inside the class)
// For an Agent whose Session is a joined Bot's mirror, `send` drops the message before it is
// recorded (the log gets no splice) and `wakeDriver` does nothing. This plugin's own writes go
// through session.append, never through the Agent, so there is nothing to exempt.
//
// Why not a listener on 'agent/inbox/inserted' or 'agent/pre-step': both run after the
// message is durable, and pre-step after turn/start was appended with the wrong number. What
// the reordering plugins do to the INBOX (auto-continue moves its message in front of the
// queue) cannot start a turn without wakeDriver, so it cannot get round the guard.
//
// Not depending on module order: the guard is applied (1) to every live Agent when this module
// installs, (2) from an agent/created listener registered with prepend, and (3) from an
// agent/inbox/inserted net that guards and removes what slipped through (an Agent that was
// created before its Session was known to be a mirror). `send` emits 'inserted' synchronously
// and calls wakeDriver only afterwards, so the net is in time for the wake of that same call.
import { joinedBotOfSession } from './joined-prompt.js'

const MIRROR_GUARD = Symbol.for('ds-bot.mirrorGuard')

/** Is this Agent the live Agent of a joined Bot's mirror Session? Asked at every call. */
function isMirrorAgent(rt, agent) {
  const id = agent?.session?.id ?? agent?.id
  return joinedBotOfSession(rt, id) !== undefined
}

function noteRefused(rt, what) {
  rt.mirrorGuardRefused = (rt.mirrorGuardRefused ?? 0) + 1
  const n = rt.mirrorGuardRefused
  // Counts only — never the message. A plugin that keeps trying (auto-continue retries on a
  // cooldown) must not flood the log: the 1st, then every 10th.
  if (n === 1 || n % 10 === 0) rt.warn?.('ds-bot: refused %d local-agent message(s)/wake(s) aimed at joined Bot mirror Sessions (%s)', n, what)
}

/**
 * Guard one Agent. Idempotent. Returns true when the Agent is (now) guarded.
 * The wrappers ask `isMirrorAgent` at every call, so an Agent whose Bot is later removed or
 * re-pointed goes back to the original behaviour without being un-patched.
 */
export function guardAgent(rt, agent) {
  if (agent === null || typeof agent !== 'object') return false
  if (typeof agent.send !== 'function' || typeof agent.wakeDriver !== 'function') return false
  if (agent[MIRROR_GUARD] !== undefined) return true
  const priorSend = { own: Object.hasOwn(agent, 'send'), value: agent.send }
  const priorWake = { own: Object.hasOwn(agent, 'wakeDriver'), value: agent.wakeDriver }

  const guardedSend = function (...args) {
    if (!isMirrorAgent(rt, agent)) return priorSend.value.apply(this, args)
    noteRefused(rt, 'send')
    return undefined
  }
  const guardedWake = function (...args) {
    if (!isMirrorAgent(rt, agent)) return priorWake.value.apply(this, args)
    noteRefused(rt, 'wake')
    return undefined
  }
  agent.send = guardedSend
  agent.wakeDriver = guardedWake
  const restore = () => {
    for (const [key, prior, mine] of [['send', priorSend, guardedSend], ['wakeDriver', priorWake, guardedWake]]) {
      if (agent[key] !== mine) continue
      if (prior.own) agent[key] = prior.value
      else delete agent[key]
    }
    delete agent[MIRROR_GUARD]
  }
  Object.defineProperty(agent, MIRROR_GUARD, { value: restore, configurable: true, enumerable: false })
  return true
}

export function install(rt) {
  const { ctx } = rt
  if (typeof ctx?.on !== 'function') return

  const guarded = new Set()
  const guardIfMirror = (agent) => {
    if (!isMirrorAgent(rt, agent)) return false
    if (!guardAgent(rt, agent)) return false
    guarded.add(agent)
    return true
  }
  rt.guardMirrorAgent = guardIfMirror

  // (2) Every Agent announced from now on. Prepend: before other plugins' creation listeners,
  // which may already want to wake it.
  ctx.on('agent/created', ({ agent }) => { guardIfMirror(agent) }, { prepend: true })

  // (3) The net. Runs inside send(), after the splice and before its wakeDriver.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!isMirrorAgent(rt, agent)) return
    guardIfMirror(agent)
    try {
      agent.inbox.remove(message.id)
    } catch (error) {
      rt.warn?.('ds-bot: a message in a joined Bot mirror Session inbox was not removed: %s', error?.message ?? error)
    }
    noteRefused(rt, 'inbox')
  }, { prepend: true })

  // (1) Agents that are already live (a reload does not announce them again).
  try {
    const agents = ctx.get?.('agents')
    for (const agent of agents?.list?.() ?? []) guardIfMirror(agent)
  } catch (error) {
    rt.warn?.('ds-bot: live Agents were not checked for mirror Sessions: %s', error?.message ?? error)
  }

  // Unload: hand every guarded Agent its own methods back.
  ctx.effect?.(() => () => {
    for (const agent of guarded) agent[MIRROR_GUARD]?.()
    guarded.clear()
  }, 'ds-bot: joined Bot mirror guard')
}
