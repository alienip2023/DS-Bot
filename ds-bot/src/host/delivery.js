// Delivery: how one Bot, the user, or DS Bot itself puts a message into a Bot Session.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HISTORY_TIMEOUT_MS, LONG_HEAD, MESSAGE_INLINE_MAX, READ_LINE_MAX, SOURCE_KIND, TEXT_KEPT, TEXT_SHOW_MAX } from './constants.js'
import { joinedShadow, refuseJoinedDispatch } from './roster-join.js'
import { headOf, textOf } from './text.js'
import { sendToPeer } from './bot-network.js'
import { classify } from './msg-classes.js'
import { sameConversation } from './threads.js'

// For remote dispatch, control is local, an answer is refused, everything else is work.
// An answer is not new work: never dispatch it to another machine.
const ANSWER_ROLES = new Set(['reply', 'report'])

export function install(rt) {
  const { ctx, state } = rt
  const visibleTurns = new WeakMap()
  let disposed = false
  ctx.effect?.(() => () => { disposed = true }, 'ds-bot: visible delivery turns')

  const resolveAgent = async (sessionId) => {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw Object.assign(new Error(resolved.error?.message ?? 'Session unavailable'), { code: resolved.error?.code })
    rt.hideBotUnusedTools(resolved.agent)
    return resolved.agent
  }

  const headerFor = (role, fromName, roomName, audience, note = 'new message', deferred = false, { resumed = false, retried = false, resent = false, abandoned = false, asker } = {}) => {
    // What came back for work another Bot gave this one says where its answer goes.
    const goesOn = asker === undefined ? '' : ` · for the work ${asker} asked you for; your answer goes to ${asker} once everything you handed on is back`
    // A wait the user gave up reads as its own thing: the other Bot never answered.
    if (abandoned) return `[Waiting given up · ${fromName} did not hand back this work; go on with the work it was for${goesOn}]`
    if (deferred && role === 'reply') return `[Reply from ${fromName} · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role === 'report') return `[Group chat "${roomName}" · replies to your post · you read them during your last task; go on with the work they are for now${goesOn}]`
    if (deferred && role === 'task-report') return `[Background task report · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role !== 'room') return `[Message from ${fromName} · you read it during your last task; answer it now]`
    if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
    if (resumed && role === 'resume') return '[DeepSeek Harness restarted while you were working]'
    if (resumed && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted while you were working on it]`
    if (resent && role === 'reply') return `[Reply from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (resent && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (role === 'reply') return `[Reply from ${fromName}${goesOn}]`
    if (role === 'stopped') return `[Stopped by ${fromName}]`
    if (role === 'room') return `[Group chat "${roomName}" · ${note}]`
    if (role === 'report') return `[Group chat "${roomName}" · replies to your post${goesOn}]`
    if (role === 'kickoff') return '[Bot team setup]'
    if (role === 'continue') return '[Retry after a failed turn]'
    // The editor can be the user or a Bot (its own tool call, or a Main Bot's):
    // the header stays neutral about who changed the profile.
    if (role === 'update') return '[Your profile was updated — follow the latest version]'
    if (role === 'secret') return '[Secret card]'
    if (role === 'task') return `[Background task · ${note}]`
    if (role === 'task-followup') return `[Follow-up from your own chat · ${note}]`
    if (role === 'task-report') return `[Background task report · ${note}${goesOn}]`
    if (audience === 'user') return `[Message from ${fromName} · the user sees your reply here]`
    return `[Message from ${fromName}]`
  }

  // Roles recorded as team exchanges.
  const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped'])
  const TASK_ROLES = new Set(['task', 'task-followup', 'task-report'])

  // What two Bots say to each other is in the book of the pair (ledger.js), whole, written
  // before the message goes out. A message is shown once a record says it was delivered.
  const pairBook = (a, b) => `pair-${[String(a), String(b)].sort().join('-')}`
  // A pair's book starts from the exchanges a team kept in state.json before the ledger.
  rt.ledger.importer('pair-', book => state.exchanges
    .filter(entry => entry.from !== undefined && entry.to !== undefined && pairBook(entry.from, entry.to) === book)
    .map(entry => ({ ...entry, delivered: true })))
  // A message shows the text its delivery carried: the last record of its id written before
  // a delivery mark. A merged request whose replacement never went out keeps the text that did.
  function pairRecords(a, b) {
    const written = new Map()
    const shown = new Map()
    const marks = []
    for (const record of rt.ledger.records(pairBook(a, b))) {
      if (record.event === 'delivered') {
        if (written.has(record.id)) shown.set(record.id, written.get(record.id))
        marks.push(record)
      } else if (record.event === undefined) {
        written.set(record.id, record)
        if (record.delivered === true) shown.set(record.id, record)
      }
    }
    // A request whose answer came back was delivered, whether or not its own mark was kept: a
    // dispatch to a node leaves no Session on this machine to mark, so older books hold such
    // requests written but never marked.
    for (const record of [...shown.values()]) {
      if (record.role === 'reply' && typeof record.replyTo === 'string' && written.has(record.replyTo) && !shown.has(record.replyTo)) {
        shown.set(record.replyTo, written.get(record.replyTo))
      }
    }
    return { written, shown, marks }
  }
  // In the order they were sent; messages of the same millisecond keep the order they were written to the book.
  const pairMessages = (a, b) => {
    const { shown, written } = pairRecords(a, b)
    const at = new Map([...written.keys()].map((id, index) => [id, index]))
    return [...shown.values()].sort((x, y) => ((x.time ?? 0) - (y.time ?? 0)) || ((at.get(x.id) ?? 0) - (at.get(y.id) ?? 0)))
  }

  function deliveredReplyOf(fromId, toId, replyTo) {
    if (typeof fromId !== 'string' || fromId === '' || typeof replyTo !== 'string' || replyTo === '') return undefined
    if (typeof toId === 'string' && toId !== '') {
      if (rt.botOf(fromId) === undefined || rt.botOf(toId) === undefined) {
        return (state.exchanges ?? []).findLast(entry => entry.from === fromId && entry.to === toId && entry.role === 'reply' && entry.replyTo === replyTo)
      }
      return pairMessages(fromId, toId).findLast(record => record.from === fromId && record.to === toId && record.role === 'reply' && record.replyTo === replyTo)
    }
    if (rt.botOf(fromId) !== undefined) {
      for (const otherId of Object.keys(state.bots ?? {})) {
        if (otherId === fromId) continue
        const found = pairMessages(fromId, otherId).findLast(record => record.from === fromId && record.to === otherId && record.role === 'reply' && record.replyTo === replyTo)
        if (found !== undefined) return found
      }
    }
    return (state.exchanges ?? []).findLast(entry => entry.from === fromId && entry.role === 'reply' && entry.replyTo === replyTo)
  }

  const wasReplyDelivered = (fromId, toId, replyTo) => deliveredReplyOf(fromId, toId, replyTo) !== undefined

  function deliveredFailuresOf(fromId, toId, requestId, targetSessionId, parentWork) {
    if (typeof fromId !== 'string' || typeof toId !== 'string' || typeof requestId !== 'string' || requestId === '') return []
    if (rt.botOf(fromId) === undefined || rt.botOf(toId) === undefined) return []
    const wantedWork = typeof parentWork === 'string' && parentWork !== '' ? parentWork : undefined
    const { written, marks } = pairRecords(fromId, toId)
    const matches = []
    for (const mark of marks) {
      if (mark.failureRequestId !== requestId) continue
      const markWork = typeof mark.work === 'string' && mark.work !== '' ? mark.work : undefined
      if (markWork !== wantedWork) continue
      const message = written.get(mark.id)
      if (message?.from === fromId && message?.to === toId && sameConversation(state, toId, mark.sessionId, targetSessionId)) {
        matches.push({ id: mark.id, replyTo: message.replyTo, work: markWork, sessionId: mark.sessionId })
      }
    }
    return matches
  }

  const wasFailureRequestDelivered = (fromId, toId, requestId, targetSessionId, parentWork) =>
    deliveredFailuresOf(fromId, toId, requestId, targetSessionId, parentWork).length > 0

  // `sessionId` defaults to the recipient's own chat; group turns name its group Session.
  // `deferred`: a request the Bot already read mid-turn, handed back to answer in a
  // turn of its own; its exchange was recorded when it first arrived. `resumed` and
  // `retried` carry on a turn that a restart cut off or that wrote its tool call as
  // text (resume.js, turns.js); their exchange is recorded already too. `resent` is
  // a message a shutdown cancelled; its first send may not have been recorded.
  // `askedBy` is the member whose @mention called a group turn (groups.js).
  // `fromRoomId`: the group whose Session the sender wrote from; the reply goes back
  // to that Session (turns.js). `images` and `files` go along as image and file blocks,
  // which DSH projects for the recipient's model and tools. `length`: the whole message's
  // length when it went as a file (attachLong). `work`: the work (handoffs.js) a
  // result that came back goes on with. `merged`: a request that takes in an earlier
  // one its recipient had not read, under that one's exchange. `fromPart`: the Session
  // of the sending Bot, which a reply comes back to when that is a background part.
  async function deliver({ fromId, fromName: senderName, toId, sessionId, text, role, replyTo, roomId, audience, note, exchangeId = randomUUID(), steer = false, deferred = false, resumed = false, retried = false, resent = false, merged = false, abandoned = false, recordExchange = true, askedBy, fromRoomId, fromPart, images = [], files = [], length, work, taskId, imOrigin, failureRequestId, joinedTurn = false, joinedAsync = false, wait = false, stopped = false }) {
    const from = rt.botOf(fromId)
    const to = rt.botOf(toId)
    if (to === undefined) throw new Error(`Unknown Bot ${toId}`)
    // Joined members have no local model turn to settle the group's waiter.
    // Route their result through the same collection/late-reply path as local members.
    if (role === 'reply' && roomId && joinedShadow(from) && rt.roomOf?.(roomId)) {
      const waiter = rt.roomWaiters?.get(replyTo)
      if (waiter) waiter.resolve(text)
      else await rt.lateRoomReply?.(rt.roomOf(roomId).sessions?.[fromId], { role: 'room', roomId, exchangeId: replyTo }, text)
      return exchangeId
    }
    // On disk before it goes out: a message the book could not keep is not sent, so none is
    // delivered with no record of it. A resend keeps the record it has; only a merged request
    // replaces it with its added text. A joined turn leaves this machine before it reaches a
    // Session, so it is booked here too (below) — a restart after the send still owes it.
    const book = fromId !== undefined && from !== undefined && recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried ? pairBook(fromId, toId) : undefined
    const writeBook = async () => {
      if (book === undefined) return
      if (!merged && rt.ledger.records(book).some(record => record.event === undefined && record.id === exchangeId)) return
      rt.ledger.append(book, { id: exchangeId, from: fromId, to: toId, role, text, time: Date.now(), ...(length !== undefined ? { length, files } : {}), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}), ...(roomId ? { roomId } : {}) })
      await rt.ledger.written(book)
    }
    // A joined shadow is visible in the sidebar. Step 2 sends the turn to that
    // remote Bot. If the handler is not installed, keep the step-1 refusal and
    // do not fall through to a local session or handleRemoteTurn.
    const refused = refuseJoinedDispatch(to)
    if (refused) {
      if (!ANSWER_ROLES.has(role) && classify(role) !== 'control' && typeof rt.handleJoinedTurn === 'function') {
        await writeBook()
        // joinedAsync remains accepted for older callers; only wait:true opts out of deferral.
        const outcome = await rt.handleJoinedTurn({ fromId, toId, text, role, exchangeId, replyTo, work, ...(roomId ? { roomId, roomName: rt.roomOf?.(roomId)?.name } : {}), defer: wait !== true, ...(joinedAsync ? { joinedAsync: true } : {}), ...(stopped === true ? { stopped: true } : {}) })
        // The node has the request (an offline node or a refused dispatch answers `{ ok: false }` and
        // stays unmarked). The pair's view shows a message once it is marked: with no Session here to
        // take it up, this is the only place the request can be.
        if (book !== undefined && !(outcome !== null && typeof outcome === 'object' && outcome.ok === false)) {
          rt.ledger.append(book, { event: 'delivered', id: exchangeId, sessionId: sessionId ?? rt.chatOf(toId), time: Date.now(), ...(typeof work === 'string' && work !== '' ? { work } : {}) })
          await rt.ledger.written(book).catch(() => {})
        }
        return outcome
      }
      return refused
    }
    // A peer row is another machine's Bot: the hub carries the message, and it never
    // falls through to a local Session.
    if (to.origin === 'peer') return sendToPeer(rt, { fromId, toId, text, exchangeId })
    // Worker Bot routing: dispatch to the remote hub instead of a local Session turn.
    // Answers and lifecycle controls keep the local delivery path.
    if (to.type === 'remote-worker'
      && rt.handleRemoteTurn !== undefined
      && !ANSWER_ROLES.has(role) && classify(role) !== 'control') {
      return rt.handleRemoteTurn({ fromId, toId, text, role, exchangeId, replyTo, work })
    }
    const fromName = senderName ?? from?.name ?? 'You'
    const room = rt.roomOf(roomId)
    const asker = work === undefined ? undefined : rt.botOf(state.works?.[work]?.from)?.name
    // Session events reject `undefined` members, so optional fields are omitted instead.
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      senderName: fromName,
      ...(work ? { work } : {}),
      ...(taskId ? { taskId } : {}),
      ...(imOrigin ? { imOrigin } : {}),
      ...(fromId ? { senderSessionId: fromId } : {}),
      ...(fromPart ? { senderPart: fromPart } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(roomId ? { roomId } : {}),
      ...(audience === 'user' ? { audience } : {}),
      ...(deferred ? { deferred: true } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(retried ? { retried: true } : {}),
      ...(askedBy ? { askedBy } : {}),
      ...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
      ...(joinedTurn ? { joinedTurn: true } : {}),
      ...(abandoned ? { abandoned: true } : {}),
    }
    const targetSessionId = sessionId ?? rt.chatOf(toId)
    await writeBook()
    await rt.ensureCapabilities(targetSessionId)
    const agent = await resolveAgent(targetSessionId)
    const message = createUserMessage({
      content: [
        { type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried, resent, abandoned, asker })}\n${text}` },
        ...images.map(attachment => ({ type: 'image', attachment })),
        ...files.map(attachment => ({ type: 'file', attachment })),
      ],
      source,
    })
    // A message no Bot of the team sent keeps the record it had before the ledger.
    // Recorded once the message is in the Session: an earlier record would show
    // a failed delivery as delivered. The whole text is in its file, or in the
    // Session it goes to; exchangeText reads it back there. Resends keep any
    // existing record; only a merged request replaces it with its added text.
    const recordExchangeEntry = () => {
      if (!(recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried)) return
      const kept = headOf(text, TEXT_KEPT)
      const whole = length !== undefined ? { length, files } : kept.length < text.length ? { length: text.length, sessionId: targetSessionId } : {}
      const entry = { id: exchangeId, from: fromId, to: toId, text: kept, ...whole, role, time: Date.now(), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}) }
      const earlier = state.exchanges.findIndex(other => other.id === exchangeId)
      if (earlier === -1) state.exchanges.push(entry)
      else if (merged) state.exchanges[earlier] = entry
      void rt.save({ immediate: true }).catch(() => {})
    }
    // The book holds the text already; its mark says the message went out. A mark
    // that is lost only hides it from the dialog.
    const markDelivered = async () => {
      rt.ledger.append(book, {
        event: 'delivered',
        id: exchangeId,
        sessionId: targetSessionId,
        time: Date.now(),
        ...(typeof failureRequestId === 'string' && failureRequestId !== '' ? { failureRequestId } : {}),
        ...(typeof work === 'string' && work !== '' ? { work } : {}),
      })
      await rt.ledger.written(book).catch(() => {})
    }
    // A message between Bots is an event line ("Reply from X", opened for the whole text), as it is
    // between Bots on one machine: it keeps `kind: 'bot'`, so it is not drawn as something the
    // user typed. Other visible roles (group, report, task) are still written as user text.
    // Background task roles (DS Bot 0.3.10) are drawn by the task bar from their `kind: 'bot'` source, not as text the user typed.
    const visible = classify(role) === 'visible' && !EXCHANGE_ROLES.has(role) && !TASK_ROLES.has(role) && typeof agent.session?.append === 'function'
    if (visible) {
      // The chat projector renders user sources verbatim; relay sources show only an
      // exchange link. Keep the relay metadata on the wake that owns the next turn.
      agent.session.append('user/message', { ...message, source: { ...source, kind: 'user' } }, { surfaceOp: 'append' })
      await ctx.sessions.flush(agent.session)
    }
    const send = async () => {
      if (visible) {
        // The content is already in model history. An empty, deferred relay wakes the
        // agent without rendering or admitting that content a second time. Never wait
        // for the sender's active turn here: it may itself be awaiting this delivery.
        const wake = createUserMessage({ content: [], source: { ...source, deferred: true } })
        const previous = visibleTurns.get(agent) ?? Promise.resolve()
        const pending = previous.catch(() => {}).then(async () => {
          await agent.whenIdle()
          if (disposed) return
          agent.followup(wake)
          await agent.whenIdle()
          await ctx.sessions.flush(agent.session)
        })
        visibleTurns.set(agent, pending)
        void pending.catch(error => rt.warn('ds-bot: visible delivery turn failed: %s', error)).finally(() => {
          if (visibleTurns.get(agent) === pending) visibleTurns.delete(agent)
        })
      } else if (steer) agent.steer(message)
      else agent.followup(message)
      await ctx.sessions.flush(agent.session)
      if (book !== undefined) await markDelivered()
      else recordExchangeEntry()
    }
    // Steering bypasses the serial gate; visible input still waits for its own turn.
    if (steer) {
      await send()
      return exchangeId
    }
    // Visible input is already on the timeline; the serial gate orders its wake
    // behind the Bot's current turn (thread-model §4.5).
    const run = async () => {
      await send()
    }
    if (typeof rt.sendThreadTurn === 'function') {
      // The Session decides the Bot; a group's own Session has no Bot and stays ungated.
      const full = rt.bySessionIdFull?.(targetSessionId)
      const bot = full === undefined ? (targetSessionId === rt.chatOf(toId) ? to : undefined) : undefined
      const threadId = full?.threadId ?? (bot === undefined ? undefined : rt.mainThreadOf?.(bot.id)?.id)
      await rt.sendThreadTurn({ botId: full?.botId ?? bot?.id, threadId, sessionId: targetSessionId, kind: 'dispatch', preview: text, run })
    } else {
      await run()
    }
    return exchangeId
  }

  // A message between Bots, whole, from the Session it was delivered to: the message
  // there is its header line, then the text. `whole` is false when only the start could
  // be read (the Session is gone, or the message is past what the dialog shows).
  async function exchangeText(entry) {
    // A message of the ledger is whole there, or in its file when it went as one.
    if (entry.ledger === true && entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: headOf(entry.text, TEXT_SHOW_MAX), whole: false }
    if (entry.ledger === true) return { text: headOf(entry.text, TEXT_SHOW_MAX), whole: entry.text.length <= TEXT_SHOW_MAX }
    if (entry.length === undefined) return { text: entry.text, whole: true }
    if (entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: entry.text, whole: false }
    try {
      for await (const event of rt.eventsBackwards(entry.sessionId ?? rt.chatOf(entry.to), AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        if (event.type !== 'user/message' || event.data?.source?.exchangeId !== entry.id) continue
        const delivered = textOf(event.data.content)
        const text = delivered.slice(delivered.indexOf('\n') + 1)
        return { text: headOf(text, TEXT_SHOW_MAX), whole: text.length <= TEXT_SHOW_MAX }
      }
    } catch (error) {
      rt.warn('ds-bot: message %s not read back: %s', entry.id, error)
    }
    return { text: entry.text, whole: false }
  }

  // A message a Bot sends past MESSAGE_INLINE_MAX goes as a DSH file: it is stored once,
  // not in every Session it reaches, and the model reads it with its file tools when it
  // needs it. Undefined when this DSH cannot store files.
  async function attachLong(text, name) {
    if (text.length <= MESSAGE_INLINE_MAX) return { text, files: [] }
    try {
      const file = await ctx.get?.('attachments')?.saveFile({ data: new TextEncoder().encode(text), name })
      if (file === undefined) return undefined
      // The file stays verbatim, so a line past what the read tool shows needs another way.
      const wide = text.split('\n').some(line => line.length > READ_LINE_MAX)
      const note = `[A long message: ${text.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.${wide ? ` Some lines are longer than the ${READ_LINE_MAX} characters the read tool shows of a line; read those with a shell command.` : ''}]`
      return { text: `${note}\n${headOf(text, LONG_HEAD)}…`, files: [file], length: text.length }
    } catch (error) {
      rt.warn('ds-bot: long message not stored as a file: %s', error)
      return undefined
    }
  }

  // The text of a stored file, limited to what the dialogs show by default.
  async function fileText(file, maxLength = TEXT_SHOW_MAX) {
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined) return undefined
    const decoder = new TextDecoder()
    let text = ''
    try {
      for await (const chunk of attachments.readFileStream(file, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        text += decoder.decode(chunk, { stream: true })
        if (text.length > maxLength) return { text: headOf(text, maxLength), whole: false }
      }
    } catch (error) {
      rt.warn('ds-bot: file %s not read: %s', file?.name, error)
      return undefined
    }
    text += decoder.decode()
    return { text, whole: true }
  }


  // ── Worker Bot reply helpers (Subtask B) ──────────────────────────────────
  // deliverHandoff: formats a remote_handoff result as a Bot reply and delivers it.
  // deliverProgress: sends a live progress note as an intermediate message.

  rt.deliverHandoff = async function deliverHandoff(sessionId, { exchangeId, fromId, toId, work, handoffResult }) {
    try {
      let text
      if (handoffResult?.isError) {
        text = `[远程任务失败: ${handoffResult.value ?? 'unknown error'}]`
      } else {
        const h = handoffResult?.value
        const status = h?.status ?? '已结束'
        const exit = typeof h?.exit?.code === 'number' ? ` (exit ${h.exit.code})` : ''
        const summary = typeof h?.summary?.text === 'string' && h.summary.text.trim() !== ''
          ? `\n\n${h.summary.text.trim()}`
          : ''
        text = `[任务 ${status}${exit}]${summary}`
      }
      const long = await rt.attachLong?.(text, 'handoff.txt')
      void rt.deliver?.({
        fromId, toId,
        text: long?.text ?? text,
        ...(long?.files?.length ? { files: long.files, length: long.length } : {}),
        role: 'reply',
        replyTo: exchangeId,
        ...(work ? { work } : {}),
      }).catch(err => rt.warn('ds-bot: deliverHandoff failed: %s', err))
    } catch (err) {
      rt.warn('ds-bot: deliverHandoff error: %s', err)
    }
  }

  rt.deliverProgress = async function deliverProgress(sessionId, { fromId, toId, text }) {
    try {
      if (!text || !fromId || !toId) return
      void rt.deliver?.({
        fromId, toId,
        text: `[进度] ${text}`,
        role: 'reply',
      }).catch(err => rt.warn('ds-bot: deliverProgress failed: %s', err))
    } catch (err) {
      rt.warn('ds-bot: deliverProgress error: %s', err)
    }
  }
  const exchangesOf = (a, b) => pairMessages(a, b).map((record) => {
    const kept = headOf(record.text ?? '', TEXT_KEPT)
    const { delivered: _delivered, ...rest } = record
    return { ...rest, text: kept, ...(record.length === undefined && kept.length < (record.text ?? '').length ? { length: record.text.length } : {}) }
  })
  const exchangeOf = (id, a, b) => {
    const record = pairMessages(a, b).find(item => item.id === id)
    if (record === undefined) return undefined
    // Imported from before the ledger: as whole as it was kept then.
    if (record.sessionId !== undefined || (record.length !== undefined && !(record.files?.length > 0))) return record
    return { ...record, ledger: true }
  }

  Object.assign(rt, { resolveAgent, deliver, exchangeText, attachLong, fileText, exchangesOf, exchangeOf, deliveredReplyOf, wasReplyDelivered, deliveredFailuresOf, wasFailureRequestDelivered })
}
