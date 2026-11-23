// node-team.js — a node has no Main Bot: every Bot on it is an ordinary one, and the hub's Main Bot is the only
// one that runs the team.
//
// The hub's Main Bot creates, changes and deletes the Bots of a node (bot/create, bot/update, bot/delete frames,
// see joined-create.js and joined-page.js); the Bots there only do their work. A machine that runs as an AC
// worker used to clear its Main Bot only when somebody opened its page (roster.js bootstrap), so a node nobody
// opened kept the Main Bot it had from before it was a node, and a Bot could still be made Main there.
// This module settles it once and keeps it so:
//   - at start and every few seconds, a worker with a Main Bot loses the role (the Bot stays, as an ordinary one);
//   - nothing can make a Bot Main on a worker (setMain, createBot with main).
// Only a role that is known to be `worker` counts: a role that is not published (yet) is never read as "node",
// so a hub can never lose its Main Bot to a start-up race.
export const NODE_NO_MAIN = '这台机器是节点，节点上没有主 Bot：Bot 都是普通 Bot，由主控的 Main Bot 建立、修改和删除'

const ENFORCE_MS = 5_000

export const isNodeRole = (rt) => {
  try { return rt.ctx?.get?.('remote-agent:role') === 'worker' } catch { return false }
}

const refusal = () => Object.assign(new Error(NODE_NO_MAIN), { code: 'E_NODE_NO_MAIN' })

/** Take the Main role from every Bot of a node. Returns how many Bots lost it. */
export async function demoteNodeMains(rt) {
  if (!isNodeRole(rt)) return 0
  await rt.load?.()
  const mains = Array.isArray(rt.state?.mainBotIds) ? rt.state.mainBotIds : []
  if (mains.length === 0) return 0
  rt.state.mainBotIds = []
  rt.warn?.('ds-bot: this machine is a node — %d Main Bot(s) are ordinary Bots now (Bots and sessions are kept)', mains.length)
  await rt.save?.()
  return mains.length
}

export function install(rt) {
  const { ctx } = rt
  rt.demoteNodeMains = () => demoteNodeMains(rt)

  const setMain = rt.setMain
  if (typeof setMain === 'function') {
    rt.setMain = function (id, main, ...rest) {
      if (main !== false && isNodeRole(rt)) return Promise.reject(refusal())
      return setMain.call(this, id, main, ...rest)
    }
  }
  const createBot = rt.createBot
  if (typeof createBot === 'function') {
    rt.createBot = function (options, ...rest) {
      if (options?.main === true && isNodeRole(rt)) return Promise.reject(refusal())
      return createBot.call(this, options, ...rest)
    }
  }

  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    void demoteNodeMains(rt).catch(error => rt.warn?.('ds-bot: node team check failed: %s', error?.message ?? error)).finally(() => { busy = false })
  }
  const timer = setInterval(tick, ENFORCE_MS)
  timer.unref?.()
  const first = setTimeout(tick, 500)
  first.unref?.()
  ctx?.effect?.(() => () => { clearInterval(timer); clearTimeout(first) }, 'ds-bot: node team check')
}
