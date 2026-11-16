import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

function elapsedText(task) {
  const settled = task.status === 'completed' || task.status === 'failed'
  const end = settled ? task.endedAt ?? Date.now() : Date.now()
  const seconds = Math.max(0, Math.floor((end - task.startedAt) / 1000))
  if (seconds < 60) return t('{count}s', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('{count}m', { count: minutes })
  const hours = t('{count}h', { count: Math.floor(minutes / 60) })
  return minutes % 60 ? `${hours} ${t('{count}m', { count: minutes % 60 })}` : hours
}

function taskText(task) {
  const status = { queued: t('Queued'), running: t('Running'), completed: t('Completed'), failed: t('Failed') }[task.status] ?? task.status
  const parts = [status, elapsedText(task)]
  const summary = typeof task.summary === 'string' ? task.summary.trim() : ''
  if (task.status === 'completed' && summary) parts.push(t('{count} lines', { count: summary.split(/\r\n|\r|\n/).length }))
  if (task.nodeOnline === false) parts.push(t('Node offline'))
  return parts.join(' · ')
}

export function RemoteTasksRow({ bot, actions }) {
  const [tasks, setTasks] = useState([])
  const [error, setError] = useState('')
  useEffect(() => {
    let stopped = false
    let loading = false
    setTasks([])
    setError('')
    const load = async () => {
      if (loading) return
      loading = true
      try {
        const next = await call('remote-tasks', { botId: bot.id, limit: 5 })
        if (!stopped) { setTasks(next.tasks); setError('') }
      } catch (error) {
        if (!stopped) setError(error.message)
      } finally {
        loading = false
      }
    }
    void load()
    const timer = setInterval(load, 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, [bot.id, actions])
  return h('div', { className: 'bt-drawer-model' },
    h('div', { className: 'bt-section-title' }, t('Remote tasks')),
    tasks.length === 0
      ? h('span', { className: 'bt-note' }, t('No remote tasks yet. Send a task to a Bot on another machine.'))
      : tasks.map(task => h('div', { key: task.taskId, className: 'bt-kv' },
          h('span', null, `${task.nodeId} · ${task.goal}`),
          h('span', null, taskText(task)))),
    error ? h('span', { className: 'bt-note bt-danger' }, error) : null)
}
