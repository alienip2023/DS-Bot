import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { applyRosterReport } from '../src/host/roster-join.js'
import { fakeContext } from './fake-ctx.js'

// A hub is only its registry: the frames arrive on it and the hub answers through
// send(), exactly like the remote-agent registry does on a real host.
export const CAP = 'memory-sync/1'

export function fakeRegistry(nodes = []) {
  const listeners = new Map()
  const sent = []
  const known = new Map()
  const online = new Set()
  const registry = {
    sent,
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return registry
    },
    off(name, handler) {
      listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== handler))
      return registry
    },
    emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) handler(payload)
    },
    async emitAsync(name, payload) {
      for (const handler of listeners.get(name) ?? []) await handler(payload)
    },
    send(nodeId, type, payload) {
      sent.push({ nodeId, type, payload })
      return true
    },
    getNode(nodeId) {
      return known.get(nodeId)
    },
    onlineNodes() {
      return [...online].map(nodeId => known.get(nodeId)).filter(node => node !== undefined)
    },
    addNode({ nodeId, hostname = nodeId, caps = [CAP], online: on = true }) {
      known.set(nodeId, { nodeId, hello: { hostname, caps } })
      if (on) online.add(nodeId)
      else online.delete(nodeId)
      return registry
    },
    dropNode(nodeId) {
      online.delete(nodeId)
      return registry
    },
    frames(type) {
      return sent.filter(frame => frame.type === type)
    },
  }
  for (const node of nodes) registry.addNode(node)
  return registry
}

export const rosterFor = (nodeId, bots, hostname = nodeId) => ({
  nodeId,
  hostname,
  online: true,
  bots: bots.map(id => ({ id, name: id, role: 'Engineer' })),
})

export async function hub({ nodes = [{ nodeId: 'n1', hostname: 'dshtest-1' }], roster = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-hub-'))
  const registry = fakeRegistry(nodes)
  const ctx = fakeContext({ services: { 'remote-agent:registry': registry } })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  for (const report of roster) applyRosterReport(rt.state, report)
  await rt.save()
  return {
    rt,
    ctx,
    registry,
    home,
    dir: (...parts) => join(home, 'memory', ...parts),
    close: async () => {
      try { await ctx.dispose() } catch { /* a closed host is the point */ }
      rmSync(home, { recursive: true, force: true })
    },
  }
}

export function writeFrame(nodeId, remoteBotId, requestId, extra = {}) {
  return {
    nodeId,
    remoteBotId,
    requestId,
    op: 'add',
    scope: 'own',
    text: `note from ${remoteBotId}`,
    ...extra,
  }
}
