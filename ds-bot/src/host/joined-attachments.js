// joined-attachments.js — images and files in a message to a node Bot.
//
// A node Bot used to take text only: an image or a file in the message was refused. Now they travel to the node
// the way the words do, and the user's own message on the hub's page shows them.
//
//   hub:   the page's prompt (or the phone / IM send) carries image / file parts. `collectPrompt` reads their bytes
//          out of the hub's attachment store, keeps them by the message's requestId, and `sendChunks` puts them on
//          the link as `bot/attach` frames (≤ 768 KiB raw each, in order) just before the `bot/turn` that names
//          them in its `attachments` manifest. The same parts, as the hub's own references, are what the mirror
//          Session's user message shows (`userContentOf`).
//   node:  `bot/attach` chunks are kept here until the turn arrives; `assembleParts` waits for all of them, checks
//          size and sha256 and returns the parts (an image as the encoded image the core's prompt takes, a file as
//          bytes still to be staged). `rt.sendUser` then uploads each file through the node's own `fileUploads`
//          for the Session the message really goes to and puts its receipt in the prompt (`{ type: 'file', receiptId }`
//          — the core's prompt refuses a file part that names a stored file instead: FILE_NOT_STAGED). Anything
//          missing or wrong is an error the hub shows ("bot-attach-incomplete"), never a message that goes on
//          without its attachment.
//
// Needs AC 0.4.25 on the node (`bot-attach/1`, node-compat.js); an older node is refused with that reason.
import { createHash } from 'node:crypto'
import { nodeCan, refusalFor } from './node-compat.js'

export const MAX_ATTACHMENTS = 8
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024
export const CHUNK_BYTES = 768 * 1024
const TTL_MS = 30 * 60_000
const ASSEMBLE_WAIT_MS = 20_000
const NODE_MEMORY_MAX = 64 * 1024 * 1024

const sha256Of = buffer => createHash('sha256').update(buffer).digest('hex')
const refuse = (code, message) => Object.assign(new Error(message), { code })
const mb = bytes => `${Math.round(bytes / 1024 / 1024)} MB`
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

// ── what a message carries, by requestId ────────────────────────────────────────────────────────

const stash = new Map()
// A message that waits behind a running turn keeps its attachments for as long as it waits (a long queue outlives
// the ordinary lifetime); anything else is let go after TTL_MS if nothing released it.
const QUEUED_TTL_MS = 12 * 3600_000
function sweep() {
  const now = Date.now()
  for (const [id, entry] of stash) if (now - entry.at > (entry.queued === true ? QUEUED_TTL_MS : TTL_MS)) stash.delete(id)
}

/** Remember a collected prompt's attachments until its turn is sent (items) and its page message is written (blocks). */
export function stashAttachments(requestId, collected) {
  if (typeof requestId !== 'string' || requestId === '' || collected === undefined) return
  sweep()
  stash.set(requestId, { ...collected, at: Date.now() })
}
export const attachmentsOf = requestId => stash.get(requestId)
/** The message waits for a turn in front of it: its attachments stay until it is sent. */
export function holdAttachments(requestId) {
  const entry = stash.get(requestId)
  if (entry !== undefined) entry.queued = true
}
/** Is a message with this requestId already carrying attachments here (a repeated send of the same message)? */
export const hasAttachments = requestId => stash.has(requestId)
/** The heavy bytes are not needed once the frames are out; the page blocks stay for the message on the page. */
export function releaseBytes(requestId) {
  const entry = stash.get(requestId)
  if (entry !== undefined) { entry.items = []; entry.queued = false }
}
export const forgetAttachments = requestId => { stash.delete(requestId) }

/** The user's message as the page shows it: the words, then each image / file the user attached. */
export function userContentOf(requestId, text) {
  const blocks = stash.get(requestId)?.blocks ?? []
  const content = []
  if (String(text ?? '') !== '' || blocks.length === 0) content.push({ type: 'text', text: String(text ?? '') })
  return [...content, ...blocks]
}

// ── the hub: read what the user attached ────────────────────────────────────────────────────────

// A Cordis service is read with ctx.get(name): a plain `ctx.fileUploads` throws "cannot get property … without inject"
// for a service this plugin does not declare (the page's uploads live in the core's own `fileUploads`). `get` is
// strict: it answers undefined while the service's own plugin is not running (a reload), which callers must tell
// apart from "the receipt is gone".
function serviceOf(rt, name) {
  try { return rt.ctx?.get?.(name) } catch { return undefined }
}
const storeOf = rt => serviceOf(rt, 'attachments')

async function readFileBytes(store, ref) {
  const chunks = []
  for await (const chunk of store.readFileStream(ref, AbortSignal.timeout(60_000))) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

// A bare error out of the store (a missing object, a read that timed out) would reach the page as the gateway's
// "internal error"; say which attachment could not be read instead.
const unreadable = (what, error) => refuse('session/joined-attachment-unsupported', `读取附件 ${what} 失败：${String(error?.message ?? error).slice(0, 120)}`)

/**
 * The page does not put an image or a file in the prompt itself: it uploads it first and the prompt carries a
 * receipt (`{ type: 'file', receiptId }`, for images too). The core swaps each receipt for the staged part before
 * its own admission; a node Bot's prompt is taken over here before that happens, so the receipts are swapped here
 * the same way (the staging belongs to the Session's agent, `fileUploads.resolve`). A receipt that is no longer
 * staged is refused, never skipped.
 */
async function resolveReceipts(rt, parts, sessionId) {
  const receipts = parts.filter(part => part?.type === 'file' && part.attachment === undefined && part.receiptId !== undefined)
  if (receipts.length === 0) return { parts, receiptIds: [] }
  const uploads = serviceOf(rt, 'fileUploads')
  if (typeof uploads?.resolve !== 'function') throw refuse('session/joined-attachment-unsupported', '主控的文件上传服务暂时不可用，请稍后重新发送')
  let agent = typeof sessionId === 'string' && sessionId !== '' ? serviceOf(rt, 'agents')?.get?.(sessionId) : undefined
  if (agent === undefined && typeof rt.resolveAgent === 'function' && typeof sessionId === 'string' && sessionId !== '') {
    try { agent = await rt.resolveAgent(sessionId) } catch { agent = undefined }
  }
  const gone = () => refuse('session/joined-attachment-unsupported', '上传的附件已经失效，请重新添加后再发送')
  if (agent === undefined) throw gone()
  const receiptIds = []
  const resolved = parts.map((part) => {
    if (!receipts.includes(part)) return part
    const staged = uploads.resolve(agent, part.receiptId)
    if (staged === undefined || staged === null || (staged.type !== 'file' && staged.type !== 'image')) throw gone()
    receiptIds.push(part.receiptId)
    return staged
  })
  return { parts: resolved, receiptIds, agent, uploads }
}

/**
 * The words of a prompt's parts and, for a node Bot, its attachments. Refuses (never drops) what cannot go:
 * a node too old for them, too many, too big, a part of a kind that is neither text, image nor file.
 * Returns { text, collected } — `collected` is undefined when the message has no attachment.
 */
export async function collectPrompt(rt, bot, content, { sessionId, requestId } = {}) {
  const given = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  const { parts, receiptIds, agent, uploads } = await resolveReceipts(rt, given, sessionId)
  const text = parts.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n')
  const attached = parts.filter(part => part?.type !== 'text')
  if (attached.length === 0) return { text }
  if (attached.some(part => part?.type !== 'image' && part?.type !== 'file')) {
    throw refuse('session/joined-attachment-unsupported', '节点 Bot 只能收文字、图片和文件')
  }
  if (!nodeCan(rt, bot, 'attach')) throw refuse('session/joined-attachment-unsupported', refusalFor('attach'))
  if (attached.length > MAX_ATTACHMENTS) throw refuse('session/joined-attachment-too-large', `一条消息最多带 ${MAX_ATTACHMENTS} 个附件`)
  const store = storeOf(rt)
  const items = []
  const blocks = []
  let total = 0
  let imageNumber = 0
  for (const part of attached) {
    const declared = part.attachment?.bytes
    if (Number.isFinite(declared) && total + declared > MAX_TOTAL_BYTES) throw refuse('session/joined-attachment-too-large', `附件加起来不能超过 ${mb(MAX_TOTAL_BYTES)}`)
    let data
    let name
    let mediaType
    let block
    if (part.type === 'image') {
      imageNumber += 1
      if (part.attachment !== undefined) {
        if (typeof store?.readImage !== 'function') throw refuse('session/joined-attachment-unsupported', '这台主控读不了已上传的图片')
        let read
        try { read = await store.readImage(part.attachment, AbortSignal.timeout(60_000)) } catch (error) { throw unreadable(part.attachment.name ?? `图片 ${imageNumber}`, error) }
        data = Buffer.from(read.data)
        mediaType = read.ref?.mediaType ?? part.attachment.mediaType
        name = read.ref?.name ?? part.attachment.name
        block = { type: 'image', attachment: part.attachment }
      } else if (typeof part.data === 'string') {
        data = Buffer.from(part.data, 'base64')
        mediaType = part.mediaType
        name = part.name
        try {
          const admitted = await store?.admitPromptContent?.([{ type: 'image', mediaType, data: part.data, ...(name ? { name } : {}) }])
          block = admitted?.[0]
        } catch { block = undefined }
        block ??= { type: 'text', text: `[图片${name ? `：${name}` : ''}]` }
      } else throw refuse('session/joined-attachment-unsupported', '图片没有内容')
      name = name || `image-${imageNumber}.${EXT[mediaType] ?? 'png'}`
    } else {
      if (part.attachment === undefined || typeof store?.readFileStream !== 'function') throw refuse('session/joined-attachment-unsupported', '这台主控读不了已上传的文件')
      try { data = await readFileBytes(store, part.attachment) } catch (error) { throw unreadable(part.attachment.name ?? 'file', error) }
      name = part.attachment.name || 'file'
      block = { type: 'file', attachment: part.attachment }
    }
    if (data.length === 0) throw refuse('session/joined-attachment-unsupported', `${name} 是空的`)
    total += data.length
    if (total > MAX_TOTAL_BYTES) throw refuse('session/joined-attachment-too-large', `附件加起来不能超过 ${mb(MAX_TOTAL_BYTES)}`)
    items.push({ index: items.length, kind: part.type, name: String(name).trim().slice(0, 200) || (part.type === 'image' ? `image-${imageNumber}` : 'file'), ...(mediaType ? { mediaType: String(mediaType).slice(0, 64) } : {}), data, sha256: sha256Of(data) })
    blocks.push(block)
  }
  // The receipts are spent: bound to this message, they are retired when its user message lands on the page
  // (the core's own observer), instead of staying staged for the life of the Session.
  if (receiptIds.length > 0 && requestId !== undefined) {
    try { uploads.bindPrompt?.(agent, receiptIds, requestId)?.commit?.() } catch { /* a receipt that cannot be bound is only retired later */ }
  }
  return { text, collected: { items, blocks } }
}

/**
 * Put a message's attachments on the link as bot/attach chunks and return the manifest the bot/turn carries.
 * Throws when a frame cannot be sent (the node is gone): the message is then not sent either.
 */
export function sendChunks(registry, { nodeId, remoteBotId, exchangeId, items }) {
  const manifest = []
  for (const item of items) {
    const chunks = Math.max(1, Math.ceil(item.data.length / CHUNK_BYTES))
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const slice = item.data.subarray(chunk * CHUNK_BYTES, (chunk + 1) * CHUNK_BYTES)
      const sent = registry.send(nodeId, 'bot/attach', { nodeId, remoteBotId, exchangeId, index: item.index, chunk, chunks, data: slice.toString('base64') })
      if (sent !== true) throw Object.assign(new Error('node offline or send failed'), { code: 'E_OFFLINE' })
    }
    manifest.push({ index: item.index, name: item.name, kind: item.kind, ...(item.mediaType ? { mediaType: item.mediaType } : {}), bytes: item.data.length, sha256: item.sha256, chunks })
  }
  return manifest
}

// ── the node: hand the core's prompt a receipt for each file ───────────────────────────────────

/** A file whose bytes are still to be staged: `{ type: 'file', name, data }`, with neither a receipt nor a stored reference. */
export const isPendingFile = part => part?.type === 'file' && part.receiptId === undefined && part.attachment === undefined && part.data !== undefined

/**
 * The core's prompt takes a file as the receipt of an upload made for the Session that gets the message
 * (`{ type: 'file', receiptId }`, resolved against that Session's Agent); a part naming a stored file instead is
 * refused as FILE_NOT_STAGED. So each pending file is uploaded through this node's own `fileUploads` for exactly
 * `sessionId`, right before the prompt — the caller names the Session the message really goes to (a busy Bot's
 * message moves to a fresh chat first). Throws { code: 'bot-attach-unsupported' } when the node cannot stage it.
 */
export async function stageFileParts(rt, sessionId, parts) {
  if (!Array.isArray(parts) || !parts.some(isPendingFile)) return parts
  const uploads = serviceOf(rt, 'fileUploads')
  if (typeof uploads?.uploadStream !== 'function') throw refuse('bot-attach-unsupported', '这台节点存不了文件')
  const staged = []
  for (const part of parts) {
    if (!isPendingFile(part)) { staged.push(part); continue }
    let value
    try {
      value = await uploads.uploadStream({ sessionId, data: (async function* () { yield part.data })(), name: part.name })
    } catch (error) {
      throw refuse('bot-attach-unsupported', `节点存不下文件 ${part.name}：${String(error?.message ?? error).slice(0, 120)}`)
    }
    staged.push({ type: 'file', receiptId: value.receiptId })
  }
  return staged
}

// ── the node: keep the chunks until the turn that uses them arrives ─────────────────────────────

/** The receiver AC hands each bot/attach chunk to. Synchronous: the turn that needs it follows on the same link. */
export function createAttachReceiver(rt) {
  const books = new Map()   // `${exchangeId}:${index}` → { chunks: Map<number, Buffer>, total, bytes, at, waiters: Set<fn> }
  let held = 0
  const drop = (key) => {
    const book = books.get(key)
    if (book === undefined) return
    held -= book.bytes
    books.delete(key)
  }
  const sweepBooks = () => {
    const now = Date.now()
    for (const [key, book] of books) if (now - book.at > TTL_MS) drop(key)
  }
  const receive = ({ exchangeId, index, chunk, chunks, data } = {}) => {
    sweepBooks()
    const key = `${exchangeId}:${index}`
    let book = books.get(key)
    if (book === undefined) {
      book = { chunks: new Map(), total: chunks, bytes: 0, at: Date.now(), waiters: new Set() }
      books.set(key, book)
    }
    if (book.chunks.has(chunk)) return
    const buffer = Buffer.from(String(data ?? ''), 'base64')
    if (held + buffer.length > NODE_MEMORY_MAX) { rt.warn?.('ds-bot: bot/attach chunk dropped, too much waiting for a turn'); return }
    book.chunks.set(chunk, buffer)
    book.bytes += buffer.length
    held += buffer.length
    for (const wake of [...book.waiters]) wake()
  }
  const complete = book => book !== undefined && book.chunks.size === book.total

  /** One attachment's bytes, once all its chunks are here (waits a little: the frames are in flight). */
  async function bytesOf(exchangeId, entry) {
    const key = `${exchangeId}:${entry.index}`
    const deadline = Date.now() + (rt.attachWaitMs ?? ASSEMBLE_WAIT_MS)
    for (;;) {
      const book = books.get(key)
      if (complete(book) && book.total === entry.chunks) {
        const data = Buffer.concat([...Array(book.total).keys()].map(number => book.chunks.get(number)))
        drop(key)
        return data
      }
      const left = deadline - Date.now()
      if (left <= 0) throw refuse('bot-attach-incomplete', `附件 ${entry.name} 没有完整送到节点`)
      await new Promise((resolve) => {
        const wake = () => { clearTimeout(timer); book?.waiters.delete(wake); resolve() }
        const timer = setTimeout(wake, Math.min(left, 250))
        timer.unref?.()
        if (book !== undefined) book.waiters.add(wake)
      })
    }
  }

  /**
   * The parts of a turn's attachments, in order, once every byte is here and checked. An image is the encoded image
   * the core's prompt takes; a file is `{ type: 'file', name, data }` — bytes that `stageFileParts` still has to upload
   * for the Session that will take the message. Throws { code: 'bot-attach-incomplete' | 'bot-attach-invalid' }.
   */
  async function assembleParts(turn) {
    const entries = Array.isArray(turn?.attachments) ? turn.attachments : []
    const parts = []
    try {
      for (const entry of entries) {
        const data = await bytesOf(turn.exchangeId, entry)
        if (data.length !== entry.bytes || sha256Of(data) !== entry.sha256) throw refuse('bot-attach-invalid', `附件 ${entry.name} 在传输中损坏了`)
        if (entry.kind === 'image') parts.push({ type: 'image', mediaType: entry.mediaType ?? 'image/png', data: data.toString('base64'), name: entry.name })
        else parts.push({ type: 'file', name: entry.name, data })
      }
    } catch (error) {
      discard(turn)   // the turn is refused: what else of it arrived is not kept waiting for a turn that will not use it
      throw error
    }
    return parts
  }

  /** A turn that will not be assembled (refused before it): let go of the chunks that came ahead of it. */
  function discard(turn) {
    for (const entry of Array.isArray(turn?.attachments) ? turn.attachments : []) drop(`${turn.exchangeId}:${entry?.index}`)
  }

  return { receive, assembleParts, discard, size: () => books.size }
}

export function install(rt) {
  const receiver = createAttachReceiver(rt)
  rt.assembleAttachmentParts = receiver.assembleParts
  rt.discardAttachmentParts = receiver.discard
  // AC's node plugin finds the receiver under this name (an older AC never sends bot/attach).
  try { rt.ctx?.provide?.('remote-agent:bot-attach', receiver.receive) } catch { /* registry plugin may be absent */ }
}
