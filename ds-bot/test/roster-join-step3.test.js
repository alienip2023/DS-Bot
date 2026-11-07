import test from 'node:test'
import assert from 'node:assert/strict'
import { shadowId } from '../src/host/roster-join.js'
import { createBotOnNode, createBotCreateReceiver, install } from '../src/host/joined-create.js'

function makeRegistry(nodeId = 'node-a') {
  const listeners = {}
  return {
    sent: [],
    onlineNodes() { return [{ nodeId }] },
    send(nid, type, data) {
      this.sent.push({ nodeId: nid, type, data })
      // 自动触发 botCreateResult（模拟副机回包）
      Promise.resolve().then(() => {
        this.emit('botCreateResult', {
          requestId: data.requestId,
          ok: true,
          remoteBotId: 'bot-created',
          name: data.name,
          role: data.role ?? '',
        })
      })
      return true
    },
    on(name, fn) { (listeners[name] ??= []).push(fn) },
    off(name, fn) { listeners[name] = (listeners[name] ?? []).filter((item) => item !== fn) },
    emit(name, payload) { for (const fn of [...(listeners[name] ?? [])]) fn(payload) },
  }
}

function controller(nodeId = 'node-a') {
  const reg = makeRegistry(nodeId)
  const rt = {
    ctx: { get(name) { return name === 'remote-agent:registry' ? reg : undefined } },
    state: { bots: {} },
    botCreateTimeoutMs: 200,
    save() {},
  }
  rt.createBotOnNode = (opts) => createBotOnNode(rt, opts)
  return { rt, reg }
}

// 刀 1：删掉主控发出 bot/create 的调用后，失败落在「没有发出创建」或「没有影子行」
test('createBotOnNode sends bot/create to registry', async () => {
  const { rt, reg } = controller()
  const result = await rt.createBotOnNode({ nodeId: 'node-a', name: 'Alpha', role: '写' })
  assert.equal(result.ok, true, `createBotOnNode failed: ${result.error}`)
  // 断言发出了 bot/create 帧
  const sent = reg.sent.find((s) => s.type === 'bot/create')
  assert.ok(sent, '没有发出 bot/create 帧')
  assert.equal(sent.nodeId, 'node-a')
  assert.equal(sent.data.name, 'Alpha')
  assert.equal(sent.data.role, '写')
  // 断言影子行存在
  const id = shadowId('node-a', 'bot-created')
  assert.ok(rt.state.bots[id], '没有影子行')
})

// 刀 3：创建失败时，断言主控没有影子行，也没有本地会话
test('createBotOnNode does not write shadow row on failure', async () => {
  const listeners = {}
  const reg = {
    sent: [],
    onlineNodes() { return [{ nodeId: 'node-a' }] },
    send(nid, type, data) {
      this.sent.push({ nodeId: nid, type, data })
      // 副机回失败
      Promise.resolve().then(() => {
        for (const fn of [...(listeners['botCreateResult'] ?? [])]) {
          fn({ requestId: data.requestId, ok: false, error: 'name-taken' })
        }
      })
      return true
    },
    on(name, fn) { (listeners[name] ??= []).push(fn) },
    off(name, fn) { listeners[name] = (listeners[name] ?? []).filter((item) => item !== fn) },
    emit(name, payload) { for (const fn of [...(listeners[name] ?? [])]) fn(payload) },
  }
  const rt = {
    ctx: { get(name) { return name === 'remote-agent:registry' ? reg : undefined } },
    state: { bots: {} },
    botCreateTimeoutMs: 200,
    save() {},
  }
  const result = await createBotOnNode(rt, { nodeId: 'node-a', name: 'Alpha', role: '写' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'name-taken')
  // 没有影子行
  assert.equal(Object.values(rt.state.bots).filter((b) => b.origin === 'joined').length, 0, '不应有影子行')
  // 没有本地会话
  assert.equal(Object.keys(rt.state.bots).length, 0, '不应有本地会话行')
})

// 刀 3 变体：node 不在注册表里 → 拒绝，不写影子行
test('createBotOnNode rejects unknown node and writes no shadow row', async () => {
  const { rt, reg } = controller()
  const result = await createBotOnNode(rt, { nodeId: 'unknown-node', name: 'Alpha', role: '写' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'node-unknown')
  assert.equal(reg.sent.length, 0, '不应发出帧')
  assert.equal(Object.keys(rt.state.bots).length, 0, '不应有影子行')
})

// 刀 4：创建成功后，影子行字段是 joined / home remote，且随后 roster-report 不产生第二行
test('shadow row after createBotOnNode has joined/remote fields and roster-report does not create a second row', async () => {
  const { rt } = controller()
  const result = await rt.createBotOnNode({ nodeId: 'node-a', name: 'Alpha', role: '写' })
  assert.equal(result.ok, true)
  const id = shadowId('node-a', 'bot-created')
  const row = rt.state.bots[id]
  assert.ok(row, '影子行不存在')
  assert.equal(row.origin, 'joined')
  assert.equal(row.worker.home, 'remote')
  assert.equal(row.worker.nodeId, 'node-a')
  assert.equal(row.worker.remoteBotId, 'bot-created')
  assert.equal(row.type, 'remote-worker')

  // 模拟随后的 roster-report（用与 applyRosterReport 相同字段）
  const { applyRosterReport } = await import('../src/host/roster-join.js')
  applyRosterReport(rt.state, {
    nodeId: 'node-a',
    hostname: 'desk-1',
    bots: [{ id: 'bot-created', name: 'Alpha', role: '写' }],
    online: true,
  })
  // 仍只有一行（同 shadowId dedup）
  const joinedRows = Object.values(rt.state.bots).filter((b) => b.origin === 'joined')
  assert.equal(joinedRows.length, 1, 'roster-report 不应产生第二行')
  assert.equal(joinedRows[0].id, id)
})

test('createBotCreateReceiver calls local createBot without type remote-worker', async () => {
  const created = []
  const rt = {
    state: { bots: {} },
    createBot: async (opts) => {
      created.push(opts)
      const id = `local-${opts.name}`
      rt.state.bots[id] = { id, name: opts.name, role: opts.role ?? '' }
      return id
    },
  }
  const accept = createBotCreateReceiver(rt)
  const result = await accept({ nodeId: 'n', requestId: 'r', name: 'Beta', role: '测' })
  assert.equal(result.ok, true)
  assert.equal(result.remoteBotId, 'local-Beta')
  assert.equal(created[0].type, undefined, 'type 不得是 remote-worker')
  assert.equal(created[0].name, 'Beta')
})

test('createBotCreateReceiver returns error when no createBot on rt', async () => {
  const rt = { state: { bots: {} } }
  const accept = createBotCreateReceiver(rt)
  const result = await accept({ nodeId: 'n', requestId: 'r', name: 'Beta' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bot-create-no-roster')
})

// install 测试
test('install wires createBotOnNode on rt and registers ctx receiver', () => {
  const set = []
  const rt = {
    ctx: {
      get(name) { return name === 'remote-agent:registry' ? { send() {}, onlineNodes() { return [] }, on() {}, off() {} } : undefined },
      set(name, fn) { set.push({ name, fn }) },
    },
    state: { bots: {} },
    save() {},
  }
  install(rt)
  assert.equal(typeof rt.createBotOnNode, 'function')
  const registered = set.find((s) => s.name === 'remote-agent:bot-create')
  assert.ok(registered, 'remote-agent:bot-create not registered')
  assert.equal(typeof registered.fn, 'function')
})