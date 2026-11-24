// bot/stream 预览只能写进「当前打开的 turn/step」。节点回合调过工具后 trace 会把镜像回合推进到后面的 step，
// 此前 hub-stream 仍往回合开场的 step 1 写 assistant/message，线上校验器判整卷损坏：
// "SessionFormatError: assistant/message does not match an open turn and step"。
// 任务书：task-board/evidence/T-20261124-node-mirror-corrupt/TASK-ds-stream-step-binding.rev1.md（T1–T4，K1 红刀）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStreamSink } from '../src/host/hub-stream.js'
import { makeWorld, textRequest } from './joined-world.js'
import { answers, assertStrict, textOf } from './node-trace-world.js'

// ── 替身 ─────────────────────────────────────────────────────────────────────────────────────────
// registry：记录 on/off；session：记录 append(type, data) 的调用序列。都不碰磁盘。
function fakeRegistry() {
  const listeners = new Map()
  const offCalls = []
  return {
    listeners,
    offCalls,
    on: (ev, fn) => listeners.set(ev, fn),
    off: (ev, fn) => { offCalls.push(ev); if (listeners.get(ev) === fn) listeners.delete(ev) },
    emit: (ev, payload) => listeners.get(ev)?.(payload),
  }
}
function fakeSession() {
  const log = []
  return { log, append: (type, data) => log.push({ type, data }) }
}
function fakeRt(registry) {
  const warnings = []
  return { rt: { state: { prefs: { mirrorStreamPreview: true } }, ctx: { get: key => (key === 'remote-agent:registry' ? registry : undefined) }, warn: (...a) => warnings.push(a) }, warnings }
}
const frame = (seq, text) => ({ exchangeId: 'x1', nodeId: 'n1', seq, text })
const previews = log => log.filter(e => e.type === 'assistant/message')
const previewText = e => e.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('')

// 线上校验器的规则：assistant/message 必须落在当前打开的 (turn, step) 上。
function assertOnlyOpenSteps(log) {
  let openTurn = null
  let openStep = null
  for (const { type, data } of log) {
    if (type === 'turn/start') { assert.equal(openTurn, null, 'turn/start inside an open turn'); openTurn = data.turn }
    else if (type === 'step/start') { assert.equal(data.turn, openTurn); assert.equal(openStep, null, 'step/start inside an open step'); openStep = data.step }
    else if (type === 'assistant/message') {
      assert.equal(data.turn, openTurn, `assistant/message on turn ${data.turn}, open turn is ${openTurn}`)
      assert.equal(data.step, openStep, `assistant/message on step ${data.step}, open step is ${openStep}`)
    }
    else if (type === 'step/end') { assert.equal(data.step, openStep); openStep = null }
    else if (type === 'turn/end') { assert.equal(openStep, null); openTurn = null }
  }
}

// T1 的完整序列：step 1 开着时两帧，trace 推进到 step 2 后再一帧，然后回合正常收尾。
function runMultiStep() {
  const registry = fakeRegistry()
  const { rt, warnings } = fakeRt(registry)
  const session = fakeSession()
  let current = 1
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const sink = openStreamSink(rt, { bot: { id: 'b' }, exchangeId: 'x1', nodeId: 'n1', binding: { session, turn: 1, step: 1 }, stepOf: () => current })
  registry.emit('botStream', frame(1, 'ab'))
  registry.emit('botStream', frame(2, 'cd'))
  const beforeAdvance = previews(session.log).length
  // trace 推进：hub-trace openStep() 写 step/end + step/start，sink.step() 变成 2
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  current = 2
  registry.emit('botStream', frame(3, 'ef'))
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1 })
  return { registry, session, sink, beforeAdvance, warnings }
}

// ── T1 多步回合 ─────────────────────────────────────────────────────────────────────────────────
test('T1 多步回合：stepOf 1 时两帧写在 step 1；推进到 2 后零新增 assistant/message，且已 dispose', () => {
  const { registry, session, sink, beforeAdvance } = runMultiStep()
  assert.ok(sink)
  assert.equal(beforeAdvance, 2)
  const all = previews(session.log)
  assert.deepEqual(all.slice(0, 2).map(e => e.data.step), [1, 1])
  assert.equal(all.length, 2, 'step 推进后不得再写任何 assistant/message')
  assert.ok(registry.offCalls.includes('botStream'), 'registry.off 被调用（sink 已 dispose）')
  assert.equal(registry.listeners.has('botStream'), false)
})

// ── T2 单步回合回归 ─────────────────────────────────────────────────────────────────────────────
test('T2 单步回合：stepOf 恒为 1，三帧三条 assistant/message，step 都是 1，文本逐次变长', () => {
  const registry = fakeRegistry()
  const { rt } = fakeRt(registry)
  const session = fakeSession()
  openStreamSink(rt, { bot: { id: 'b' }, exchangeId: 'x1', nodeId: 'n1', binding: { session, turn: 1, step: 1 }, stepOf: () => 1 })
  registry.emit('botStream', frame(1, 'hel'))
  registry.emit('botStream', frame(2, 'lo '))
  registry.emit('botStream', frame(3, 'world'))
  const all = previews(session.log)
  assert.equal(all.length, 3)
  assert.deepEqual(all.map(e => e.data.step), [1, 1, 1])
  const lens = all.map(e => previewText(e).length)
  assert.ok(lens[0] < lens[1] && lens[1] < lens[2], `文本长度应递增：${lens}`)
  assert.equal(previewText(all[2]), 'hello world')
  assert.equal(registry.listeners.has('botStream'), true, '单步回合不 dispose')
})

// ── T3 不传 stepOf 的兼容路径 ───────────────────────────────────────────────────────────────────
test('T3 旧签名（不传 stepOf）不抛异常，仍按 bind 的 step 写', () => {
  const registry = fakeRegistry()
  const { rt } = fakeRt(registry)
  const session = fakeSession()
  assert.doesNotThrow(() => openStreamSink(rt, { bot: { id: 'b' }, exchangeId: 'x1', nodeId: 'n1', binding: { session, turn: 4, step: 3 } }))
  registry.emit('botStream', frame(1, 'a'))
  registry.emit('botStream', frame(2, 'b'))
  const all = previews(session.log)
  assert.equal(all.length, 2)
  assert.deepEqual(all.map(e => [e.data.turn, e.data.step]), [[4, 3], [4, 3]])
})

// ── T4 整卷一致性 ───────────────────────────────────────────────────────────────────────────────
test('T4 整卷一致性：T1 序列里没有任何 assistant/message 落在未打开的 (turn, step) 上', () => {
  const { session } = runMultiStep()
  assertOnlyOpenSteps(session.log)
})

// ── T5（补充）真实 trace + 镜像回合端到端 ─────────────────────────────────────────────────────────
// 用 joined-world 走真实的 executor → hub-trace → hub-stream 链路：trace 打开 step 2 后再来的流式帧
// 不写入，回合收尾后整卷通过 node-trace-world 的严格校验。
const settle = () => new Promise(resolve => setImmediate(resolve))
const drain = async (times = 4) => { for (let i = 0; i < times; i += 1) await settle() }
const call = (id, name = 'bash', args = '{"command":"ls"}') => ({ id, name, args })
const A = (i, think, calls) => ({ i, t: 'a', ...(think ? { think } : {}), ...(calls ? { calls } : { end: true }) })
const R = (i, id, out = 'ok', ok = true) => ({ i, t: 'r', id, ok, out })

test('T5 端到端：trace 打开 step 2 后的 12 帧流式预览零写入，回合收尾后整卷合法', async () => {
  const w = makeWorld()
  w.rt.state.prefs = { ...(w.rt.state.prefs ?? {}), mirrorStreamPreview: true }
  await w.prompt(textRequest('hi', 'req-1'))
  await drain(2)
  const exchangeId = w.frames.filter(f => f.type === 'bot/turn')[0].payload.exchangeId
  const session = w.sessionOf('mirror-1')
  w.emitter.emit('botTrace', { nodeId: 'n1', remoteBotId: 'rb1', exchangeId, seq: 1,
    items: [A(1, 'plan', [call('c1')]), R(2, 'c1', 'a.txt'), A(3, 'read it', [call('c2', 'read', '{"file_path":"a.txt"}')]), R(4, 'c2', 'hello')] })
  assert.ok(session.log.some(e => e.type === 'step/start' && e.data.step === 2), 'trace 已打开 step 2')
  const before = answers(session).length
  for (let i = 1; i <= 12; i += 1) w.emitter.emit('botStream', { nodeId: 'n1', exchangeId, seq: i, text: 'part' + i + ' ' })
  assert.equal(answers(session).length, before)
  w.reply(0, { text: 'a.txt is there' })
  await w.idle()
  assertStrict(session)
  assert.equal(textOf(answers(session).at(-1)), 'a.txt is there')
})

test('T6 默认关闭镜像流式预览：一条消息只回一条答案（不再"发一条、回两条"）', async () => {
  const w = makeWorld()
  await w.prompt(textRequest('是否在线', 'req-1'))
  await drain(2)
  const exchangeId = w.frames.filter(f => f.type === 'bot/turn')[0].payload.exchangeId
  const session = w.sessionOf('mirror-1')
  for (let i = 1; i <= 6; i += 1) w.emitter.emit('botStream', { nodeId: 'n1', exchangeId, seq: i, text: '在线。'.slice(0, 1) })
  w.reply(0, { text: '身份：node013执行。在线。' })
  await w.idle()
  const said = answers(session).map(textOf).filter(text => text !== '')
  assert.deepEqual(said, ['身份：node013执行。在线。'])
  assertStrict(session)
})
