// node-bot-tools.js — what the hub's Main Bot can do to the Bots that live on a node.
//
// create_bot (with `node`) already sent bot/create. update_bot used to change only the hub's shadow row of a node
// Bot: the tool said "Updated", the node kept what it had (and took the name and role back at its next roster
// report). It now sends bot/update, the frame the page sends, and says what the node answered. delete_bot is new:
// it goes through the same delete the page uses, which asks the node first and keeps the row when the node does not
// confirm.
import { NODE_NO_MAIN } from './node-team.js'

const REASONS = {
  'node-offline': 'the node is offline',
  'bridge-down': 'the link to the node is down',
  'bot-update-timeout': 'the node did not answer in time',
  'bot-update-profile-unsupported': 'the ds-bot on that node is too old to change a name, role or colour (upgrade the node)',
  'bot-update-memory-unsupported': 'the ds-bot on that node is too old to change its memory',
  'bot-not-joined': 'that is not a node Bot',
}
const why = code => REASONS[code] ?? String(code ?? 'unknown error')

// tool argument → bot/update field
const FIELDS = [['name', 'name'], ['role', 'role'], ['instructions', 'instructions'], ['color', 'color'], ['model', 'model'], ['effort', 'effort'], ['work_dir', 'workDir']]

export const isNodeBot = bot => bot?.origin === 'joined' && bot.worker?.home === 'remote'

/** update_bot on a node Bot: the node changes it; only what the node confirmed is reported. */
export async function updateNodeBot(rt, bot, args) {
  if (typeof rt.joinedUpdateBot !== 'function') return 'Changing a Bot on a node is not available right now.'
  if (args.avatar !== undefined) return `The profile picture of ${bot.name} is changed on its page; update_bot cannot send a picture to a node.`
  if (args.type !== undefined || args.worker !== undefined) return `${bot.name} lives on a node; its type cannot be changed.`
  const patch = {}
  for (const [argument, field] of FIELDS) if (args[argument] !== undefined) patch[field] = args[argument]
  const changed = Object.keys(patch)
  if (changed.length === 0 && args.section === undefined) return `Nothing to change for ${bot.name}: say what to change.`
  if (changed.length > 0) {
    let result
    try { result = await rt.joinedUpdateBot(bot.id, patch) } catch (error) { result = { ok: false, error: error?.message ?? String(error) } }
    if (result?.ok !== true) return `Could not change ${bot.name} on its node: ${why(result?.error)}. Nothing was changed.`
  }
  // The sidebar section is how this hub arranges its rows; it is not the node's to hold.
  if (args.section !== undefined) await rt.updateBot(bot.id, { section: args.section })
  const nodeId = bot.worker?.nodeId
  return `Updated ${bot.name} on node ${nodeId}: ${[...changed, ...(args.section === undefined ? [] : ['section'])].join(', ')}.`
}

/** delete_bot's whole check-and-delete, for a Bot of this hub or of a node. */
export async function deleteBotTool(rt, exec, args, { nodeRole }) {
  await rt.load()
  const self = rt.selfOf(exec.agent?.id)
  if (nodeRole) return `${NODE_NO_MAIN}。`
  if (!rt.isMain(self)) return 'Only a Main Bot can delete Bots.'
  const target = args.bot ? rt.findBot(args.bot) : undefined
  if (target === undefined) return `No Bot named ${args.bot}.`
  if (target.origin === 'peer') return `${target.name} belongs to another machine and is read-only here.`
  if (rt.isMain(target.id)) return `${target.name} is a Main Bot and cannot be deleted; take its Main Bot role away first, in the settings.`
  if (target.id === self) return 'You cannot delete yourself.'
  if (String(args.confirm ?? '') !== target.name) {
    return `Deleting ${target.name} is permanent${isNodeBot(target) ? ` and removes it from its node too (${target.worker?.nodeId}), with its history and memory` : ''}. Only when the user asked for it: call delete_bot again with confirm set to the exact name "${target.name}".`
  }
  const node = isNodeBot(target) ? target.worker?.nodeId : undefined
  try {
    await rt.deleteBot(target.id)
  } catch (error) {
    return `${target.name} was not deleted: ${error?.message ?? error}`
  }
  return node === undefined ? `Deleted ${target.name}.` : `Deleted ${target.name}, on node ${node} too.`
}
