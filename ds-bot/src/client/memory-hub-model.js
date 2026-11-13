// Plain helpers for the three-layer memory panel: the team, the machines the hub has
// heard from, and each machine's Bots. No React, no i18n: the panel renders these and
// the tests check the tree without a browser.

export function hubMachines(scopes) {
  return Array.isArray(scopes?.nodes) ? scopes.nodes : []
}

export function hubTeamEntries(scopes) {
  const entries = scopes?.team?.entries
  return Number.isInteger(entries) && entries >= 0 ? entries : 0
}

export function hubNodeEntries(node) {
  const entries = node?.entries
  return Number.isInteger(entries) && entries >= 0 ? entries : 0
}

export function hubBots(node) {
  return Array.isArray(node?.bots) ? node.bots : []
}

export function hubBotCount(node) {
  return hubBots(node).length
}

export function hubFindBot(scopes, nodeId, remoteBotId) {
  const node = hubMachines(scopes).find(machine => machine.nodeId === nodeId)
  return node === undefined ? undefined : hubBots(node).find(bot => bot.remoteBotId === remoteBotId)
}

// Everything the panel counts, for the row that opens it.
export function hubEntryTotal(scopes) {
  let total = hubTeamEntries(scopes)
  for (const node of hubMachines(scopes)) {
    total += hubNodeEntries(node)
    for (const bot of hubBots(node)) total += Number.isInteger(bot.entries) ? bot.entries : 0
  }
  return total
}

// A place is {kind:'team'}, {kind:'node',nodeId}, or {kind:'bot',nodeId,remoteBotId}.
// The endpoint takes the contract scope; the key names it stably in the UI.
export function hubPlaceScope(place) {
  if (place === undefined || place === null || place.kind === 'team') return { kind: 'team' }
  if (place.kind === 'node') return { kind: 'node', nodeId: place.nodeId }
  return { kind: 'bot', nodeId: place.nodeId, remoteBotId: place.remoteBotId }
}

export function hubPlaceKey(place) {
  if (place === undefined || place === null || place.kind === 'team') return 'team'
  if (place.kind === 'node') return `node:${place.nodeId}`
  return `joined:${place.nodeId}:${place.remoteBotId}`
}

// The tab a place belongs to: 0 = team, 1 = a machine, 2 = a Bot.
export function hubPlaceDepth(place) {
  if (place === undefined || place === null || place.kind === 'team') return 0
  return place.kind === 'node' ? 1 : 2
}
