// Models. Every Bot runs on one model of its own, fixed when it is created and changed
// only in its settings or by a Main Bot. The team's first Main Bot has none until the
// user picks one in its chat. The Session keeps the selection durably.
import { BlockAssembler, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { threadsOfBot } from './bot-store.js'
import { normalize, splitRef } from './text.js'
import { serviceOf } from './services.js'
import { ownChatSessions } from './threads.js'

// A failure the turn turns into a repair card keeps its code on the Error.
// A code this module raises for a Bot the main created. It blocks the Bot, so the repair
// card shows it, until a later apply finds the model and level again.
const MANAGED_FAILURES = new Set(['E_BOT_MODEL_UNAVAILABLE', 'E_BOT_MODEL_NO_KEY', 'E_BOT_EFFORT_UNAVAILABLE'])

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

const CATALOG_TTL_MS = 10_000
const ROUTE_WAIT_MS = 30_000
const ROOM_RETRY_MS = 1500
const ROOM_RETRY_MAX_MS = 5 * 60_000
// The DeepSeek account's sign-in grant (dsh-deepseek-account-platform).
const ACCOUNT_RECORD = 'deepseek-account-platform/default'
const TRANSIENT_LLM_CODES = new Set(['TRANSPORT', 'TIMEOUT'])

function retryPolicyOf(ctx, provider) {
  try {
    const resolved = serviceOf(ctx, 'llm')?.providerRetryPolicy?.(provider)
    if (resolved !== undefined) return resolved
  } catch {}
  return resolveRetryPolicy(undefined, 'ds-bot')
}

function retryDelayMs(policy, failure, retry, backoff, random) {
  const initialDelayMs = backoff?.initialDelayMs ?? policy.initialDelayMs
  const maxDelayMs = backoff?.maxDelayMs ?? policy.maxDelayMs
  const jitterRatio = backoff?.jitterRatio ?? policy.jitterRatio
  const providerAfter = failure?.providerRetryAfterMs
  if (providerAfter !== undefined && Number.isFinite(providerAfter) && providerAfter > 0) {
    if (providerAfter <= maxDelayMs) return providerAfter
    if (policy.mode === 'normal') return undefined
  }
  const exponential = Math.min(initialDelayMs * 2 ** Math.min(retry - 1, 1024), maxDelayMs)
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random()
  return Math.min(exponential * jitter, maxDelayMs)
}

function waitRetryDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortedAssembler(failure) {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'finish', reason: { kind: 'aborted', failure: failure ?? { code: 'ABORTED', message: 'aborted' } } })
  return assembler
}

function canRetryPolicy(policy, code, retry) {
  if (policy.mode === 'always') return true
  if (policy.mode !== 'normal') return false
  return Array.isArray(policy.retryableCodes) && policy.retryableCodes.includes(code) && retry <= policy.maxRetries
}

// Auxiliary calls (memory, learning, handoff, steward, OCR, side chats, browser_task)
// bypass the agent loop's `agent/request-error` hook, so `dsh-llm-retry` never sees
// their transport or stream-idle failures. Retry those transient codes on the same
// route with the provider's own retry policy, discarding partial chunks from failed attempts.
export async function assembleLlmStream(ctx, options, { signal, backoff, random = Math.random } = {}) {
  const service = serviceOf(ctx, 'llm')
  if (service === undefined) throw Object.assign(new Error('DS Bot is shutting down'), { code: 'ABORTED', failure: { code: 'ABORTED', message: 'DS Bot is shutting down' } })
  const fused = options.signal && signal ? AbortSignal.any([options.signal, signal]) : (options.signal ?? signal)
  const request = fused === options.signal ? options : { ...options, signal: fused }
  for (let retry = 1; ; retry += 1) {
    const assembler = new BlockAssembler()
    let thrown
    try {
      for await (const chunk of service.stream(request)) assembler.push(chunk)
    } catch (error) {
      thrown = error
    }
    if (thrown !== undefined) {
      const code = thrown?.failure?.code ?? thrown?.code
      const failure = thrown?.failure ?? { code, message: thrown?.message || String(thrown) }
      if (fused?.aborted || !TRANSIENT_LLM_CODES.has(code)) throw thrown
      const policy = retryPolicyOf(ctx, options.provider)
      if (!canRetryPolicy(policy, code, retry)) throw thrown
      const delayMs = retryDelayMs(policy, failure, retry, backoff, random)
      if (delayMs === undefined) throw thrown
      if (!await waitRetryDelay(delayMs, fused)) throw fused?.reason ?? thrown
      continue
    }
    const finish = assembler.finish
    if (finish.kind !== 'error' || fused?.aborted) return assembler
    const failure = finish.failure
    const code = failure?.code
    if (!TRANSIENT_LLM_CODES.has(code)) return assembler
    const policy = retryPolicyOf(ctx, options.provider)
    if (!canRetryPolicy(policy, code, retry)) return assembler
    const delayMs = retryDelayMs(policy, failure, retry, backoff, random)
    if (delayMs === undefined) return assembler
    if (!await waitRetryDelay(delayMs, fused)) return abortedAssembler({ code: 'ABORTED', message: failure?.message ?? 'aborted' })
  }
}

export function install(rt) {
  const { ctx, state } = rt

  let closing = false
  let modelsSynced = null
  // A model service that cannot be read means the host is going away.
  const llm = () => closing ? undefined : serviceOf(ctx, 'llm')
  let catalogCache = { at: 0, value: [] }
  // Routes DSH serves that cannot answer a request at all — a hosted loop engine
  // publishes one so its Sessions can be prompted. Once one refuses with
  // HOSTED_ENGINE_ROUTE it is remembered with the models its provider served then,
  // and nothing chooses it again until that provider serves different models.
  const refused = new Map()
  const answerable = entries => (refused.size === 0 ? entries : entries.filter(entry => !refused.has(entry.ref)))
  // The models a ref's provider serves, as a string to compare; undefined when it
  // cannot be listed, e.g. the provider is not registered.
  async function servedModels(ref) {
    const service = llm()
    if (service === undefined) return undefined
    try { return JSON.stringify(await service.listModels(splitRef(ref).provider)) } catch { return undefined }
  }
  // An adapter update may have replaced a refused placeholder with a real route, which
  // serves other models; the same models again are the same route, still refused.
  async function forgetChangedRefusals() {
    for (const [ref, served] of refused) {
      const now = await servedModels(ref)
      if (now !== undefined && now !== served) refused.delete(ref)
    }
  }
  // A model's thinking levels, resolved once and kept for a short while: they change
  // only with the provider, which also drops the catalog cache.
  const reasoningCache = new Map()
  const dropCatalog = () => { catalogCache = { at: 0, value: [] } }
  // A key set or a sign-in may be the user's fix for a Bot's failed turn (turns.js); a
  // key removed or a sign-out is not. A provider that registers or changes fixes
  // nothing by itself: providers register late at every start.
  ctx.on?.('llm/adapters-updated', () => { dropCatalog(); reasoningCache.clear(); return forgetChangedRefusals() })
  ctx.on?.('credentials/reference-updated', async (ref) => {
    dropCatalog()
    if (await inPlace(credentials => credentials.describe(ref))) rt.unblockBots?.({ ref })
  })
  // A sign-in writes the account's record. A sign-out removes it, and so does a token
  // the provider refused, while the turn that failed on it still runs. Other plugins'
  // records (an OAuth token refresh) say nothing about the account.
  ctx.on?.('credentials/record-updated', async (key) => {
    dropCatalog()
    if (String(key) !== ACCOUNT_RECORD) return
    if (await inPlace(credentials => credentials.describeRecord(key))) rt.unblockBots?.({ signedIn: true })
  })
  ctx.on?.('settings/document-updated', dropCatalog)

  // Whether a credential is there after a change. One that cannot be read counts as
  // there, so a fix is not missed.
  async function inPlace(describe) {
    const credentials = ctx.get?.('credentials')
    if (credentials === undefined) return true
    try { return (await describe(credentials))?.configured !== false } catch { return true }
  }

  // The thinking levels a model serves: `{efforts: [{id, name, description?}],
  // defaultEffort?}`, or undefined when it has none or the provider cannot say.
  async function reasoningOf(ref) {
    const cached = reasoningCache.get(ref)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
    const route = splitRef(ref)
    const service = llm()
    if (service === undefined) return undefined
    const info = route === undefined ? undefined : await service.resolveModelInfo?.(route.provider, route.model).catch(() => undefined)
    const value = info?.reasoning === undefined ? undefined : {
      efforts: (info.reasoning.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name ?? effort.id, ...(effort.description ? { description: effort.description } : {}) })),
      ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
    }
    reasoningCache.set(ref, { at: Date.now(), value })
    return value
  }

  // A provider's model list can change in DSH settings without any event, so a picker
  // that is about to be used asks for a `fresh` one. Entries for models a Bot uses
  // also carry their `reasoning`, so the picker can offer thinking levels.
  async function catalog({ fresh = false } = {}) {
    if (!fresh && Date.now() - catalogCache.at < CATALOG_TTL_MS && catalogCache.value.length > 0) return answerable(catalogCache.value)
    // The host is gone: the last answer stands, and no service is read again.
    const service = llm()
    if (service === undefined) return answerable(catalogCache.value)
    const entries = []
    for (const provider of service.listProviders()) {
      let models = []
      try { models = await service.listModels(provider.id) } catch { continue }
      for (const model of models) {
        entries.push({
          ref: `${provider.id}/${model.id}`,
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          id: model.id,
          name: model.name ?? model.id,
          ...(model.inputModalities ? { input: [...model.inputModalities] } : {}),
        })
      }
    }
    // The host was disposed while the models were listed: keep the answer, skip the
    // work that would read other services.
    if (llm() === undefined) return answerable(entries)
    // DSH serves a provider's models whether or not its key is set; without one, every
    // turn on them fails.
    const missing = await rt.missingKeys?.([...new Set(entries.map(entry => entry.provider))]) ?? new Set()
    for (const entry of entries) if (missing.has(entry.provider)) entry.needsKey = true
    // A key can arrive without an event (an environment variable at the next start), so
    // a provider listed with its key again lifts what its missing key blocked.
    rt.unblockBots?.({ keyed: new Set(entries.filter(entry => !entry.needsKey).map(entry => entry.provider)) })
    const used = new Set(Object.values(state.bots ?? {}).flatMap(bot => [bot.model, bot.appliedModel].filter(Boolean)))
    await Promise.all(entries.filter(entry => used.has(entry.ref)).map(async (entry) => {
      const reasoning = await reasoningOf(entry.ref)
      if (reasoning !== undefined) entry.reasoning = reasoning
    }))
    catalogCache = { at: Date.now(), value: entries }
    return answerable(entries)
  }

  // The profile default model of DSH as set, served or not, and able to answer.
  const defaultRef = () => {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return undefined
    const ref = `${selection.provider}/${selection.model}`
    return refused.has(ref) ? undefined : ref
  }
  // A model whose provider has no key fails every turn, so no Bot is given one unasked.
  const keyed = entries => entries.filter(entry => entry.needsKey !== true)
  const isLocal = ref => rt.isLocalAgentRef?.(ref) === true
  // Nor is a Bot given a local agent unasked: what it runs on changes only in its settings.
  const usableOf = entries => keyed(entries).filter(entry => !isLocal(entry.ref))
  // By the catalog as last listed, without waiting for a fresh one.
  const isUsable = ref => keyed(catalogCache.value).some(entry => entry.ref === ref)
  // The profile default model of DSH, when it is served and usable; else the first
  // usable model; else none.
  function pickDefault(entries) {
    const usable = usableOf(entries)
    const ref = defaultRef()
    // Neither a refused route nor one that fails for a missing key is picked.
    const list = answerable(usable)
    return list.find(entry => entry.ref === ref)?.ref ?? list[0]?.ref
  }
  const defaultModel = async () => pickDefault(await catalog())

  // The model a create that names none starts on: the team's pick while the catalog
  // still serves it, else the DSH default. A create fixes the ref then, so a later
  // change of either default leaves the Bot alone.
  const defaultBotModel = async () => {
    const entries = await catalog()
    const preferred = state.prefs.defaultBotModel
    return !isLocal(preferred) && entries.some(entry => entry.ref === preferred) ? preferred : pickDefault(entries)
  }

  // A local agent's model, by its full ref only, so a short name never moves a Bot onto
  // a CLI. Its CLI is asked only when DS Bot does not know the model yet.
  async function resolveLocalModel(ref) {
    const { provider, model } = splitRef(ref)
    const service = llm()
    if (service === undefined) throw new Error('DS Bot is shutting down')
    const known = await service.listModels(provider).catch(() => [])
    const served = known.some(entry => entry.id === model) ? known : await rt.localAgentModels(provider)
    if (served.some(entry => entry.id === model)) return ref
    throw new Error(`Model ${ref} is not available. Available models: ${served.map(entry => `${provider}/${entry.id}`).join(', ') || 'none'}`)
  }

  // A full `provider/model` ref, or a model id or name that only one provider serves.
  async function resolveModel(text) {
    const wanted = String(text ?? '').trim()
    if (isLocal(wanted)) return resolveLocalModel(wanted)
    const entries = (await catalog({ fresh: true })).filter(entry => !isLocal(entry.ref))
    const exact = entries.find(entry => entry.ref === wanted)
    if (exact) return exact.ref
    const key = normalize(wanted)
    const named = entries.filter(entry => normalize(entry.id) === key || normalize(entry.name) === key)
    if (named.length === 1) return named[0].ref
    const known = entries.map(entry => entry.ref).join(', ') || 'none'
    throw new Error(named.length > 1
      ? `Model ${wanted} is served by more than one provider; use one of ${named.map(entry => entry.ref).join(', ')}`
      : `Model ${wanted} is not available. Available models: ${known}`)
  }

  // A Bot with no model yet waits for the user to pick one and changes nothing. A
  // model that is no longer served falls back to the last one it ran on, then the
  // default; a fallback is never one that needs a key, nor a local agent. A local
  // agent that is gone stays the Bot's: its turn fails with the repair card.
  //
  // A Bot the main created (`managedBy: 'hub'`) does not fall back: the main is the only
  // authority over its model, so a model the node no longer serves, or one whose provider
  // lost its key, stops the turn with a code the repair card shows instead of running
  // something the user did not choose.
  async function desiredModel(bot) {
    if (!bot.model) return undefined
    // A joined shadow's model is the node's: the hub catalog does not serve it, and
    // treating that as unavailable stops the hub-side paths (the memory panel, a group
    // Session) before they can fall back to a model this machine does run.
    if (bot.origin === 'joined') return bot.model
    if (isLocal(bot.model)) return bot.model
    const entries = await catalog()
    const entry = entries.find(candidate => candidate.ref === bot.model)
    if (entry !== undefined) {
      if (bot.managedBy === 'hub' && entry.needsKey === true) {
        throw codedError('E_BOT_MODEL_NO_KEY', `The main's model ${bot.model} has no API key on this machine. Set the key on the main.`)
      }
      return bot.model
    }
    if (bot.managedBy === 'hub') {
      throw codedError('E_BOT_MODEL_UNAVAILABLE', `The main's model ${bot.model} is not available on this machine. Pick another model on the main, or have it change this Bot's model.`)
    }
    return usableOf(entries).some(candidate => candidate.ref === bot.appliedModel) ? bot.appliedModel : pickDefault(entries)
  }

  // The thinking level a Bot asked for, when the model it runs on serves it; else the
  // model's own default applies. A row with no level chosen stores null (bot-store and
  // joined-create both write null), so null is unset, not a level named "null". A level
  // the model does not have is ignored, never sent: an explicit effort a provider does
  // not know is a hard refusal there. A Bot the main created fails instead of quietly
  // running at the model's default level.
  async function desiredEffort(bot, ref) {
    if (bot.effort === undefined || bot.effort === null || ref === undefined) return undefined
    const reasoning = await reasoningOf(ref)
    if (reasoning?.efforts?.some(effort => effort.id === bot.effort) === true) return bot.effort
    if (bot.managedBy === 'hub') {
      throw codedError('E_BOT_EFFORT_UNAVAILABLE', `The thinking level ${bot.effort} is not available for ${ref} on this machine. Change it on the main.`)
    }
    return undefined
  }

  // A thinking level id, or a name only one level of the model has, like resolveModel.
  async function resolveEffort(ref, text) {
    const wanted = String(text ?? '').trim()
    if (wanted === '') return undefined
    const reasoning = await reasoningOf(ref)
    const efforts = reasoning?.efforts ?? []
    if (efforts.length === 0) throw new Error(`Model ${ref} has no thinking levels`)
    const key = normalize(wanted)
    const named = efforts.filter(effort => normalize(effort.id) === key || normalize(effort.name) === key)
    if (named.length === 1) return named[0].id
    throw new Error(`Thinking level ${wanted} is not available for ${ref}. Available: ${efforts.map(effort => effort.name).join(', ')}`)
  }

  // The profile default model's thinking level, when the model a Bot starts on
  // serves it. A level the model does not know is ignored, like an inherited
  // `bot.effort` — the model's own default applies instead.
  async function defaultEffort(ref) {
    const wanted = ctx.get?.('agentDefaultModel')?.currentSelection?.()?.reasoningEffort
    if (ref === undefined || wanted === undefined) return undefined
    return resolveEffort(ref, wanted).catch(() => undefined)
  }

  // DSH's selectModel also saves the selection as the profile default model, in the
  // background. A Bot's model is its own, so the user's default is written back after
  // it. Selections run one at a time and wait for the write-back: profile writes land in
  // submission order, so the next one reads the user's default, not a Bot's.
  let selecting = Promise.resolve()
  // Recheck group Sessions after every restart: Bot-level applied fields cannot
  // prove that an older group Session received the member's thinking level.
  const sessionSelections = new Map()
  const roomRetry = new Map()
  function selectSessionModel(sessionId, { provider, model, reasoningEffort }) {
    const run = selecting.then(async () => {
      if (llm() === undefined) return
      const defaults = ctx.get?.('agentDefaultModel')
      const before = defaults?.currentSelection?.()
      const result = await ctx.sessionController.selectModel({
        sessionId, provider, model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      const saved = result?.selected ?? { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
      if (llm() === undefined) return result
      if (before?.provider && before?.model && !sameSelection(before, saved)) {
        await defaults.saveSelection(before).catch(error => rt.warn('ds-bot: the default model was not restored: %s', error))
      }
      sessionSelections.set(sessionId, { provider, model, reasoningEffort })
      roomRetry.delete(sessionId)
      return result
    })
    selecting = run.catch(() => {})
    return run
  }

  const sameSelection = (a, b) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
  // A peer row is another machine's Bot: it has no Session here, and nothing may select a
  // model for it or write applied fields onto it.
  const isShadow = bot => bot?.origin === 'peer'

  // A Thread's Session is made without a model — the core's create carries none — so its
  // selection is made right after: the Thread's own model and level when the create named
  // them, else the Bot's current route, in the same shape Main uses.
  async function applyThreadModel(bot, sessionId, { model, effort } = {}) {
    if (isShadow(bot)) return undefined
    const ref = model ?? await desiredModel(bot)
    if (ref === undefined) return undefined
    const level = effort ?? (model === undefined ? await desiredEffort(bot, ref) : undefined)
    const route = { ...splitRef(ref), ...(level === undefined ? {} : { reasoningEffort: level }) }
    await selectSessionModel(sessionId, route)
    return ref
  }

  // `force` re-selects even when the record says it is applied: the composer's own
  // model picker can move the Session without telling this plugin.
  async function applyModel(bot, { force = false } = {}) {
    if (llm() === undefined || isShadow(bot)) return undefined
    let ref
    let effort
    try {
      ref = await desiredModel(bot)
      if (ref !== undefined) effort = await desiredEffort(bot, ref)
    } catch (error) {
      if (MANAGED_FAILURES.has(error?.code) === true && bot.blocked?.code !== error.code) {
        bot.blocked = { code: error.code, at: Date.now() }
        await rt.save().catch(() => {})
      }
      throw error
    }
    if (ref === undefined) return ref
    if (MANAGED_FAILURES.has(bot.blocked?.code) === true) {
      delete bot.blocked
      await rt.save()
    }
    if (llm() === undefined) return
    const ownChanged = force || bot.appliedModel !== ref || (bot.appliedEffort ?? undefined) !== effort
    const route = { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    // A Bot's model is the model of every part of its own chat, the background ones
    // included: a part left on the old route would keep answering with the old model
    // while the settings show the new one. A part that cannot take it fails the change.
    if (ownChanged) for (const sessionId of ownChatSessions({ ...bot, sessionId: rt.chatOf(bot.id) })) await selectSessionModel(sessionId, route)
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      const applied = sessionSelections.get(sessionId)
      if (!force && applied !== undefined && sameSelection(applied, route)) continue
      await selectSessionModel(sessionId, route)
        .catch(error => rt.warn('ds-bot: model for %s in a group not applied: %s', bot.name, error))
    }
    // P1 has no Thread-level model: a row whose `model` is null follows the Bot, and a new
    // Thread Session starts on the Bot's route rather than DSH's profile default.
    for (const thread of threadsOfBot(state, bot.id)) {
      if (thread.sessionId === null || thread.sessionId === undefined) continue
      if (thread.model !== null && thread.model !== undefined) continue
      const applied = sessionSelections.get(thread.sessionId)
      if (!force && applied !== undefined && sameSelection(applied, route)) continue
      await selectSessionModel(thread.sessionId, route)
        .catch(error => rt.warn('ds-bot: model for %s in a Thread not applied: %s', bot.name, error))
    }
    if (llm() === undefined || !ownChanged) return ref
    bot.appliedModel = ref
    if (effort === undefined) delete bot.appliedEffort
    else bot.appliedEffort = effort
    await rt.save()
    return ref
  }

  // A group's own Session never asks the model (groups.js synthesizes its relay step),
  // but DSH resolves the Session's selection before every step. One left on a model the
  // provider no longer serves fails with UNKNOWN_MODEL whatever its members run on, so
  // it is kept on the model new Bots start on. The record is by Session, so a part moved
  // on to a fresh Session is selected again.
  // Retry state stays in memory: a corrupt stored Session cannot be fixed by selecting
  // its model again, while a temporary failure waits independently of roster polling.
  let roomSessions = new Set()
  function currentRoomSessions() {
    const current = new Set(Object.values(state.rooms ?? {}).map(room => rt.sessionOfRoom(room)).filter(Boolean))
    for (const sessionId of new Set([...roomSessions, ...roomRetry.keys()])) {
      if (current.has(sessionId)) continue
      roomRetry.delete(sessionId)
      sessionSelections.delete(sessionId)
    }
    roomSessions = current
    return current
  }
  function roomFailure(error) {
    const seen = new Set()
    const messages = []
    for (let cause = error; cause !== undefined && cause !== null && !seen.has(cause); cause = cause.cause) {
      seen.add(cause)
      messages.push(`${cause.name ?? ''} ${cause.code ?? ''} ${cause.message ?? String(cause)}`)
    }
    const message = messages.join(': ')
    return {
      corrupt: /SessionFormatError|\bis corrupt\b|turn\/start does not open the expected turn/i.test(message),
      key: message,
      message: message.replace(/\s+/g, ' ').trim().slice(0, 300),
    }
  }
  async function selectRoomSession(sessionId) {
    if (!sessionId || (roomRetry.get(sessionId)?.nextAt ?? 0) > Date.now()) return
    const ref = await defaultBotModel()
    if (ref === undefined) return
    const retry = roomRetry.get(sessionId)
    if ((retry?.nextAt ?? 0) > Date.now()) return
    const route = splitRef(ref)
    const applied = sessionSelections.get(sessionId)
    if (applied !== undefined && sameSelection(applied, route)) return
    const attempt = { count: (retry?.count ?? 0) + 1, nextAt: Infinity }
    // Also reserves this id while selectSessionModel waits behind another selection.
    roomRetry.set(sessionId, attempt)
    await selectSessionModel(sessionId, route).then(
      () => { roomRetry.delete(sessionId) },
      (error) => {
        if (roomRetry.get(sessionId) !== attempt) return
        const failure = roomFailure(error)
        if (failure.corrupt) {
          rt.warn('ds-bot: model for the group Session %s not applied (attempt %d): stored session is corrupt; quarantined until deselected or reset. Move the group to a fresh Session.', sessionId, attempt.count)
          return
        }
        const delay = attempt.count === 1 ? 0 : Math.min(ROOM_RETRY_MS * 2 ** Math.min(attempt.count - 2, 8), ROOM_RETRY_MAX_MS)
        attempt.nextAt = Date.now() + delay
        attempt.error = failure.key
        if (retry === undefined || retry.error !== failure.key || delay === ROOM_RETRY_MAX_MS) {
          rt.warn('ds-bot: model for the group Session %s not applied (attempt %d); next retry in %ds: %s', sessionId, attempt.count, delay / 1000, failure.message)
        }
      },
    )
  }
  async function syncRoomSessions() {
    for (const sessionId of currentRoomSessions()) await selectRoomSession(sessionId)
  }

  // A provider may register after the plugin starts; a greeting waits for its Bot's
  // model instead of failing with "no adapter registered".
  async function waitForModel(bot, ms = ROUTE_WAIT_MS) {
    const deadline = Date.now() + ms
    for (;;) {
      if (!bot.model) return undefined
      catalogCache = { at: 0, value: [] }
      const served = new Set((await catalog()).map(entry => entry.ref))
      if (llm() === undefined) return undefined
      if (served.has(bot.model) || Date.now() >= deadline) return desiredModel(bot)
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(2000, deadline - Date.now()))
        const off = ctx.on?.('llm/adapters-updated', done)
        function done() { clearTimeout(timer); off?.(); resolve() }
      })
    }
  }

  // Sequential, and again whenever the answerable models change (a refused route is
  // not one of them): a provider that registers late still gets its Bots' models selected.
  let syncedKey
  const syncModels = () => {
    const current = currentRoomSessions()
    const key = answerable(catalogCache.value).map(entry => entry.ref).join(',')
    if (key !== syncedKey) { syncedKey = key; modelsSynced = modelsSynced?.then(syncAll, syncAll) ?? syncAll() }
    else if ([...current].some(sessionId => roomRetry.has(sessionId) ? roomRetry.get(sessionId).nextAt <= Date.now() : !sessionSelections.has(sessionId))) {
      modelsSynced = modelsSynced?.then(syncRooms, syncRooms) ?? syncRooms()
    }
    return modelsSynced
  }
  // Nothing awaits a sync (bootstrap starts one and drops the promise), so a failure
  // here, such as a catalog that cannot be read, is logged; the retry record stays.
  const syncRooms = () => syncRoomSessions().catch(error => rt.warn('ds-bot: models of the groups not applied: %s', error))
  async function syncAll() {
    for (const bot of Object.values(state.bots)) {
      // A peer or node row is a shadow of another machine's Bot: it has no Session here.
      if (isShadow(bot)) continue
      await applyModel(bot).catch(error => rt.warn('ds-bot: model for %s not applied: %s', bot.name, error))
    }
    await syncRooms()
  }

  // A route that refused a request for not being a model endpoint: it stays out of
  // the catalog from now on, the Bots pinned to it move to what they would be given
  // today, and each of them re-selects even when its record looks applied (`force`):
  // its Session may still be on the route, or on another Bot's route in a group.
  async function routeRefused(ref, bot) {
    const served = await servedModels(ref)
    const stuck = other => other?.managedBy === 'hub' && other.model === ref
    if (!refused.has(ref)) {
      refused.set(ref, served)
      rt.warn('ds-bot: %s is not a model endpoint, so it is not chosen again', ref)
      const entries = await catalog()
      const pinned = Object.values(state.bots).filter(other => !isShadow(other) && (other.model === ref || other.appliedModel === ref))
      for (const other of pinned) {
        // A Bot the main manages keeps the model the main chose: rewriting it here would be
        // the same silent local fallback §49 caught, and it would hide the main's own
        // refusal from the repair card. Its Session still re-selects below, so the turn
        // fails with the mapped code instead of running something else. A local Bot moves
        // to what it would be given today.
        if (other.model === ref && other.managedBy !== 'hub') other.model = pickDefault(entries)
        if (other.appliedModel === ref) delete other.appliedModel
      }
      await rt.save()
      // A managed Bot still on the refused model has nothing to select: it may only run
      // what the main chose, and that choice is what refused. It fails its turns until the
      // main changes the model, which is what its card says.
      for (const other of pinned) {
        if (other !== bot && !stuck(other)) await applyModel(other, { force: true }).catch(error => rt.warn('ds-bot: model for %s not applied: %s', other.name, error))
      }
    }
    if (bot !== undefined && !stuck(bot)) await applyModel(bot, { force: true })
  }

  const lifetime = new AbortController()
  ctx.effect?.(() => () => { closing = true; lifetime.abort() }, 'ds-bot: auxiliary llm retry')
  const assembleLlm = options => assembleLlmStream(ctx, options, { signal: lifetime.signal, backoff: rt.config?.llmRetryBackoff })

  /**
   * 收到 hub 下发的 MODEL_SYNC 帧后，更新 bot.model/effort 并触发 applyModel。
   * scope='default'：更新 agentDefaultModel（由 DSH ctx 持有），不改具体 bot。
   * scope='bot'：只改 sync.botId 指定的 bot。
   * scope='all'：改全部 managedBy='hub' 的 bot。
   * 返回实际生效的 botId 列表（scope='default' 时为 []）。
   *
   * 注意：为让测试和运行时都能拦截 applyModel，这里通过 rt.applyModel 调用而非
   * 直接用闭包内的 applyModel。rt.applyModel 在 Object.assign(rt, ...) 后才存在，
   * 因此本函数只能在 install 完成后调用（runtime 层面自然满足）。
   */
  async function applyModelSync(sync) {
    const { scope, modelRef, effort, botId: targetBotId } = sync
    const applied = []
    if (scope === 'default') {
      // 更新 DSH 的 agentDefaultModel：下次 Bot turn 自动用新 ref。
      try {
        const dm = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
        if (dm && typeof dm.select === 'function') {
          const parts = modelRef.split('/')
          const provider = parts.length >= 2 ? parts[0] : undefined
          const model = parts.length >= 2 ? parts.slice(1).join('/') : modelRef
          await dm.select({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) })
        }
      } catch (err) {
        rt.warn('ds-bot: applyModelSync default: %s', err)
      }
      return applied
    }
    const bots = Object.values(state.bots ?? {}).filter(bot => {
      if (isShadow(bot)) return false
      if (scope === 'bot') return bot.id === targetBotId
      // scope === 'all': only hub-managed bots
      return bot.managedBy === 'hub'
    })
    for (const bot of bots) {
      const prevModel = bot.model
      const prevEffort = bot.effort
      bot.model = modelRef
      if (effort !== undefined) bot.effort = effort
      else delete bot.effort
      try {
        // rt.applyModel is used here (not the closure) so tests can stub it.
        await rt.applyModel(bot, { force: true })
        applied.push(bot.id)
      } catch (err) {
        rt.warn('ds-bot: applyModelSync bot %s failed: %s', bot.name, err)
        // Roll back to previous values so the bot stays in a known state.
        bot.model = prevModel
        if (prevEffort !== undefined) bot.effort = prevEffort
        else delete bot.effort
      }
    }
    if (applied.length > 0) await rt.save().catch(() => {})
    return applied
  }

  Object.assign(rt, {
    // Work that starts while the host runs can ask whether the host is still there.
    hostClosing: () => llm() === undefined,
    catalog, cachedCatalog: () => answerable(catalogCache.value), cachedDefault: () => pickDefault(catalogCache.value),
    defaultRef, defaultModel, defaultBotModel, defaultEffort, isUsable, resolveModel, desiredModel, reasoningOf, resolveEffort, desiredEffort,
    selectSessionModel, applyModel, applyThreadModel, selectRoomSession, syncRoomSessions, waitForModel, syncModels, routeRefused, dropCatalog, assembleLlm,
    applyModelSync,
  })
}
