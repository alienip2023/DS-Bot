// Bot targets belong to the plugin: DSH schedule only accepts Session destinations.
// Time arithmetic stays with DSH; execution uses the same path as a Bot chat send.
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { mirrorTurnOpen } from './joined-mirror-writer.js'

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const unfinished = run => run?.status === 'queued' || run?.status === 'running'
let timingApi
const timing = () => (timingApi ??= import('@deepseek-ai/dsh-schedule'))

export function installBotRoutines(rt) {
  const { ctx } = rt
  const jobs = new Map()
  const completions = new Map()
  let initialized = false
  let closed = false
  let timer
  let driving = Promise.resolve()

  const tasks = () => {
    rt.state.routines ??= {}
    return Object.values(rt.state.routines)
  }
  const warn = error => rt.warn?.('ds-bot: routine failed: %s', error?.message ?? error)
  const wake = () => { void runDueRoutines().catch(error => {
    warn(error)
    if (!closed) { timer = setTimeout(wake, 30_000); timer.unref?.() }
  }) }

  async function initialize() {
    await rt.load()
    if (initialized) return
    initialized = true
    let changed = false
    for (const task of tasks()) {
      if (task.lastRun !== undefined) task.lastRun = task.runs?.find(run => run.id === task.lastRun.id) ?? task.lastRun
      if (!unfinished(task.lastRun)) continue
      Object.assign(task.lastRun, { status: 'failed', error: 'Host restarted; execution was interrupted. Check the chat before retrying.', finishedAt: Date.now() })
      changed = true
    }
    if (changed) await rt.save()
  }

  function arm() {
    clearTimeout(timer)
    if (closed) return
    const next = tasks().filter(task => task.status === 'active' && !jobs.has(task.id))
      .reduce((at, task) => Math.min(at, Date.parse(task.scheduledAt)), Infinity)
    if (!Number.isFinite(next)) return
    timer = setTimeout(wake, Math.min(2_147_483_647, Math.max(0, next - Date.now())))
    timer.unref?.()
  }

  ctx.on('session/event', (session, event) => {
    const waiting = completions.get(session?.id)
    if (waiting === undefined) return
    if (event?.type === 'turn/start') waiting.started = true
    if (event?.type !== 'turn/end' || !waiting.started) return
    const reason = event.data?.reason
    if (reason?.kind === 'error') waiting.reject(new Error(reason.error?.message ?? reason.error?.code ?? 'Bot turn failed'))
    else if (reason?.kind !== undefined && reason.kind !== 'completed') waiting.reject(new Error(`Bot turn ended: ${reason.kind}`))
    else waiting.resolve()
  })
  ctx.on('session/disposed', session => completions.get(session?.id)?.reject(new Error('Bot Session was disposed')))

  async function execute(task, run, controller) {
    const botId = task.target.botId
    // A joined page turn is not in the local thread gate. Wait before claiming its
    // mirror, so a routine cannot interrupt it or be rejected merely for being busy.
    while (rt.joinedInFlight?.has(botId) || mirrorTurnOpen(rt, botId)) {
      await delay(100, undefined, { signal: controller.signal })
    }
    if (closed || controller.signal.aborted) throw new Error('Routine was cancelled')
    const bot = rt.botOf(botId)
    if (bot === undefined) throw new Error('No such Bot')
    if (bot.origin === 'peer') throw new Error('Peer Bot delivery is unavailable')
    const sessionId = rt.chatOf(botId)
    Object.assign(run, { status: 'running', sessionId, startedAt: Date.now() })
    await rt.save()
    const text = `[Scheduled task: ${task.title}]\n${task.prompt}`
    if (bot.origin === 'joined') {
      const result = await rt.sendUser({ sessionId: botId, requestId: run.id, content: [{ type: 'text', text }], wait: true })
      if (result?.ok === false) throw new Error('Bot turn was stopped')
    } else {
      let resolve
      let reject
      const done = new Promise((yes, no) => { resolve = yes; reject = no })
      // Attach before prompt: even a synchronous mock or a very fast model may end
      // its turn before the controller returns its acceptance acknowledgment.
      done.catch(() => {})
      const waiting = { resolve, reject, started: false }
      completions.set(sessionId, waiting)
      const watch = setTimeout(() => { if (!waiting.started) reject(new Error('Bot accepted the routine but never started its turn')) }, 60_000)
      watch.unref?.()
      const abort = () => reject(new Error('Routine was cancelled'))
      controller.signal.addEventListener('abort', abort, { once: true })
      try {
        await rt.sendUser({ sessionId, requestId: run.id, content: [{ type: 'text', text }] })
        await done
      } finally {
        clearTimeout(watch)
        controller.signal.removeEventListener('abort', abort)
        if (completions.get(sessionId) === waiting) completions.delete(sessionId)
      }
    }
    if (!closed) Object.assign(run, { status: 'succeeded', finishedAt: Date.now() })
  }

  async function finish(task, run, error) {
    if (error !== undefined) Object.assign(run, { status: 'failed', error: `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`, finishedAt: Date.now() })
    jobs.delete(task.id)
    await rt.save()
    arm()
  }

  async function drive(now) {
    await initialize()
    if (closed) return
    const api = tasks().length === 0 ? undefined : await timing()
    for (const task of tasks()) {
      if (task.status !== 'active' || jobs.has(task.id) || Date.parse(task.scheduledAt) > now) continue
      const previous = structuredClone(task)
      const occurrence = api.isRecurringScheduleRecord(task) ? api.resolveRecurringOccurrence(task, now) : { occurrenceAt: task.scheduledAt }
      const run = { id: randomUUID(), scheduledAt: occurrence.occurrenceAt, status: 'queued', queuedAt: Date.now() }
      task.runs = [...(task.runs ?? []).slice(-19), run]
      task.lastRun = run
      if (occurrence.nextScheduledAt === undefined) task.status = 'ended'
      else task.scheduledAt = occurrence.nextScheduledAt
      // Reserve before sending. An interrupted/uncertain dispatch is recorded on
      // restart, never blindly replayed into a second real Bot turn.
      try { await rt.save() } catch (error) { rt.state.routines[task.id] = previous; throw error }
      const controller = new AbortController()
      jobs.set(task.id, controller)
      const runTurn = async () => {
        try { await execute(task, run, controller); await finish(task, run) }
        catch (error) { await finish(task, run, error) }
      }
      void rt.sendThreadTurn({
        botId: task.target.botId, kind: 'send', preview: task.prompt, releaseOn: 'run', signal: controller.signal, run: runTurn,
        onCancel: () => finish(task, run, new Error('Routine was cancelled before it started')),
      }).catch(error => finish(task, run, error).catch(warn))
    }
    arm()
  }

  function runDueRoutines(now = Date.now()) {
    const next = driving.then(() => drive(now))
    driving = next.catch(() => {})
    return next
  }

  async function create({ target, title, prompt, selector }) {
    await initialize()
    const bot = target?.kind === 'bot' ? rt.botOf(target.botId) : undefined
    if (bot === undefined) throw invalid('No such Bot')
    if (bot.origin === 'peer') throw invalid('Peer Bot delivery is unavailable')
    const api = await timing()
    const id = `routine-${randomUUID()}`
    const [kind] = Object.keys(selector)
    const build = { at: api.createAtScheduleRecord, every_seconds: api.createEveryScheduleRecord, daily: api.createDailyScheduleRecord, weekly: api.createWeeklyScheduleRecord }[kind]
    const record = build(id, prompt, selector[kind], Date.now(), title)
    rt.state.routines[id] = { ...record, target: { kind: 'bot', botId: bot.id }, status: 'active', runs: [] }
    try { await rt.save() } catch (error) { delete rt.state.routines[id]; throw error }
    arm()
  }

  async function view() {
    await initialize()
    return tasks().map(task => ({ ...task, botId: task.target.botId, sessionId: rt.chatOf(task.target.botId), state: task.status === 'active' ? (Date.parse(task.scheduledAt) <= Date.now() ? 'overdue' : 'scheduled') : 'finished' }))
  }

  async function remove({ id, target }) {
    await initialize()
    const task = rt.state.routines[id]
    if (task === undefined || target?.kind !== 'bot' || target.botId !== task.target.botId) throw invalid('No such task')
    delete rt.state.routines[id]
    try { await rt.save() } catch (error) { rt.state.routines[id] = task; throw error }
    jobs.get(id)?.abort()
    jobs.delete(id)
    arm()
  }

  ctx.effect(() => {
    void Promise.resolve().then(() => { if (!closed) wake() })
    return async () => {
      closed = true
      clearTimeout(timer)
      for (const controller of jobs.values()) controller.abort()
      for (const task of tasks()) {
        if (unfinished(task.lastRun)) Object.assign(task.lastRun, { status: 'failed', error: 'Host stopped; execution was interrupted.', finishedAt: Date.now() })
      }
      if (jobs.size > 0) await rt.save().catch(warn)
    }
  }, 'ds-bot: Bot routines')

  rt.runDueRoutines = runDueRoutines
  return { create, view, remove }
}
