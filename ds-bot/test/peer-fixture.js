// A hub-shaped bot-network stand-in: `directory` events are what the plugin emits after
// validating a hub frame; `frames` are the bot/message frames a node hands to the hub.
import { EventEmitter } from 'node:events'

export function fakeNetwork({ online = true, nodeId = 'n9' } = {}) {
  const network = new EventEmitter()
  const frames = []
  const state = { online }
  Object.defineProperty(network, 'nodeId', { value: nodeId, enumerable: true })
  network.send = input => { if (!state.online) return false; frames.push(input); return true }
  network.directory = () => []
  network.onMessage = () => () => {}
  return { network, frames, state }
}

export const entry = (id, nodeId, name = id) => ({ id, name, role: 'Engineer', nodeId })
export const peerRows = rt => Object.values(rt.state.bots).filter(bot => bot.origin === 'peer')
