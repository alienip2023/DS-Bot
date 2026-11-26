// Team management from any machine (rewrite R4, docs/plans/2026-11-24-team-act.md).
//
// On a node, the team-management tools (create/change/delete/stop Bots, create/change/delete groups) do
// not act locally: the team is the hub's. The call goes to the hub as one `team/act` frame, and the hub
// runs the same tool as the calling Bot's joined shadow, so a node Bot has exactly the rights a hub Bot
// in its place would have. Those tools take "a Main Bot or a node manager" where they took a Main Bot;
// a node manager still cannot change, stop or delete a Main Bot.
//
// Who is a node manager: `state.prefs.nodeManagers` on the hub — 'all' (default: every node Bot), 'none',
// or a list of Bot names / shadow ids.
import { randomUUID } from 'node:crypto'
import { joinedShadow } from './roster-join.js'
import { botOfRef, ownNodeId, refOf } from './bot-link.js'
import { CAP_CALL, SECRET_SYNC, runCapabilityCall, runSecretSync } from './capability-share.js'

export const FORWARDED_TOOLS = Object.freeze(['create_bot', 'update_bot', 'delete_bot', 'stop_bot', 'create_group', 'update_group', 'delete_group'])

function serviceOf(rt, name) {
  try { return rt.ctx?.get?.(name) } catch { return undefined }
}
export const onNode = rt => serviceOf(rt, 'remote-agent:role') === 'worker'

/** Is this hub Bot id a node Bot that may manage the team (hub side only)? */
export function isNodeManager(rt, id) {
  const bot = rt.botOf?.(id)
  if (!joinedShadow(bot)) return false
  const policy = rt.state?.prefs?.nodeManagers ?? 'all'
  if (policy === 'all') return true
  if (!Array.isArray(policy)) return false
  return policy.includes(bot.id) || policy.includes(bot.name)
}

/** A Main Bot, or a node Bot allowed to manage the team. */
export const canManage = (rt, id) => id !== undefined && (rt.isMain(id) || isNodeManager(rt, id))

/** On a node: run `tool` on the hub as the calling Bot. Returns the hub's answer as the tool result. */
export async function forwardTeamAct(rt, exec, tool, args) {
  const caller = rt.botOf(rt.selfOf(exec.agent?.id))
  if (caller === undefined) return `Only Bots on the team can use ${tool}.`
  const network = serviceOf(rt, 'remote-agent:bot-network')
  if (typeof network?.teamAct !== 'function') return `${tool} runs on the hub, and this machine's AC cannot reach it (update AC on this machine).`
  const actor = refOf(rt, caller)
  if (actor === undefined) return `${tool} runs on the hub, and this machine is not connected to one.`
  let payload = args ?? {}
  // A Bot made from a node goes on that node unless it names another machine.
  if (tool === 'create_bot' && (typeof payload.node !== 'string' || payload.node.trim() === '')) payload = { ...payload, node: ownNodeId(rt) }
  let out
  try {
    out = await network.teamAct({ requestId: randomUUID(), actor, tool, args: JSON.stringify(payload) })
  } catch (error) {
    return `Not done: ${error?.message ?? error}`
  }
  return out?.ok === true ? out.text : `Not done on the hub: ${out?.text || 'no answer'}`
}

/** On the hub: run one forwarded tool call as the asking node Bot's shadow. */
export async function runTeamAct(rt, act) {
  await rt.load?.()
  const shadow = botOfRef(rt, act.actor)
  if (!joinedShadow(shadow) || shadow.worker?.nodeId !== act.nodeId) return { ok: false, text: `${act.actor?.name ?? 'That Bot'} is not known on the hub yet; try again once its machine has reported it.` }
  // A shared tool (fork.131): any node Bot may call one the hub shares; it is not team management.
  if (act.tool === CAP_CALL) return runCapabilityCall(rt, shadow, act)
  // A node takes the keys the user shared with the nodes (not team management either).
  if (act.tool === SECRET_SYNC) return runSecretSync(rt, shadow)
  if (!FORWARDED_TOOLS.includes(act.tool)) return { ok: false, text: `${act.tool} cannot be run from another machine.` }
  if (!canManage(rt, shadow.id)) return { ok: false, text: `${shadow.name} may not manage the team: the hub's settings do not make it a node manager.` }
  const tool = rt.teamTools?.find(def => def.name === act.tool)
  if (tool === undefined) return { ok: false, text: `${act.tool} is not available on the hub.` }
  let args
  try { args = JSON.parse(act.args) } catch { return { ok: false, text: 'The tool arguments were not valid JSON.' } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, text: 'The tool arguments must be an object.' }
  // The tools find their caller by the Session they run in; this call has none here, so it gets a
  // one-off owner entry for exactly as long as it runs.
  const sessionId = `team-act:${act.requestId}`
  rt.chatOwners.set(sessionId, shadow.id)
  try {
    const text = await tool.execute(args, { agent: { id: sessionId }, callId: act.requestId, signal: new AbortController().signal })
    return { ok: true, text: typeof text === 'string' ? text : JSON.stringify(text) }
  } catch (error) {
    return { ok: false, text: String(error?.message ?? error) }
  } finally {
    rt.chatOwners.delete(sessionId)
  }
}

export function install(rt) {
  const { ctx } = rt
  let attached
  let off
  const attach = () => {
    const network = serviceOf(rt, 'remote-agent:bot-network')
    if (network === attached) return
    off?.()
    attached = network
    off = typeof network?.onTeamAct === 'function' ? network.onTeamAct(act => runTeamAct(rt, act)) : undefined
  }
  attach()
  const timer = setInterval(attach, 30_000)
  timer.unref?.()
  rt.canManage = id => canManage(rt, id)
  ctx?.effect?.(() => () => { clearInterval(timer); off?.(); rt.canManage = undefined }, 'ds-bot: team act')
}
