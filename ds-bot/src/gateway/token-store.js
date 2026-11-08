// token-store.js — nodeId to {currentRefName, previousRefName, previousExpiresAt} + bidirectional mapping
// refName = 'GATEWAY_TOKEN_' + sanitized(nodeId); rotation adds epoch suffix
const PREVIOUS_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

function sanitize(nodeId) {
  return nodeId.replace(/[^A-Za-z0-9]/g, '_')
}

export function createTokenStore({ now = () => Date.now() } = {}) {
  const nodeMap = new Map() // nodeId -> {currentRefName, previousRefName, previousExpiresAt}
  const refMap = new Map()  // refName -> {nodeId, kind}
  const usedRefNames = new Set()

  function makeFirstRefName(nodeId) {
    const base = 'GATEWAY_TOKEN_' + sanitize(nodeId)
    if (!usedRefNames.has(base)) return base
    for (let i = 2; ; i++) {
      const c = base + '_' + i
      if (!usedRefNames.has(c)) return c
    }
  }

  function makeRotationRefName(nodeId) {
    const base = 'GATEWAY_TOKEN_' + sanitize(nodeId)
    const epoch = now().toString(36)
    let c = base + '_' + epoch
    let i = 2
    while (usedRefNames.has(c)) c = base + '_' + epoch + '_' + i++
    return c
  }

  return {
    register(nodeId) {
      const existing = nodeMap.get(nodeId)
      if (existing) return { refName: existing.currentRefName }
      const refName = makeFirstRefName(nodeId)
      usedRefNames.add(refName)
      nodeMap.set(nodeId, { currentRefName: refName, previousRefName: null, previousExpiresAt: null })
      refMap.set(refName, { nodeId, kind: 'current' })
      return { refName }
    },
    rotate(nodeId) {
      const newRefName = makeRotationRefName(nodeId)
      usedRefNames.add(newRefName)
      const rec = nodeMap.get(nodeId)
      if (rec) {
        if (rec.previousRefName) refMap.delete(rec.previousRefName)
        const old = rec.currentRefName
        rec.previousRefName = old
        rec.previousExpiresAt = now() + PREVIOUS_WINDOW_MS
        rec.currentRefName = newRefName
        if (old) refMap.set(old, { nodeId, kind: 'previous' })
      } else {
        nodeMap.set(nodeId, { currentRefName: newRefName, previousRefName: null, previousExpiresAt: null })
      }
      refMap.set(newRefName, { nodeId, kind: 'current' })
      return { refName: newRefName }
    },
    resolve(refName) {
      const entry = refMap.get(refName)
      if (!entry) return null
      if (entry.kind === 'previous') {
        const rec = nodeMap.get(entry.nodeId)
        if (!rec || (rec.previousExpiresAt !== null && now() > rec.previousExpiresAt)) return null
      }
      return entry.nodeId
    },
    get(nodeId) { return nodeMap.get(nodeId) ?? null },
    remove(nodeId) {
      const rec = nodeMap.get(nodeId)
      if (!rec) return
      if (rec.currentRefName) refMap.delete(rec.currentRefName)
      if (rec.previousRefName) refMap.delete(rec.previousRefName)
      nodeMap.delete(nodeId)
    },
    gc() {
      const t = now()
      for (const rec of nodeMap.values()) {
        if (rec.previousRefName && rec.previousExpiresAt !== null && t > rec.previousExpiresAt) {
          refMap.delete(rec.previousRefName)
          rec.previousRefName = null
          rec.previousExpiresAt = null
        }
      }
    },
    get size() { return nodeMap.size },
  }
}
