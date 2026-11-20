import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, touchGoal } from '../src/host/goals.js'

function setup(t) {
  const bots = new Map([['a', { id: 'a', name: 'Chief' }], ['b', { id: 'b', name: 'Writer' }]])
  const tasks = [{ botId: 'a', status: 'done' }, { botId: 'b', status: 'pending' }]
  const room = { id: 'r1', members: ['a', 'b'], goal: { id: 'g1', title: 'Ship it', status: 'active', current: 0, updatedAt: 0, revision: 1, stages: [{ status: 'active', tasks }] } }
  const lines = []
  const saves = []
  const rt = {
    ctx: { effect: (setupEffect) => t.after(setupEffect()) }, teamTools: [],
    botOf: id => bots.get(id), roomOf: () => room, state: { rooms: { r1: room } },
    roomActive: () => false, workingInRoom: () => [], roomBatchPending: () => false, roomInbox: new Map(),
    readOnly: () => undefined, hasLoaded: () => true,
    logRoom: (_, line) => lines.push(line), save: async () => saves.push(structuredClone(room.goal)),
  }
  install(rt)
  return { room, rt, lines, saves, tasks }
}

test('goal reminders are at least 60 seconds apart, and use one budget across goal changes and reloads', async (t) => {
  const { rt, room, lines, saves } = setup(t)
  await rt.goalRemind(room, 59_999)
  assert.equal(lines.length, 0)
  await rt.goalRemind(room, 60_000)
  await rt.goalRemind(room, 119_999)
  assert.equal(lines.length, 1)
  room.goal = structuredClone(saves.at(-1))
  await rt.goalRemind(room, 120_000)
  touchGoal(room.goal, undefined, 121_000)
  await rt.goalRemind(room, 180_000)
  await rt.goalRemind(room, 300_000)
  assert.equal(saves.length, 3)
  assert.equal(lines.length, 3)
  assert.ok(lines.every(line => line.kind === 'notice' && line.reason === 'goal-reminder' && /Writer/.test(line.text) && !/Chief/.test(line.text)))
  room.goal = { ...room.goal, id: 'g2', updatedAt: 300_000 }
  delete room.goal.reminder
  await rt.goalRemind(room, 360_000)
  assert.equal(lines.length, 4)
})

test('goal reminders wait for a pending task, a current Bot, and idle turn state', async (t) => {
  const { rt, room, lines, tasks } = setup(t)
  rt.roomActive = () => true
  await rt.goalRemind(room, 60_000)
  rt.roomActive = () => false
  rt.workingInRoom = () => [{ bot: rt.botOf('b') }]
  await rt.goalRemind(room, 61_000)
  rt.workingInRoom = () => []
  rt.roomBatchPending = () => true
  await rt.goalRemind(room, 62_000)
  rt.roomBatchPending = () => false
  rt.roomInbox.set(room.id, [{ text: 'Next' }])
  await rt.goalRemind(room, 63_000)
  rt.roomInbox.clear()
  room.goal.status = 'paused'
  await rt.goalRemind(room, 64_000)
  room.goal.status = 'active'
  tasks[1].status = 'working'
  await rt.goalRemind(room, 65_000)
  tasks[1].status = 'pending'
  room.members = ['a']
  await rt.goalRemind(room, 66_000)
  assert.equal(lines.length, 0)
  room.members.push('b')
  await rt.goalRemind(room, 67_000)
  assert.equal(lines.length, 1)
})
