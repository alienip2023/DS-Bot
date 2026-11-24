// Hand-offs: the work Bots give each other, and what each Bot is doing right now.
//
// A Bot's request to another Bot is a piece of work. What the recipient hands on while
// it works on it hangs below it, and the recipient's answer goes up only once all of
// that came back, together with what came back. Results find their way up by
// themselves, so no Bot needs to message one that waits for it, and that is the one
// hand-off refused. The open works are kept in state.json so a restart waits on.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LATE_ANSWER, MESSAGE_INLINE_MAX, TEXT_KEPT } from './constants.js'
import { headOf } from './text.js'
import { ownChatSessions } from './threads.js'

const minutes = since => {
  const count = Math.floor((Date.now() - since) / 60_000)
  return count < 1 ? 'for less than a minute' : `for ${count} min`
}
// A card can wait for days.
const forHowLong = since => {
  const hours = Math.floor((Date.now() - since) / 3_600_000)
  if (hours < 1) return minutes(since)
  if (hours < 24) return `for ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `for ${days} day${days === 1 ? '' : 's'}`
}

// A resume that did not get through is tried again once, this soon, before the next start sends it again.
const RESUME_RETRY_MS = 1_000

export function install(rt) {
  const { ctx, state } = rt
  const works = () => (state.works ??= {})
  // What came back, whole; state.json keeps the start of each.
  const whole = new Map()
  const save = () => void rt.save().catch(() => {})
  // Every change of a work is a line in the book `works` (ledger.js): what happened to it can be read back.
  const log = (event, id, extra = {}) => {
    try { rt.ledger?.append('works', { event, id, time: Date.now(), ...extra }) } catch {}
  }
  const nameOf = id => rt.botOf(id)?.name

  // The whole result of a work, in a file of its own: state.json is written whole on
  // every save, so it keeps only the start of a long result, and a restart would cut
  // that result short before it reached the Bot that asked for it.
  const resultsDir = join(rt.home, 'handoff-results')
  const resultPath = name => join(resultsDir, name)
  // A work id is a UUID, but a saved team could carry any name: it stays inside the
  // folder, and one that is not plain falls back to a hash of the id.
  const resultName = id => {
    const text = String(id)
    return `${/^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : createHash('sha256').update(text).digest('hex')}.txt`
  }
  const keptName = file => (typeof file === 'string' && /^[A-Za-z0-9_-]+\.txt$/.test(file) ? file : undefined)
  const writes = () => rt.readOnly?.() === undefined

  // The result of a work, whole, in a file of its own. The file is written before the
  // team file names it, so a result that is claimed to exist is there.
  function keepResult(id, text) {
    if (text.length <= TEXT_KEPT || !writes()) return undefined
    const name = resultName(id)
    const path = resultPath(name)
    const temp = `${path}.${process.pid}.tmp`
    try {
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, path)
      return name
    } catch (error) {
      rt.warn('ds-bot: result of work %s not kept whole: %s', id, error)
      try {
        rmSync(temp, { force: true })
      } catch {}
      return undefined
    }
  }

  // The copy of a result that is not needed any more: the answer it went into has it.
  const dropResult = file => {
    const name = keptName(file)
    if (name === undefined || !writes()) return
    try {
      // save() can resolve without writing during shutdown. Check the durable
      // references too, so an old state can still recover its result after restart.
      const saved = JSON.parse(readFileSync(join(rt.home, 'state.json'), 'utf8'))
      if (Object.values(saved.works ?? {}).some(work => (work.results ?? []).some(result => result.file === name))) return
      rmSync(resultPath(name), { force: true })
    } catch {}
  }

  // What came back for a work: the whole result if it is still to be found, else the
  // start of it. A result that a restart cut, or whose file is gone, is reported as
  // such and not passed on as if it were whole.
  function resultText(result) {
    if (whole.has(result.id)) return { text: whole.get(result.id), whole: true }
    if (result.length === undefined) return { text: result.text ?? '', whole: true }
    const name = keptName(result.file)
    if (name !== undefined) {
      try {
        const text = readFileSync(resultPath(name), 'utf8')
        if (text.length === result.length) return { text, whole: true }
      } catch {
        // The file is gone or unreadable: the start of the result is all there is.
      }
    }
    return { text: result.text ?? '', whole: false }
  }

  // The work a turn does: the request it answers, or the work a result that came back
  // (or a turn picked up again) goes on with.
  const workOf = info => (info === undefined ? undefined
    : info.role === 'request' && info.audience !== 'user' ? info.exchangeId : info.work)

  // `parent`: the work the sender was doing when it sent this one. `child`: the
  // session id of the subagent a run of this work belongs to — the run, not the
  // child, is the sub-work, so a child that is continued hands up a result per run.
  // `fromPart`: the part of the sender's own chat it wrote from, which its answer goes
  // back to when that is a background part.
  // No clock runs on a work (docs/plans/2026-11-24-work-model.md): a Bot that waits for the user's approval, or
  // a machine that is away, keeps the work open, and the status line says whom it waits for.
  function openWork(id, { from, to, parent, fromRoom, room, name, child, fromPart }) {
    const above = parent === undefined ? undefined : works()[parent]
    works()[id] = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(room ? { room } : {}), ...(above ? { parent } : {}), ...(fromRoom ? { fromRoom } : {}), ...(fromPart ? { fromPart } : {}), ...(name ? { name } : {}), ...(child ? { child } : {}), open: [], results: [], at: Date.now() }
    if (above !== undefined) above.open.push(id)
    log('open', id, { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(room ? { room } : {}), ...(above ? { parent } : {}) })
    save()
  }

  // The work a turn the user (or a routine) started does, once that turn hands something on: the root of what it
  // hands on. Nobody asked for it, so its answer is the turn's own text in that conversation; what comes back for it
  // resumes the Bot there (`part`).
  function openRootWork({ to, part }) {
    const id = randomUUID()
    works()[id] = { to, origin: 'person', part, open: [], results: [], at: Date.now() }
    log('open', id, { to, origin: 'person' })
    save()
    return id
  }
  const isRootWork = id => works()[id] !== undefined && works()[id].origin === 'person'

  // Handed on and not handed back yet; handed back and not read yet.
  const outstandingOf = work => work.open.filter(id => !(work.results ?? []).some(result => result.id === id))
  const unreadOf = work => (work.results ?? []).filter(result => work.open.includes(result.id))

  // All a work handed on is back: the Bot goes on with it in ONE turn, in the conversation the work is done in,
  // with every result that came back (OpenMausBot's resume). Results never steer into a running turn and never
  // queue as the user's input: the message waits for that conversation to be idle (the serial gate in deliver).
  // Results a message of their own brings (a group's report, a background task, a subagent, another machine) are
  // not taken in: their message wakes the Bot, and the turn that reads it comes back here when it ends.
  function resumeWork(id) {
    const work = works()[id]
    if (work === undefined || work.to === undefined || work.resume !== undefined) return false
    if (outstandingOf(work).length > 0) return false
    const unread = unreadOf(work)
    if (unread.length === 0 || unread.some(result => result.resume !== true)) return false
    if (rt.busyWithWork?.(id) === true) return false
    const bot = rt.botOf(work.to)
    // Only a Bot that runs on this machine is resumed here; one on another machine (a peer row, a joined shadow, a
    // remote worker) has its work on its own machine (W3: work frames), and nothing is sent to it from here.
    if (bot === undefined || bot.origin === 'peer' || bot.origin === 'joined' || bot.type === 'remote-worker') return false
    const sessionId = (work.part === undefined ? undefined : rt.resumeTargetOf?.(work.part)) ?? rt.chatOf(work.to)
    const parts = unread.map((result) => {
      const { text, whole } = resultText(result)
      const cut = whole ? '' : `\n[cut; ${result.length} characters in all, the rest was not kept]`
      if (result.failed === true) return `${result.name} could not send its reply to you; what it had answered:\n${text}${cut}`
      return `${result.name}:\n${text}${cut}`
    })
    const ids = unread.map(result => result.id)
    const from = [...new Set(unread.map(result => result.from).filter(other => typeof other === 'string' && rt.botOf(other) !== undefined))]
    const names = [...new Set(unread.map(result => result.name))]
    const exchangeId = randomUUID()
    work.resume = ids
    log('resume', id, { results: ids })
    save()
    const body = parts.join('\n\n')
    // Sent through the delivery journal (resume.js): one that does not get through stays noted and goes again at the
    // next start. It is tried once more in this run too; `work.resume` stays set, so nothing resumes the work twice.
    const send = (args, attempt) => rt.deliver(args).catch((error) => {
      rt.warn('ds-bot: work handed back to %s did not reach it: %s', bot.name, error)
      if (attempt >= 2) return
      const retry = setTimeout(() => {
        if (works()[id]?.resume === ids) void send(args, attempt + 1)
      }, RESUME_RETRY_MS)
      retry.unref?.()
    })
    void (body.length <= MESSAGE_INLINE_MAX ? Promise.resolve({ text: body, files: [] }) : rt.attachLong(body, 'Work handed back.txt'))
      .then(long => send({
        fromName: names.join(', '), toId: work.to, sessionId, role: 'results', exchangeId, work: id, results: ids,
        ...(from.length > 0 ? { resultFrom: from } : {}), note: names.join(', '),
        text: long?.text ?? body, ...(long?.length !== undefined ? { files: long.files, length: long.length } : {}),
      }, 1))
      .catch(error => rt.warn('ds-bot: work handed back to %s was not prepared: %s', bot.name, error))
    return true
  }

  // A turn doing work `id` ended with `reply` in Session `sessionId`. 'waiting': something it handed on is still
  // out, or came back and is still to be read (the answer is held, and it resumes once all is back). 'done': nothing.
  function workTurnEnded(id, reply, sessionId) {
    const work = works()[id]
    if (work === undefined) return 'gone'
    if (typeof sessionId === 'string' && sessionId !== '') work.part = sessionId
    if (work.open.length === 0) return 'done'
    if (reply !== '') work.held = headOf(reply, TEXT_KEPT)
    log('waiting', id, { open: work.open.length })
    save()
    resumeWork(id)
    return 'waiting'
  }

  // The answer to work `id` is on its way, with `result` from `name`. Returns the work
  // it goes on with. That work keeps waiting until a turn reads the answer (`taken`).
  function closeWork(id, name, text, extra = {}) {
    const work = works()[id]
    if (work === undefined) return undefined
    delete works()[id]
    // What it still waits for comes back to it alone.
    for (const child of Object.values(works())) if (child.parent === id) delete child.parent
    const above = works()[work.parent]
    if (above !== undefined) {
      // The whole result goes into a file of its own before the team file names it.
      const file = keepResult(id, text)
      above.results.push({ id, name, ...(work.to ? { from: work.to } : {}), text: headOf(text, TEXT_KEPT), ...(work.child ? { child: work.child } : {}), ...(text.length > TEXT_KEPT ? { length: text.length } : {}), ...(file ? { file } : {}), at: Date.now(), ...extra })
      whole.set(id, text)
    }
    for (const result of work.results ?? []) whole.delete(result.id)
    log(extra.abandoned === true ? 'abandoned' : 'done', id, above === undefined ? {} : { parent: work.parent })
    // Old state can still name these files until the replacement state lands.
    // A failed save must leave them available to the next host.
    void rt.save().then(() => {
      for (const result of work.results ?? []) dropResult(result.file)
    }).catch(() => {})
    return above === undefined ? undefined : work.parent
  }
  // The subagent run a settlement notice names. The notice carries only the
  // child's id, and a child's runs end one after another, so it is the earliest
  // settled run of that child not read yet, else a run of it still out.
  const subWorkRun = (id) => {
    let settled
    let live
    for (const [workId, work] of Object.entries(works())) {
      for (const openId of work.open) {
        const result = work.results?.find(result => result.id === openId)
        if ((result?.child ?? works()[openId]?.child ?? openId) !== id) continue
        if (result === undefined) live ??= { id: openId, parent: workId }
        else if (settled === undefined || (result.at ?? 0) < settled.at) settled = { id: openId, parent: workId, at: result.at ?? 0 }
      }
    }
    return settled ?? live
  }
  // A settled run is handed back like a teammate's reply: its closing text joins
  // the results of the work it hung under. `id` is the run's id, `child` the
  // child's, which named the sub-work before runs did.
  function settleSubWork(id, text, child) {
    const key = works()[id] !== undefined ? id : child
    const work = works()[key]
    if (work === undefined) {
      // The wait was already given up: the run's closing text still reaches the
      // Bot that waited, marked late, and settles nothing a second time.
      lateSubWorkResult(id, child, text)
      return undefined
    }
    const { parent } = work
    closeWork(key, work.name ?? 'subagent', text)
    return parent
  }
  // The closing text of a run whose wait was given up: delivered like a late reply,
  // and only while the Bot that waited is still on the team.
  function lateSubWorkResult(id, child, text) {
    const late = takeAbandoned(id) ?? takeAbandoned(child)
    if (late === undefined || text === '') return
    const waiting = late.waiting ?? works()[late.parent]?.to
    if (waiting === undefined || rt.botOf(waiting) === undefined) return
    void rt.deliver({
      fromName: late.name ?? 'the subagent', toId: waiting, text: LATE_ANSWER + text, role: 'reply',
      exchangeId: randomUUID(), recordExchange: false,
    }).catch(error => rt.warn('ds-bot: the late result of %s did not reach %s: %s', late.name ?? 'a subagent', waiting, error))
  }
  // A fast child can settle before its tool result identifies the call that made it.
  const nameSubWork = (id, name) => {
    const work = Object.entries(works()).find(([key, work]) => (work.child ?? key) === id)?.[1]
      ?? Object.values(works()).flatMap(work => work.results ?? []).find(result => (result.child ?? result.id) === id)
    if (work === undefined || work.name === name) return
    work.name = name
    save()
  }

  const dropWork = (id) => {
    const work = works()[id]
    if (work === undefined) return
    const { parent } = work
    delete works()[id]
    for (const child of Object.values(works())) if (child.parent === id) delete child.parent
    const above = works()[parent]
    if (above !== undefined) above.open = above.open.filter(other => other !== id)
    for (const result of work.results ?? []) whole.delete(result.id)
    log('dropped', id)
    void rt.save().then(() => {
      for (const result of work.results ?? []) dropResult(result.file)
    }).catch(() => {})
  }

  function taken(workId, id) {
    const work = works()[workId]
    if (work === undefined || !work.open.includes(id)) return
    work.open = work.open.filter(other => other !== id)
    // The resume message is read once every result it carried is.
    if (Array.isArray(work.resume) && work.resume.every(other => !work.open.includes(other))) delete work.resume
    save()
  }

  // A delivery the restart delayed is marked, so the answer that comes back for
  // the work says the request only arrived then.
  function lateWork(id) {
    const work = works()[id]
    if (work === undefined || work.late === true) return
    work.late = true
    save()
  }

  // The reply carrying a result never reached the asker: the failure reaches it
  // as an input instead (turns.js), which ends the wait when it is read like any
  // reply. The result kept with the work it was for is marked, so the answer
  // that goes up names it.
  function answerMissed(id) {
    for (const work of Object.values(works())) {
      if (!work.open.includes(id)) continue
      const result = (work.results ?? []).find(item => item.id === id)
      if (result !== undefined) result.failed = true
      save()
      return
    }
  }

  const owns = (botId, workId) => workId !== undefined && works()[workId]?.to === botId
  const waits = workId => (works()[workId]?.open.length ?? 0) > 0
  // The conversation a work is done in, so what comes back for it resumes the Bot there.
  const notePart = (workId, sessionId) => {
    const work = works()[workId]
    if (work === undefined || typeof sessionId !== 'string' || sessionId === '' || work.part === sessionId) return
    work.part = sessionId
    save()
  }
  function hold(workId, text) {
    const work = works()[workId]
    if (work === undefined || text === '') return
    work.held = headOf(text, TEXT_KEPT)
    save()
  }
  // Who asked for the work, as the turn that answers a request sees its trigger.
  const askedBy = workId => {
    const work = works()[workId]
    return work === undefined ? undefined : { kind: 'bot', role: 'request', exchangeId: workId, senderSessionId: work.from, ...(work.fromPart ? { senderPart: work.fromPart } : {}), ...(work.fromRoom ? { senderRoomId: work.fromRoom } : {}) }
  }
  // The answer that goes up: what the Bot said last for this work, then what came back.
  function answerText(workId, reply, botName) {
    const work = works()[workId]
    const said = reply !== '' ? reply : work?.held ?? ''
    const results = (work?.results ?? []).map(result => {
      const { text, whole } = resultText(result)
      const cut = whole ? '' : `\n[cut; ${result.length} characters in all, the rest was not kept]`
      if (result.failed === true) return `${result.name} could not send its reply to you; what it had answered:\n${text}${cut}`
      return `${result.name}:\n${text}${cut}`
    })
    const body = results.length === 0 ? said || `${botName} finished without a reply.`
      : [said || `${botName} finished and wrote nothing more.`, `[Handed back to ${botName} for this work]`, ...results].join('\n\n')
    // The request reached its target only after a restart; the answer says so.
    return work?.late === true ? `[This request reached ${botName} only after DeepSeek Harness restarted.]\n\n${body}` : body
  }

  // The Bots waiting for the result of these works: whoever asked for each, and on up.
  function upstreamOf(workIds) {
    const bots = new Set()
    for (const workId of workIds) {
      const seen = new Set()
      for (let id = workId; id !== undefined && !seen.has(id) && works()[id] !== undefined; id = works()[id].parent) {
        seen.add(id)
        if (works()[id].from) bots.add(works()[id].from)
      }
    }
    return bots
  }

  // Two requests from one sender belong to the same work when they were sent for it.
  const sameWork = (id, parent) => (works()[id]?.parent ?? undefined) === (works()[parent] === undefined ? undefined : parent)

  // The works their Bots wait on, outside a turn that does them (`busy`): each with what
  // it handed on that has not come back yet. One that came back waits only to be read.
  const held = busy => Object.entries(works())
    .filter(([id, work]) => work.to !== undefined && work.open.length > 0 && !busy.has(id))
    .map(([id, work]) => ({ id, work, out: work.open.map(childId => ({ id: childId, work: works()[childId] })).filter(child => child.work !== undefined) }))
  const busyWith = sessionIds => new Set(sessionIds.map(sessionId => rt.live.get(sessionId)).filter(entry => entry?.turn !== undefined).map(entry => workOf(entry.info)).filter(Boolean))

  // Per Bot, the Bots and groups it waits for, and the Bots it does that work for.
  function waitingView() {
    const view = {}
    const add = (list, id) => { if (id !== undefined && !list.includes(id)) list.push(id) }
    for (const { work, out } of held(busyWith([...rt.live.keys()]))) {
      if (out.length === 0) continue
      const entry = view[work.to] ??= { bots: [], rooms: [], for: [], waits: [] }
      for (const { id, work: child } of out) {
        add(child.room ? entry.rooms : entry.bots, child.room ?? child.to)
        entry.waits.push({ id, ...(child.room ? { room: child.room, name: rt.roomOf(child.room)?.name } : { to: child.to, name: nameOf(child.to) ?? child.name }) })
      }
      add(entry.for, work.from)
    }
    return view
  }

  // Works whose wait was given up, kept so a reply that arrives afterwards is known
  // for a late answer instead of a new one. Small: a reply uses one up, and only the
  // newest are kept.
  const ABANDONED_KEPT = 100
  const abandonedWorks = () => (state.abandonedWorks ??= {})
  function rememberAbandoned(id, entry) {
    const map = abandonedWorks()
    map[id] = entry
    const ids = Object.keys(map)
    if (ids.length > ABANDONED_KEPT) {
      for (const old of ids.sort((a, b) => (map[a].at ?? 0) - (map[b].at ?? 0)).slice(0, ids.length - ABANDONED_KEPT)) delete map[old]
    }
    save()
  }
  // The abandoned wait a late reply is for, if any. One reply only: the note is used up.
  function takeAbandoned(id) {
    const map = abandonedWorks()
    const entry = map[id]
    if (entry === undefined) return undefined
    delete map[id]
    save()
    return entry
  }
  const cap = text => text.charAt(0).toUpperCase() + text.slice(1)
  const labelOfWork = work => (work.room !== undefined
    ? `the group chat "${rt.roomOf(work.room)?.name ?? 'a group chat'}"`
    : nameOf(work.to) ?? work.name ?? 'the other Bot')

  // Giving up one wait: the sub-work closes with an explicit result that says no reply
  // came back, so the work above it goes on. Only this branch settles; the parent's
  // other open works stay. `gone` is the startup sweep, whose target no longer exists.
  function abandonWork(id, reason = 'user') {
    const work = works()[id]
    const parent = work?.parent === undefined ? undefined : works()[work.parent]
    if (work === undefined || parent === undefined || !parent.open.includes(id)) return false
    const target = labelOfWork(work)
    const name = rt.botOf(work.to)?.name ?? work.name ?? (work.room !== undefined ? rt.roomOf(work.room)?.name : undefined) ?? 'the other Bot'
    const text = reason === 'gone'
      ? cap(target) + ' is no longer on the team, so no reply can come back for the work handed to it. The user gave up waiting for that answer: this counts as its result. Go on with the work you were given, and say plainly that this answer is missing.'
      : 'No reply came back from ' + target + ', and the user gave up waiting for it. This counts as its result: go on with the work you were given, and say plainly that this answer is missing.'
    rememberAbandoned(id, { at: Date.now(), from: work.from, to: work.to, room: work.room, parent: work.parent, name, reason, ...(parent.to !== undefined ? { waiting: parent.to } : {}) })
    // Work handed to another machine stops there too (W3), and answers no more.
    if (work.remote !== undefined) rt.link?.cancel?.(id)
    // Its result is that no answer came; it counts like any result handed back, and the Bot that waited goes on
    // once everything else it handed on for that work is back too (one resume, docs/plans/2026-11-24-work-model.md).
    closeWork(id, name, text, { abandoned: true, abandonedAt: Date.now(), abandonedReason: reason, resume: true })
    // Where it resumes: the part the Bot handed it on from, when the work has no conversation of its own yet.
    if (parent.part === undefined && work.fromPart !== undefined) parent.part = work.fromPart
    save()
    resumeWork(work.parent)
    return true
  }

  // A restart settles the waits whose target no longer exists, with the same path as a
  // user giving up: a deleted Bot or a deleted group. Those are the targets the team
  // file states for certain. A subagent run is left to the menu: whether its Session
  // still exists cannot be told apart from a DSH that cannot read Sessions, and a
  // running child must not be given up on a guess.
  function reconcileLostWorks() {
    if (rt.readOnly?.() !== undefined) return
    for (const [id, work] of Object.entries(works())) {
      if (work.parent === undefined || works()[work.parent] === undefined) continue
      if (!works()[work.parent].open.includes(id)) continue
      const gone = work.room !== undefined ? rt.roomOf(work.room) === undefined
        : work.to !== undefined ? rt.botOf(work.to) === undefined
          : false
      if (gone) abandonWork(id, 'gone')
    }
  }
  // A host without a context (the narrow tests) has no startup to reconcile. The sweep
  // waits a tick: the team file loads through every module's own setup, and this module
  // is installed before the ones that load it.
  ctx?.effect?.(() => {
    const timer = setTimeout(() => {
      void rt.load().then(() => reconcileLostWorks()).catch(error => rt.warn('ds-bot: lost waits not settled: %s', error))
    }, 0)
    return () => clearTimeout(timer)
  }, 'ds-bot: lost hand-offs')

  // A deleted Bot answers no more work and waits for none.
  function forgetBot(botId) {
    const waiting = Object.entries(works()).filter(([, work]) => work.to === botId).map(([id]) => askedBy(id))
    for (const [id, work] of Object.entries(works())) if (work.from === botId && work.to !== botId) dropWork(id)
    return waiting
  }

  // What a Bot is doing, in one line for the Bots that work with it.
  function statusOf(botId) {
    const chat = rt.chatOf(botId)
    // A Bot's own chat may keep parts running in the background, as its group Sessions
    // may run: a Bot working there is not idle, and the line says where.
    const bot = rt.botOf(botId)
    const own = bot === undefined ? [chat] : ownChatSessions(bot)
    const sessions = [...new Set([...own, ...(rt.groupSessionsOf?.(botId) ?? [])])]

    // A joined (node) Bot's mirror Session has no local Agent, so rt.live is never
    // set for it. Check joinedInFlight directly so statusOf reports "working" rather
    // than "idle" while a page turn is in flight to the node.
    if (rt.joinedInFlight?.has(botId)) {
      return 'working in its own chat (on its node)'
    }
    const place = sessionId => {
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      if (room) return `in group "${room.name}"`
      const task = rt.taskBySession?.(sessionId)?.task
      if (task !== undefined) return `in background task "${task.title}"`
      return 'in its own chat'
    }
    const forWhom = (sessionId, info) => {
      if (rt.groupOwners.has(sessionId)) return info?.askedBy && nameOf(info.askedBy) ? `, for ${nameOf(info.askedBy)}` : ''
      const asker = info?.role === 'request' || info?.role === 'stopped' ? info.senderSessionId : works()[workOf(info)]?.from
      if (asker !== undefined) return nameOf(asker) ? `, for ${nameOf(asker)}` : ''
      return info === undefined ? ', for the user' : ''
    }
    const doing = (entry) => {
      const what = rt.doingOf?.(entry) ?? {}
      if (what.tool) return `: running ${what.tool}${what.target ? ` on ${what.target}` : ''}`
      return what.said ? `: "${what.said.slice(0, 100)}"` : ''
    }
    const lines = []
    const approval = (rt.approvalsView?.() ?? []).find(entry => entry.botId === botId)
    const switching = [...(rt.switchJobs?.() ?? [])].find(job => job.botId === botId)
    const running = sessions.filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
    if (approval !== undefined) lines.push(`waiting for the user's approval to run ${approval.tool || 'a tool'} ${place(approval.sessionId)} (${minutes(approval.at)})`)
    else if (switching !== undefined) lines.push(`moving on to a fresh part of its ${switching.roomId ? `conversation in group "${rt.roomOf(switching.roomId)?.name ?? '?'}"` : 'own chat'}`)
    for (const sessionId of approval === undefined && switching === undefined ? running : []) {
      const entry = rt.live.get(sessionId)
      lines.push(`working ${place(sessionId)} ${minutes(entry.since ?? Date.now())}${forWhom(sessionId, entry.info)}${doing(entry)}`)
    }
    for (const { work, out } of held(busyWith(running))) {
      if (work.to !== botId) continue
      const forName = nameOf(work.from) ? `, for ${nameOf(work.from)}` : ''
      const on = [...new Set(out.map(({ work: child }) => (child.room ? `group "${rt.roomOf(child.room)?.name ?? 'a group'}"` : child.name ?? nameOf(child.to) ?? 'a teammate')))]
      lines.push(on.length > 0 ? `waiting for ${on.join(' and ')} to hand back work${forName}` : `about to go on with work${forName}, whose results came back`)
    }
    if (lines.length === 0) lines.push('idle')
    for (const [kind, card] of [['question', state.questions?.[chat]], ['view', state.views?.[chat]]]) {
      if (card !== undefined) lines.push(`a ${kind} card in its own chat has waited for the user's answer ${forHowLong(card.askedAt)}`)
    }
    const unread = new Map()
    for (const args of rt.unreadOf?.(chat) ?? []) {
      const name = nameOf(args.fromId)
      if (name !== undefined) unread.set(name, (unread.get(name) ?? 0) + 1)
    }
    if (unread.size > 0) lines.push(`not read yet: ${[...unread].map(([name, count]) => `${count} from ${name}`).join(', ')}`)
    return lines.join('; ')
  }

  // P3: When a Bot enters blocked state, immediately notify any Bot waiting on its work.
  // The blocking code is safe to share (it's an error category, not credentials).
  function notifyBlockedDelegators(botId, code) {
    for (const [id, work] of Object.entries(works())) {
      if (work.to !== botId) continue
      const fromName = rt.botOf(work.from)?.name ?? 'A Bot'
      const toName = rt.botOf(botId)?.name ?? 'a Bot'
      const text = `[Message from ${toName}]\n${toName} cannot continue: it is blocked (${code}). The work you asked it to do is on hold until the user fixes it.`
      void rt.deliver({ fromId: botId, toId: work.from, sessionId: rt.chatOf(work.from), role: 'reply', replyTo: id, exchangeId: id, text }).catch(() => {})
    }
  }

  Object.assign(rt, { workOf, openWork, openRootWork, isRootWork, resumeWork, workTurnEnded, noteWorkPart: notePart, closeWork, dropWork, takenWork: taken, lateWork, answerMissed, ownsWork: owns, waitsWork: waits, holdWork: hold, workAsker: askedBy, answerText, upstreamOf, sameWork, forgetBotWork: forgetBot, statusOf, waitingView, settleSubWork, subWorkRun, nameSubWork, abandonWork, abandonedWork: takeAbandoned, notifyBlockedDelegators })
}
