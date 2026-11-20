// P3 waker.js 测试：planWakes 事件路由
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planWakes } from '../src/host/waker.js'

function fakeRt(overrides = {}) {
  const bots = {
    admin: { id: 'admin', name: 'Chief' },
    worker: { id: 'worker', name: 'Dev' },
    qa: { id: 'qa', name: 'QA' },
  }
  return {
    botOf: id => bots[id],
    isMain: id => id === 'admin',
    warn: () => {},
    state: { rooms: {} },
    ...overrides,
  }
}

const room = { id: 'r1', name: 'Ops', admin: 'admin', members: ['admin', 'worker', 'qa'], tasks: {} }
const task = { id: 't1', botId: 'worker', goal: 'Fix the bug', status: 'active' }

test('task/opened: notifies admin when opener is not admin', () => {
  const rt = fakeRt()
  const plans = planWakes(rt, 'task/opened', { room, task })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].toId, 'admin')
  assert.match(plans[0].text, /Task opened/)
  assert.match(plans[0].key, /task-opened/)
})

test('task/opened: no plan when opener is admin', () => {
  const rt = fakeRt()
  const plans = planWakes(rt, 'task/opened', { room, task: { ...task, botId: 'admin' } })
  assert.equal(plans.length, 0)
})

test('task/completed: routes to paired reviewer (main bot) + admin if different', () => {
  const rt = fakeRt()
  const doneTask = { ...task, status: 'done', result: 'Fixed.' }
  const plans = planWakes(rt, 'task/completed', { room, task: doneTask })
  // admin is main and not task.botId → gets review
  const keys = plans.map(p => p.key)
  assert.ok(keys.some(k => k.includes('review')), 'review wake present')
  assert.ok(plans.every(p => p.toId !== 'worker'), 'task owner not woken')
})

test('task/review-requested: routes to paired reviewer', () => {
  const rt = fakeRt()
  const plans = planWakes(rt, 'task/review-requested', { room, task })
  assert.ok(plans.length >= 1)
  assert.ok(plans.some(p => p.toId === 'admin'))
})

test('task/note: notifies task owner for open task', () => {
  const rt = fakeRt()
  const plans = planWakes(rt, 'task/note', { room, task, noteText: 'Please also check X.' })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].toId, 'worker')
  assert.match(plans[0].text, /Note on your task/)
})

test('task/note: silent for terminal task', () => {
  const rt = fakeRt()
  const plans = planWakes(rt, 'task/note', { room, task: { ...task, status: 'done' } })
  assert.equal(plans.length, 0)
})

test('task/cancelled: notifies owner if cancelled by another', () => {
  const rt = fakeRt()
  const plans = planWakes(rt, 'task/cancelled', { room, task: { ...task, status: 'cancelled', reason: 'Scope changed' }, cancelledBy: 'admin' })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].toId, 'worker')
})

test('task/cancelled: no plan if owner cancelled themselves', () => {
  const rt = fakeRt()
  const plans = planWakes(rt, 'task/cancelled', { room, task: { ...task, status: 'cancelled' }, cancelledBy: 'worker' })
  assert.equal(plans.length, 0)
})

test('goal/idle: wakes admin when goal active', () => {
  const rt = fakeRt()
  const r = { ...room, goal: { status: 'active', revision: 1, idle: false } }
  const plans = planWakes(rt, 'goal/idle', { room: r })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].toId, 'admin')
  assert.match(plans[0].text, /Goal check/)
})

test('goal/idle: silent when goal not active', () => {
  const rt = fakeRt()
  const r = { ...room, goal: { status: 'done', revision: 1 } }
  assert.equal(planWakes(rt, 'goal/idle', { room: r }).length, 0)
})

test('goal/idle: silent when goal.idle=true', () => {
  const rt = fakeRt()
  const r = { ...room, goal: { status: 'active', revision: 1, idle: true } }
  assert.equal(planWakes(rt, 'goal/idle', { room: r }).length, 0)
})

test('config/changed: only wakes members with active tasks', () => {
  const rt = fakeRt()
  const r = { ...room, tasks: { t1: { id: 't1', botId: 'worker', status: 'active', goal: 'work' } } }
  const plans = planWakes(rt, 'config/changed', { room: r })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].toId, 'worker')
})

test('config/changed: no wakes when all tasks are terminal', () => {
  const rt = fakeRt()
  const r = { ...room, tasks: { t1: { id: 't1', botId: 'worker', status: 'done', goal: 'work' } } }
  assert.equal(planWakes(rt, 'config/changed', { room: r }).length, 0)
})

test('member/failed: notifies admin', () => {
  const rt = fakeRt()
  const plans = planWakes(rt, 'member/failed', { room, member: { id: 'worker', name: 'Dev' }, reason: '429 rate limit' })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].toId, 'admin')
  assert.match(plans[0].text, /Member failed/)
})

test('unknown event: returns empty plans', () => {
  const rt = fakeRt()
  assert.deepEqual(planWakes(rt, 'unknown/event', { room }), [])
})

test('planWakes: plans have distinct keys', () => {
  const rt = fakeRt()
  const doneTask = { ...task, status: 'done', result: 'done' }
  const plans = planWakes(rt, 'task/completed', { room, task: doneTask })
  const keys = plans.map(p => p.key)
  const unique = new Set(keys)
  assert.equal(unique.size, keys.length, 'all keys unique')
})
