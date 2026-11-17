// Exactly-once guard keyed by exchangeId, held in memory for the life of the process.
const seenIds = new Set()

// false the first time an id is presented, true afterwards.
// A missing or non-string id cannot be deduplicated, so it is never recorded and never suppressed.
export function seen(exchangeId) {
  if (typeof exchangeId !== 'string' || exchangeId === '') return false
  if (seenIds.has(exchangeId)) return true
  seenIds.add(exchangeId)
  return false
}
