// Images and files in a message to a node Bot: the hub reads them from its attachment store, sends them ahead of the
// turn as bot/attach chunks, shows them in the user's message on the page; the node puts them back together, checks
// them, and hands the Bot's Session the same parts a local message would carry. What cannot go is refused, never
// dropped so that only the words travel.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  CHUNK_BYTES, MAX_ATTACHMENTS, MAX_TOTAL_BYTES, attachmentsOf, collectPrompt, createAttachReceiver, forgetAttachments, holdAttachments, releaseBytes, sendChunks, stashAttachments, userContentOf,
} from '../src/host/joined-attachments.js'
import { makeWorld, textRequest, types } from './joined-world.js'

const sha = buffer => createHash('sha256').update(buffer).digest('hex')
const png = Buffer.from('89504e470d0a1a0a', 'hex')
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)) }
// A Cordis context: a service is read with get(name); touching an uninjected one as a property throws, as in the host.
function strictCtx(services) {
  return new Proxy({ get: name => services[name] }, {
    get(target, key) {
      if (key in target || typeof key === 'symbol') return target[key]
      throw new Error(`cannot get property "${String(key)}" without inject (gateway/internal)`)
    },
  })
}
const rtWith = (store, caps) => {
  const services = { attachments: store, 'remote-agent:registry': { getNode: () => (caps === undefined ? undefined : { hello: { caps } }) } }
  const rt = { ctx: strictCtx(services), warn() {}, services }
  return rt
}
const bot = { id: 'joined:n1:b1', origin: 'joined', type: 'remote-worker', worker: { nodeId: 'n1', remoteBotId: 'b1', home: 'remote', online: true } }

const fakeStore = {
  readImage: async ref => ({ data: new Uint8Array(png), ref }),
  readFileStream: async function* () { yield new Uint8Array([1, 2, 3]); yield new Uint8Array([4, 5]) },
  admitPromptContent: async parts => parts.map(part => ({ type: 'image', attachment: { attachmentId: 'a-new', mediaType: part.mediaType, bytes: 8 } })),
  admitEncodedFile: async ({ data, name }) => ({ attachmentId: `f-${sha(Buffer.from(data, 'base64')).slice(0, 6)}`, name, bytes: Buffer.from(data, 'base64').length }),
}

test('NA-1: an encoded image, a stored image and a stored file are read, hashed and kept for the page', async () => {
  const rt = rtWith(fakeStore)
  const imageRef = { attachmentId: 'a1', mediaType: 'image/jpeg', bytes: 8, name: 'photo.jpg' }
  const fileRef = { attachmentId: 'f1', name: 'notes.txt', bytes: 5 }
  const { text, collected } = await collectPrompt(rt, bot, [
    { type: 'text', text: 'look at these' }, { type: 'text', text: 'please' },
    { type: 'image', mediaType: 'image/png', data: png.toString('base64') },
    { type: 'image', attachment: imageRef, encodedBytes: 8 },
    { type: 'file', attachment: fileRef },
  ])
  assert.equal(text, 'look at these\nplease')
  assert.deepEqual(collected.items.map(item => [item.index, item.kind, item.name, item.mediaType]), [
    [0, 'image', 'image-1.png', 'image/png'], [1, 'image', 'photo.jpg', 'image/jpeg'], [2, 'file', 'notes.txt', undefined],
  ])
  assert.equal(collected.items[0].sha256, sha(png))
  assert.deepEqual([...collected.items[2].data], [1, 2, 3, 4, 5], 'a file is read whole')
  assert.deepEqual(collected.blocks.map(block => block.type), ['image', 'image', 'file'])
  assert.equal(collected.blocks[1].attachment, imageRef, 'the page shows the hub\'s own reference')
  // the user's message on the page: the words, then what was attached
  stashAttachments('req-1', collected)
  assert.deepEqual(userContentOf('req-1', text).map(block => block.type), ['text', 'image', 'image', 'file'])
  assert.deepEqual(userContentOf('req-1', '').map(block => block.type), ['image', 'image', 'file'], 'no empty text block beside an attachment')
  assert.deepEqual(userContentOf('unknown', 'plain'), [{ type: 'text', text: 'plain' }])
  forgetAttachments('req-1')
  assert.equal(attachmentsOf('req-1'), undefined)
})

test('NA-2: a message with no attachment is just its words; what cannot go is refused with the reason', async () => {
  const rt = rtWith(fakeStore)
  assert.deepEqual(await collectPrompt(rt, bot, 'hello'), { text: 'hello' })
  const refused = async (content, rtx = rt) => collectPrompt(rtx, bot, content).then(() => assert.fail('expected a refusal'), error => error)
  assert.match((await refused([{ type: 'audio' }])).message, /只能收文字、图片和文件/)
  const old = await refused([{ type: 'image', mediaType: 'image/png', data: png.toString('base64') }], rtWith(fakeStore, ['bot-turn-mode/1']))
  assert.equal(old.code, 'session/joined-attachment-unsupported')
  assert.match(old.message, /AC 0\.4\.25/)
  const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ type: 'image', mediaType: 'image/png', data: png.toString('base64') }))
  assert.equal((await refused(many)).code, 'session/joined-attachment-too-large')
  const big = await refused([{ type: 'file', attachment: { attachmentId: 'f', name: 'big.bin', bytes: MAX_TOTAL_BYTES + 1 } }])
  assert.equal(big.code, 'session/joined-attachment-too-large')
  assert.match(big.message, /20 MB/)
  assert.match((await refused([{ type: 'image', url: 'x' }])).message, /图片没有内容/)
})

test('NA-3: sendChunks cuts an attachment into ordered chunks and names it in the manifest; a gone node fails the send', () => {
  const data = Buffer.alloc(CHUNK_BYTES * 2 + 10, 7)
  const sent = []
  const registry = { send: (nodeId, type, payload) => { sent.push({ nodeId, type, payload }); return true } }
  const manifest = sendChunks(registry, { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'x1', items: [{ index: 0, kind: 'file', name: 'a.bin', data, sha256: sha(data) }] })
  assert.deepEqual(sent.map(frame => [frame.type, frame.payload.index, frame.payload.chunk, frame.payload.chunks]), [['bot/attach', 0, 0, 3], ['bot/attach', 0, 1, 3], ['bot/attach', 0, 2, 3]])
  assert.ok(sent.every(frame => frame.payload.data.length <= 1_100_000), 'a chunk fits AC\'s limit')
  assert.deepEqual(manifest, [{ index: 0, name: 'a.bin', kind: 'file', bytes: data.length, sha256: sha(data), chunks: 3 }])
  assert.throws(() => sendChunks({ send: () => false }, { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'x', items: [{ index: 0, kind: 'file', name: 'a', data, sha256: 's' }] }), error => error.code === 'E_OFFLINE')
})

test('NA-4: the node puts the chunks back together, whatever their order, and refuses what is missing or damaged', async () => {
  const rt = rtWith(fakeStore)
  rt.attachWaitMs = 80
  const node = createAttachReceiver(rt)
  const data = Buffer.alloc(CHUNK_BYTES + 100, 9)
  const frames = []
  const manifest = sendChunks({ send: (_n, _t, payload) => { frames.push(payload); return true } }, { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'x1', items: [
    { index: 0, kind: 'file', name: 'doc.bin', data, sha256: sha(data) },
    { index: 1, kind: 'image', name: 'p.png', mediaType: 'image/png', data: png, sha256: sha(png) },
  ] })
  for (const frame of [...frames].reverse()) node.receive(frame)   // out of order
  const parts = await node.assembleParts({ exchangeId: 'x1', attachments: manifest })
  assert.equal(parts[0].type, 'file')
  assert.equal(parts[0].name, 'doc.bin')
  assert.equal(parts[0].data.equals(data), true, 'a file is still bytes: it is staged for the Session that takes the message later')
  assert.deepEqual(parts[1], { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'p.png' })
  assert.equal(node.size(), 0, 'what was used is let go')

  // a chunk that never comes
  for (const frame of frames.slice(0, 1)) node.receive({ ...frame, exchangeId: 'x2' })
  await assert.rejects(node.assembleParts({ exchangeId: 'x2', attachments: [{ ...manifest[0] }] }), error => error.code === 'bot-attach-incomplete')
  // bytes that do not match the manifest
  const wrong = { ...manifest[1], exchangeId: 'x3' }
  node.receive({ exchangeId: 'x3', index: 1, chunk: 0, chunks: 1, data: Buffer.from('not the image').toString('base64') })
  await assert.rejects(node.assembleParts({ exchangeId: 'x3', attachments: [wrong] }), error => error.code === 'bot-attach-invalid')
  // a duplicate chunk is ignored
  node.receive({ exchangeId: 'x4', index: 0, chunk: 0, chunks: 1, data: png.toString('base64') })
  node.receive({ exchangeId: 'x4', index: 0, chunk: 0, chunks: 1, data: png.toString('base64') })
  const [same] = await node.assembleParts({ exchangeId: 'x4', attachments: [{ index: 0, name: 'p.png', kind: 'image', mediaType: 'image/png', bytes: png.length, sha256: sha(png), chunks: 1 }] })
  assert.equal(same.type, 'image')
})

test('NA-5: chunks that arrive while the turn already waits for them are picked up', async () => {
  const rt = rtWith(fakeStore)
  const node = createAttachReceiver(rt)
  const entry = { index: 0, name: 'p.png', kind: 'image', mediaType: 'image/png', bytes: png.length, sha256: sha(png), chunks: 1 }
  const waiting = node.assembleParts({ exchangeId: 'late', attachments: [entry] })
  setTimeout(() => node.receive({ exchangeId: 'late', index: 0, chunk: 0, chunks: 1, data: png.toString('base64') }), 30)
  assert.equal((await waiting)[0].type, 'image')
})

test('NA-6: a page prompt with an image reaches the node as chunks then a turn, and the page shows the image', async () => {
  const w = makeWorld({ tracker: true })
  const original = w.rt.ctx.get
  w.rt.ctx.get = name => (name === 'attachments' ? fakeStore : original(name))
  const data = png.toString('base64')
  await w.prompt({ ...textRequest('what is this?', 'req-img'), content: [{ type: 'text', text: 'what is this?' }, { type: 'image', mediaType: 'image/png', data }] })
  await settle()
  assert.deepEqual(w.frames.map(frame => frame.type), ['bot/attach', 'bot/turn'], 'the chunks go first, the turn that names them after')
  const turn = w.frames[1].payload
  assert.equal(turn.text, 'what is this?')
  assert.deepEqual(turn.attachments.map(item => [item.index, item.kind, item.bytes, item.sha256, item.chunks]), [[0, 'image', png.length, sha(png), 1]])
  assert.equal(w.frames[0].payload.exchangeId, turn.exchangeId)
  // the user's message on the page carries the image
  const log = w.sessionOf(w.bot.sessionId).log
  const message = log.find(event => event.type === 'user/message')
  assert.deepEqual(message.data.content.map(block => block.type), ['text', 'image'])
  // and the node can put it back together from exactly what the hub sent
  const node = createAttachReceiver(rtWith(fakeStore))
  node.receive(w.frames[0].payload)
  const [part] = await node.assembleParts(turn)
  assert.deepEqual([part.type, part.mediaType, part.data], ['image', 'image/png', data])
  assert.ok(types(w.sessionOf(w.bot.sessionId)).includes('user/message'))
})

test('NA-7: an image alone, without words, is a message', async () => {
  const w = makeWorld({ tracker: true })
  const original = w.rt.ctx.get
  w.rt.ctx.get = name => (name === 'attachments' ? fakeStore : original(name))
  await w.prompt({ ...textRequest('', 'req-only'), content: [{ type: 'image', mediaType: 'image/png', data: png.toString('base64') }] })
  await settle()
  assert.equal(w.frames[1].payload.text, '')
  assert.equal(w.frames[1].payload.attachments.length, 1)
})

// ── the node's turn receiver hands the Bot's Session the text and the attachments ──────────────

import { createBotTurnReceiver } from '../src/host/joined-turn.js'

function nodeSide({ assemble }) {
  const sent = []
  const rt = {
    state: { bots: { k1: { id: 'k1', name: 'Worker' } } },
    botOf: id => rt.state.bots[id], chatOf: id => `chat-${id}`,
    sendUser: async (request) => { sent.push(request); queueMicrotask(() => rt.settleJoinedTurn(request.requestId, 'seen it')) },
    assembleAttachmentParts: assemble, save: async () => {}, warn() {},
  }
  return { rt, sent, accept: createBotTurnReceiver(rt, { timeoutMs: 5000 }) }
}

test('NA-8: the Bot\'s own message carries the words and the parts that were put back together', async () => {
  const parts = [{ type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'p.png' }]
  const w = nodeSide({ assemble: async () => parts })
  const result = await w.accept({ remoteBotId: 'k1', exchangeId: 'ex-1', text: 'what is this', attachments: [{ index: 0 }] }, {})
  assert.equal(result.ok, true)
  assert.deepEqual(w.sent[0].content, [{ type: 'text', text: 'what is this' }, ...parts])
  // no words, only an image: no empty text block
  const alone = nodeSide({ assemble: async () => parts })
  await alone.accept({ remoteBotId: 'k1', exchangeId: 'ex-2', text: '', attachments: [{ index: 0 }] }, {})
  assert.deepEqual(alone.sent[0].content, parts)
})

test('NA-9: attachments that did not arrive whole refuse the turn with the reason; nothing is sent to the Bot', async () => {
  for (const code of ['bot-attach-incomplete', 'bot-attach-invalid']) {
    const w = nodeSide({ assemble: async () => { throw Object.assign(new Error('x'), { code }) } })
    const result = await w.accept({ remoteBotId: 'k1', exchangeId: 'ex-3', text: 'look', attachments: [{ index: 0 }] }, {})
    assert.equal(result.ok, false)
    assert.equal(result.error, code)
    assert.equal(w.sent.length, 0)
  }
  // a turn without attachments is untouched
  const plain = nodeSide({ assemble: async () => assert.fail('not called') })
  assert.equal((await plain.accept({ remoteBotId: 'k1', exchangeId: 'ex-4', text: 'hi' }, {})).ok, true)
  assert.deepEqual(plain.sent[0].content, [{ type: 'text', text: 'hi' }])
})

// ── the page uploads first and sends receipts: { type: 'file', receiptId } for images and files alike ──────────

function uploadsWith(staged) {
  const agent = { session: { id: 'mirror-1' } }
  const bound = []
  const services = {
    agents: new Map([['mirror-1', agent]]),
    fileUploads: {
      resolve: (who, receiptId) => (who === agent ? staged[receiptId] : undefined),
      bindPrompt: (who, ids, requestId) => { bound.push({ who, ids, requestId }); return { commit() { bound.at(-1).committed = true } } },
    },
  }
  return { agent, bound, services }
}

test('NA-10: the page\'s upload receipts are swapped for the staged image and file before they are collected', async () => {
  const imageRef = { attachmentId: 'a1', mediaType: 'image/png', bytes: 8, name: 'shot.png' }
  const fileRef = { attachmentId: 'f1', name: 'notes.txt', bytes: 5 }
  const up = uploadsWith({ r1: { type: 'image', attachment: imageRef, encodedBytes: 8 }, r2: { type: 'file', attachment: fileRef } })
  const rt = rtWith(fakeStore)
  Object.assign(rt.services, up.services)
  const { text, collected } = await collectPrompt(rt, bot, [
    { type: 'text', text: 'both of these' }, { type: 'file', receiptId: 'r1' }, { type: 'file', receiptId: 'r2' },
  ], { sessionId: 'mirror-1', requestId: 'req-r' })
  assert.equal(text, 'both of these')
  assert.deepEqual(collected.items.map(item => [item.kind, item.name]), [['image', 'shot.png'], ['file', 'notes.txt']])
  assert.deepEqual(collected.blocks.map(block => block.type), ['image', 'file'])
  assert.deepEqual(up.bound, [{ who: up.agent, ids: ['r1', 'r2'], requestId: 'req-r', committed: true }], 'the receipts are bound to the message, so they are retired when it lands')
})

test('NA-11: a receipt that is no longer staged, or whose Session has no agent, is refused; nothing is skipped', async () => {
  const up = uploadsWith({})
  const rt = rtWith(fakeStore)
  Object.assign(rt.services, up.services)
  const refused = (content, ids, rtx = rt) => collectPrompt(rtx, bot, content, ids).then(() => assert.fail('expected a refusal'), error => error)
  const stale = await refused([{ type: 'file', receiptId: 'gone' }], { sessionId: 'mirror-1', requestId: 'r' })
  assert.equal(stale.code, 'session/joined-attachment-unsupported')
  assert.match(stale.message, /已经失效/)
  const rt2 = rtWith(fakeStore)
  Object.assign(rt2.services, { agents: new Map(), fileUploads: up.services.fileUploads })
  assert.match((await refused([{ type: 'file', receiptId: 'r1' }], { sessionId: 'other', requestId: 'r' }, rt2)).message, /已经失效/)
})

test('NA-12: a page prompt of receipts reaches the node as chunks and a turn, with the image on the page', async () => {
  const w = makeWorld({ tracker: true })
  const imageRef = { attachmentId: 'a1', mediaType: 'image/png', bytes: 8, name: 'shot.png' }
  const up = uploadsWith({ r1: { type: 'image', attachment: imageRef, encodedBytes: 8 } })
  // The host's context: these services are read with get(name); as a property they throw (the real failure was
  // `cannot get property "fileUploads" without inject`).
  const original = w.rt.ctx
  const services = { attachments: fakeStore, ...up.services }
  w.rt.ctx = new Proxy(original, {
    get(target, key) {
      if (key === 'get') return name => (name in services ? services[name] : target.get(name))
      if (['fileUploads', 'agents', 'attachments'].includes(key)) throw new Error(`cannot get property "${key}" without inject (gateway/internal)`)
      return Reflect.get(target, key)
    },
  })
  up.agent.session.id = 'mirror-1'
  await w.prompt({ requestId: 'req-rcpt', sessionId: 'mirror-1', mode: 'queue', content: [{ type: 'text', text: 'what is this?' }, { type: 'file', receiptId: 'r1' }] })
  await settle()
  assert.deepEqual(w.frames.map(frame => frame.type), ['bot/attach', 'bot/turn'])
  assert.equal(w.frames[1].payload.attachments[0].name, 'shot.png')
  const message = w.sessionOf(w.bot.sessionId).log.find(event => event.type === 'user/message')
  assert.deepEqual(message.data.content.map(block => block.type), ['text', 'image'])
  assert.equal(up.bound[0].requestId, 'req-rcpt')
})

test('NA-13: a name AC would refuse is never sent; an unreadable attachment is a refusal that names it, not an internal error', async () => {
  const blank = await collectPrompt(rtWith(fakeStore), bot, [{ type: 'file', attachment: { attachmentId: 'f1', name: '   ', bytes: 5 } }, { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: '  ' }])
  // AC's cleanBotAttachments rejects the whole turn for a name that is empty once trimmed
  assert.deepEqual(blank.collected.items.map(item => item.name), ['file', 'image-1'], 'a blank name is replaced')
  const broken = { ...fakeStore, readImage: async () => { throw Object.assign(new Error('object missing'), { code: 'ATTACHMENT_NOT_FOUND' }) }, readFileStream: async function* () { throw new Error('read timed out') } }
  const refusal = content => collectPrompt(rtWith(broken), bot, content).then(() => assert.fail('expected a refusal'), error => error)
  const image = await refusal([{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 8, name: 'photo.png' } }])
  assert.equal(image.code, 'session/joined-attachment-unsupported')
  assert.match(image.message, /photo\.png.*object missing/)
  const file = await refusal([{ type: 'file', attachment: { attachmentId: 'f1', name: 'big.zip', bytes: 8 } }])
  assert.equal(file.code, 'session/joined-attachment-unsupported')
  assert.match(file.message, /big\.zip.*read timed out/)
})

test('NA-14: attachments of a message that waits behind a turn are kept past the ordinary lifetime, then let go when it is over', () => {
  const realNow = Date.now
  try {
    stashAttachments('waiting', { items: [{ data: Buffer.from('x') }], blocks: [{ type: 'file' }] })
    stashAttachments('stray', { items: [], blocks: [] })
    holdAttachments('waiting')
    Date.now = () => realNow() + 45 * 60_000
    stashAttachments('later', { items: [], blocks: [] })   // a new stash sweeps
    assert.equal(attachmentsOf('stray'), undefined, 'nothing waits for a stray entry: the clock lets it go')
    assert.equal(attachmentsOf('waiting').items.length, 1, 'a message still waiting for its turn keeps its bytes')
    releaseBytes('waiting')
    assert.deepEqual(attachmentsOf('waiting').items, [])
    Date.now = () => realNow() + 13 * 3600_000
    stashAttachments('much-later', { items: [], blocks: [] })
    assert.equal(attachmentsOf('waiting'), undefined)
  } finally { Date.now = realNow; for (const id of ['waiting', 'stray', 'later', 'much-later']) forgetAttachments(id) }
})

test('NA-15: chunks that came ahead of a refused turn are let go, not kept for it', async () => {
  const rt = rtWith(fakeStore)
  rt.attachWaitMs = 30
  const node = createAttachReceiver(rt)
  node.receive({ exchangeId: 'refused', index: 0, chunk: 0, chunks: 1, data: png.toString('base64') })
  node.receive({ exchangeId: 'refused', index: 1, chunk: 0, chunks: 1, data: png.toString('base64') })
  assert.equal(node.size(), 2)
  node.discard({ exchangeId: 'refused', attachments: [{ index: 0 }, { index: 1 }] })
  assert.equal(node.size(), 0)
  // an assembly that fails on its first entry lets go of the others too
  node.receive({ exchangeId: 'half', index: 1, chunk: 0, chunks: 1, data: png.toString('base64') })
  await assert.rejects(node.assembleParts({ exchangeId: 'half', attachments: [{ index: 0, name: 'a', kind: 'file', bytes: 1, sha256: sha(Buffer.from('a')), chunks: 1 }, { index: 1, name: 'b', kind: 'image', bytes: png.length, sha256: sha(png), chunks: 1 }] }), error => error.code === 'bot-attach-incomplete')
  assert.equal(node.size(), 0)
})

test('NA-16: a node whose ds-bot cannot take attachments, or whose AC refuses the manifest, is explained on the page', async () => {
  const { failureText } = await import('../src/host/executor.js')
  const words = code => failureText(Object.assign(new Error(code), { code: 'E_REJECTED' }))
  assert.match(words('bot-attach-no-receiver'), /ds-bot 版本太旧.*fork\.103/)
  assert.match(words('bot-turn-attachments-invalid'), /附件清单没有通过/)
})

// ── a file dragged in from the disk is a path mention (`@/abs/path`) in the words, not an upload ──────────────

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { mentionedFiles } from '../src/host/joined-attachments.js'

function files(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mention-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const plain = join(dir, '1100个tm.txt')
  const spaced = join(dir, '公司 审批 规范.txt')
  writeFileSync(plain, 'line one\nline two\n')
  writeFileSync(spaced, 'approval rules')
  mkdirSync(join(dir, 'folder'))
  return { dir, plain, spaced, folder: join(dir, 'folder') }
}

test('NA-17: path mentions that name a file on this machine are found; everything else is left alone', async (t) => {
  const f = files(t)
  const text = `@${f.plain} 读取这个文档，再看 @"${f.spaced}" 和 @${f.folder}/ 还有 @${join(f.dir, 'missing.txt')} 以及 me@example.com @relative/path.txt`
  const found = await mentionedFiles(text)
  assert.deepEqual(found.map(item => item.name), ['1100个tm.txt', '公司 审批 规范.txt'])
  assert.equal(text.slice(found[0].start, found[0].end), `@${f.plain}`)
  assert.equal(text.slice(found[1].start, found[1].end), `@"${f.spaced}"`)
  // punctuation right behind a path is not part of it
  assert.deepEqual((await mentionedFiles(`看一下@${f.plain}，谢谢`)).length, 0, 'an @ inside a word is not a mention')
  assert.deepEqual((await mentionedFiles(`看一下 @${f.plain}，谢谢`)).map(item => item.name), ['1100个tm.txt'])
  assert.deepEqual((await mentionedFiles(`(see @${f.plain}).`)).map(item => item.name), ['1100个tm.txt'], 'closing punctuation is not part of the path')
  assert.deepEqual((await mentionedFiles(`(@${f.plain})`)).length, 0, 'a mention must start a word')
})

test('NA-18: a message from the page that mentions a file sends its bytes and the file\'s name; the page keeps the mention', async (t) => {
  const f = files(t)
  const rt = rtWith(fakeStore)
  const words = `@${f.plain} 读取这个文档`
  const { text, collected } = await collectPrompt(rt, bot, [{ type: 'text', text: words }], { requestId: 'req-m', mentions: true })
  assert.equal(text, words, 'the page shows what the user wrote')
  assert.equal(collected.sendText, '1100个tm.txt 读取这个文档', 'the node reads the name, not a path on this machine')
  assert.deepEqual(collected.items.map(item => [item.kind, item.name, item.data.toString()]), [['file', '1100个tm.txt', 'line one\nline two\n']])
  assert.deepEqual(collected.blocks, [], 'no second chip on the page')
  // without the flag (IM, a phone, another Bot) a mention is only words: nothing on this machine is read
  assert.deepEqual(await collectPrompt(rt, bot, [{ type: 'text', text: words }], { requestId: 'req-n' }), { text: words })
  // a message that names no file here is untouched
  assert.deepEqual(await collectPrompt(rt, bot, [{ type: 'text', text: '@/root/work/x.txt hi' }], { requestId: 'req-o', mentions: true }), { text: '@/root/work/x.txt hi' })
})

test('NA-19: a mentioned file that is too big, empty, protected or on a node too old is refused with the reason', async (t) => {
  const f = files(t)
  const rt = rtWith(fakeStore)
  const refused = (words, rtx = rt) => collectPrompt(rtx, bot, [{ type: 'text', text: words }], { requestId: 'r', mentions: true }).then(() => assert.fail('expected a refusal'), error => error)
  writeFileSync(join(f.dir, 'empty.txt'), '')
  assert.match((await refused(`@${join(f.dir, 'empty.txt')} x`)).message, /是空的/)
  const big = join(f.dir, 'big.bin')
  writeFileSync(big, Buffer.alloc(MAX_TOTAL_BYTES + 1))
  const tooBig = await refused(`@${big} x`)
  assert.equal(tooBig.code, 'session/joined-attachment-too-large')
  assert.match(tooBig.message, /big\.bin 太大/)
  const secret = join(homedir(), '.ssh', 'id_ed25519')
  if ((await mentionedFiles(`@${secret}`)).length > 0) assert.match((await refused(`@${secret} x`)).message, /受保护/)
  const old = await refused(`@${f.plain} x`, rtWith(fakeStore, ['bot-turn-mode/1']))
  assert.match(old.message, /AC 0\.4\.25/)
  const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => { const file = join(f.dir, `m${i}.txt`); writeFileSync(file, 'x'); return `@${file}` }).join(' ')
  assert.equal((await refused(many)).code, 'session/joined-attachment-too-large')
})

test('NA-20: the whole page path: a mentioned document reaches the node as chunks and the words name the file', async (t) => {
  const f = files(t)
  const w = makeWorld({ tracker: true })
  const original = w.rt.ctx.get
  w.rt.ctx.get = name => (name === 'attachments' ? fakeStore : original(name))
  const words = `@${f.plain} 读取这个文档`
  await w.prompt({ ...textRequest(words, 'req-doc'), content: [{ type: 'text', text: words }] })
  await settle()
  assert.deepEqual(w.frames.map(frame => frame.type), ['bot/attach', 'bot/turn'])
  const turn = w.frames[1].payload
  assert.equal(turn.text, '1100个tm.txt 读取这个文档')
  assert.deepEqual(turn.attachments.map(item => [item.name, item.kind, item.bytes]), [['1100个tm.txt', 'file', 18]])
  const message = w.sessionOf(w.bot.sessionId).log.find(event => event.type === 'user/message')
  assert.deepEqual(message.data.content, [{ type: 'text', text: words }], 'the page shows the user\'s own words')
  // the node puts the file back together
  const node = createAttachReceiver(rtWith(fakeStore))
  node.receive(w.frames[0].payload)
  const [part] = await node.assembleParts(turn)
  assert.deepEqual([part.type, part.name, part.data.toString()], ['file', '1100个tm.txt', 'line one\nline two\n'])
})
