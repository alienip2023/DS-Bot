// A node Bot's running background tasks are visible on the hub: the node puts a small summary in
// its roster report, the hub keeps it on the Bot's shadow row (nodeTasks) and the Bot list shows it
// as read-only tasks while the node is up.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRosterReport, reportableBots, taskSummaryOf } from '../src/host/roster-join.js'

const view = [
  { id: 't1', title: 'Build the site', status: 'running', startedAt: 100, sessionId: 's1' },
  { id: 't2', title: 'Wait for approval', status: 'waiting_approval', startedAt: 200, sessionId: 's2' },
  { id: 't3', title: 'Old', status: 'completed', startedAt: 50, endedAt: 60, sessionId: 's3' },
  { id: 't4', title: 'In a group', status: 'running', startedAt: 300, roomId: 'r1', sessionId: 's4' },
]

test('only the running tasks of the Bot\'s own chat are summarized, small and without sessions', () => {
  const summary = taskSummaryOf(view)
  assert.deepEqual(summary.map(task => task.id), ['t1', 't2'])
  assert.deepEqual(Object.keys(summary[0]).sort(), ['id', 'startedAt', 'status', 'title'])
  assert.equal(taskSummaryOf(Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: 'x', status: 'running', startedAt: i }))).length, 8)
  assert.deepEqual(taskSummaryOf(undefined), [])
})

test('the roster entry carries the tasks only when a task view is given', () => {
  const bots = { a: { id: 'a', name: 'A', role: '' } }
  assert.equal('tasks' in reportableBots(bots)[0], false)
  assert.deepEqual(reportableBots(bots, () => view)[0].tasks.map(task => task.id), ['t1', 't2'])
  assert.deepEqual(reportableBots(bots, () => [])[0].tasks, [], 'an empty list says none are running')
  assert.equal('tasks' in reportableBots(bots, () => { throw new Error('no view') })[0], false)
})

test('the hub keeps the reported tasks on the shadow row, clears them on an empty list, keeps them for an older node', () => {
  const state = { bots: {}, mainBotIds: [] }
  const report = bots => ({ nodeId: 'n1', hostname: 'h', online: true, bots })
  const entry = (extra = {}) => ({ id: 'rb1', name: 'W', role: '', ...extra })
  let changes = []
  const apply = bots => applyRosterReport(state, report(bots), Date.now(), changed => changes.push(changed))
  apply([entry({ tasks: taskSummaryOf(view) })])
  const row = Object.values(state.bots)[0]
  assert.deepEqual(row.nodeTasks.map(task => task.id), ['t1', 't2'])
  changes = []
  const same = row.nodeTasks
  apply([entry({ tasks: taskSummaryOf(view) })])
  assert.equal(Object.values(state.bots)[0].nodeTasks, same, 'an unchanged list keeps the same array')
  assert.deepEqual(changes, [false], 'and is not a change')
  apply([entry()])
  assert.equal(Object.values(state.bots)[0].nodeTasks, same, 'a report without tasks (an older node) keeps what was known')
  apply([entry({ tasks: [] })])
  assert.deepEqual(Object.values(state.bots)[0].nodeTasks, [])
})
