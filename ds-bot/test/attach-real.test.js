// An image or a file from the hub's page to a node Bot, on the REAL core packages instead of fakes: the real
// LocalAttachmentStore, the real FileUploads service (receipts, bindPrompt, retirePrompt through the Session's
// events), the real Agents / Session store, and the core's own prompt admission (SessionCommandController.prompt).
// Three real-host bugs got past fake contexts here before (fork.103 refused uploads, fork.104 `ctx.fileUploads` threw
// "cannot get property without inject", and the node handing the core `{ type: 'file', attachment }`, which its
// prompt refuses as FILE_NOT_STAGED). Needs @deepseek-ai/dsh-agent-loop-testkit and sharp in dev/harness.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { attachmentsOf, collectPrompt, createAttachReceiver, sendChunks, stageFileParts, stashAttachments } from '../src/host/joined-attachments.js'
import { allocateTurn, mirrorTurnStart, uploadSessionOf } from '../src/host/mirror.js'
import { createBotTurnReceiver } from '../src/host/joined-turn.js'
import { failureText } from '../src/host/executor.js'
import { createSendUser } from '../src/host/channel.js'
import { makeWorld, textRequest } from './joined-world.js'
import { makePng, realUploadWorld } from './real-uploads.js'

const sha = buffer => createHash('sha256').update(buffer).digest('hex')
const stream = buffer => (async function* () { yield new Uint8Array(buffer) })()
const bot = { id: 'joined:n1:b1', worker: { nodeId: 'n1', remoteBotId: 'b1', home: 'remote' } }
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  return check()
}
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)) }

/** What the page's composer does: upload through the core's own service, keep the receipts. */
async function pageUploads(w, sessionId, { png = makePng(64, 48), bigPng, file = Buffer.from('hello file bytes\n'.repeat(100)) } = {}) {
  const image = await w.uploads.uploadImageStream({ sessionId, data: stream(png), mediaType: 'image/png', name: 'shot.png' })
  const big = bigPng === undefined ? undefined : await w.uploads.uploadImageStream({ sessionId, data: stream(bigPng), mediaType: 'image/png', name: 'big.png' })
  const stored = await w.uploads.uploadStream({ sessionId, data: stream(file), name: 'notes.txt' })
  return { png, file, image, big, stored }
}
/** The user message the core took for a prompt: in the Agent's inbox, or (an idle Agent claims it at once) in the log. */
const userMessageOf = (agent, requestId) => {
  const inbox = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(item => item.source?.rpcId === requestId)
  if (inbox !== undefined) return inbox
  for (const event of agent.session.log) {
    if (event.type === 'user/message' && event.data.source?.rpcId === requestId) return event.data
    if (event.type === 'agent/inbox/spliced') { const found = (event.data.inserted ?? []).find(item => item.source?.rpcId === requestId); if (found !== undefined) return found }
  }
  return undefined
}
/** The node's own sendUser (channel.js) over the core's real prompt; `moveTo` makes a busy Bot's message move to a fresh chat first. */
function nodeSendUser(real, { moveTo } = {}) {
  const bot = { id: 'rb1', name: 'Bot', type: 'local', sessionId: 'node-chat' }
  const rt = {
    botOf: id => (id === 'rb1' ? bot : undefined), bySessionId: sid => (sid === 'node-chat' ? bot : undefined),
    pastOwners: new Map(), roomOf: () => undefined, chatOf: () => 'node-chat', chatOwners: new Map([['node-chat', 'rb1']]), groupOwners: new Set(),
    ensureCapabilities: async () => {}, ctx: real.ctx, warn() {},
    shouldMoveForeground: () => moveTo !== undefined, handoffForeground: async () => moveTo,
    markThreadPromptAdmitted() {},
  }
  return createSendUser(rt, { ctx: { sessionController: { prompt: request => real.prompt(request) } }, ownThreadTarget: () => 'node-chat' })
}
const receipt = id => ({ type: 'file', receiptId: id })   // the page sends images and files alike as { type: 'file', receiptId }

describe('attach-real: the hub reads what the page uploaded', () => {
  it('AR-1: receipts of an image, a re-encoded big image and a file resolve against the mirror Session\'s own Agent; bytes, hash and media type are what is sent; the user message retires the receipts', async () => {
    const w = await realUploadWorld()
    const agent = await w.agent('mirror-1')
    const up = await pageUploads(w, 'mirror-1', { bigPng: makePng(3000, 2500) })
    assert.equal(up.big.image.mediaType, 'image/jpeg', 'premise: the core re-encodes a big PNG (so the manifest cannot copy the upload\'s declared type)')
    const rt = { ctx: w.ctx, warn() {}, resolveAgent: async id => w.ctx.agents.get(id) }

    const { text, collected } = await collectPrompt(rt, bot, [receipt(up.image.receiptId), receipt(up.big.receiptId), receipt(up.stored.receiptId), { type: 'text', text: 'look' }], { sessionId: 'mirror-1', requestId: 'req-1' })
    assert.equal(text, 'look')
    const [small, big, file] = collected.items
    assert.equal(small.data.equals(up.png), true, 'a PNG the core kept as it is comes back byte for byte')
    assert.equal(file.data.equals(up.file), true)
    assert.equal(sha(small.data), small.sha256)
    assert.deepEqual([small.mediaType, big.mediaType, file.mediaType], ['image/png', 'image/jpeg', undefined])
    assert.equal(big.data.length, up.big.image.bytes, 'the bytes sent are the normalized image the page shows')
    assert.deepEqual(collected.blocks.map(block => block.type), ['image', 'image', 'file'])

    // the receipts stay staged until the user's message is on the Session, then the core's own observer retires them
    const staged = () => [up.image.receiptId, up.big.receiptId, up.stored.receiptId].map(id => w.uploads.resolve(agent, id) !== undefined)
    assert.deepEqual(staged(), [true, true, true])
    stashAttachments('req-1', collected)
    mirrorTurnStart(agent.session, { turn: allocateTurn(agent.session), userText: text, rpcId: 'req-1' })
    assert.deepEqual(staged(), [false, false, false], 'the mirror user/message (source.rpcId) retires every receipt that was bound to the request')
    const written = agent.session.log.findLast(event => event.type === 'user/message').data.content
    assert.deepEqual(written.map(block => block.type), ['text', 'image', 'image', 'file'], 'the real Session accepts the page blocks')
    await w.dispose()
  })

  it('AR-2: a receipt staged for another Session, or already spent, is refused as gone; a missing upload service is said as such', async () => {
    const w = await realUploadWorld()
    await w.agent('mirror-1')
    const other = await w.agent('other-1')
    const mine = await pageUploads(w, 'mirror-1')
    const theirs = await pageUploads(w, 'other-1')
    const rt = { ctx: w.ctx, warn() {}, resolveAgent: async id => w.ctx.agents.get(id) }
    await assert.rejects(collectPrompt(rt, bot, [receipt(theirs.stored.receiptId)], { sessionId: 'mirror-1', requestId: 'r' }), error => error.code === 'session/joined-attachment-unsupported' && /已经失效/.test(error.message))
    await assert.rejects(collectPrompt(rt, bot, [receipt('no-such-receipt')], { sessionId: 'mirror-1', requestId: 'r' }), error => /已经失效/.test(error.message))
    // a refusal leaves the receipts staged: the user can add one more thing and send again
    assert.notEqual(w.uploads.resolve(await w.agent('mirror-1'), mine.stored.receiptId), undefined)
    assert.notEqual(w.uploads.resolve(other, theirs.stored.receiptId), undefined)
    const noService = { ctx: { get: name => (name === 'fileUploads' ? undefined : w.ctx.get(name)) }, warn() {} }
    await assert.rejects(collectPrompt(noService, bot, [receipt(mine.stored.receiptId)], { sessionId: 'mirror-1', requestId: 'r' }), error => /上传服务暂时不可用/.test(error.message) && !/已经失效/.test(error.message))
    await w.dispose()
  })

  it('AR-3: the hub reads the core\'s services with ctx.get — a plugin without `inject` cannot read them as properties (fork.104), and ctx.get is strict about a service that is not running', async () => {
    const w = await realUploadWorld()
    const agent = await w.agent('mirror-1')
    const up = await pageUploads(w, 'mirror-1')
    let pluginCtx
    const fiber = w.ctx.plugin({ name: 'ds-bot-like', apply(ctx) { pluginCtx = ctx } })
    await settle()
    assert.throws(() => pluginCtx.fileUploads, /without inject/, 'premise: this is the error fork.104 shipped')
    assert.equal(typeof pluginCtx.get('fileUploads').resolve, 'function')
    const rt = { ctx: pluginCtx, warn() {} }
    const { collected } = await collectPrompt(rt, bot, [receipt(up.stored.receiptId), receipt(up.image.receiptId)], { sessionId: 'mirror-1', requestId: 'req-2' })
    assert.equal(collected.items.length, 2)
    assert.notEqual(agent, undefined)
    fiber.dispose()
    await w.dispose()
    assert.equal(pluginCtx.get('fileUploads'), undefined, 'after the core is gone ctx.get answers undefined, it does not throw')
  })
})

describe('attach-real: the node hands the Bot\'s Session what the core\'s prompt takes', () => {
  async function toNode(w, sessionId, parts, exchangeId = 'ex-1') {
    const rt = { ctx: w.ctx, warn() {}, attachWaitMs: 200 }
    const node = createAttachReceiver(rt)
    const wire = []
    const hub = { ctx: w.ctx, warn() {}, resolveAgent: async id => w.ctx.agents.get(id) }
    const { collected } = await collectPrompt(hub, bot, parts, { sessionId, requestId: 'hub-req' })
    const manifest = sendChunks({ send: (_n, _t, payload) => { wire.push(payload); return true } }, { nodeId: 'n1', remoteBotId: 'b1', exchangeId, items: collected.items })
    for (const frame of wire) node.receive(frame)
    return { node, turn: { exchangeId, remoteBotId: 'b1', attachments: manifest }, collected }
  }

  it('AR-4: an image and a file are admitted by the core\'s prompt (the file as a receipt of an upload for the Session), and the Bot gets the same bytes', async () => {
    const w = await realUploadWorld()
    await w.agent('mirror-1')
    const nodeAgent = await w.agent('node-chat')
    const up = await pageUploads(w, 'mirror-1', { bigPng: makePng(3000, 2500) })
    const { node, turn } = await toNode(w, 'mirror-1', [receipt(up.image.receiptId), receipt(up.big.receiptId), receipt(up.stored.receiptId)])
    const assembled = await node.assembleParts(turn)
    assert.deepEqual(assembled.map(part => part.type), ['image', 'image', 'file'])
    assert.equal(assembled[2].attachment, undefined, 'a file is bytes here: it is staged when the message is sent')
    await nodeSendUser(w)({ requestId: 'ex-1', sessionId: 'node-chat', content: [{ type: 'text', text: 'here' }, ...assembled] })
    const message = userMessageOf(nodeAgent, 'ex-1')
    assert.deepEqual(message.content.map(block => block.type), ['text', 'image', 'image', 'file'])
    // the Bot's own store holds the bytes the page uploaded on the hub
    const chunks = []
    for await (const chunk of w.ctx.attachments.readFileStream(message.content[3].attachment)) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).equals(up.file), true)
    assert.equal(message.content[3].attachment.name, 'notes.txt')
    const image = await w.ctx.attachments.readImage(message.content[1].attachment)
    assert.equal(Buffer.from(image.data).length > 0, true)
    assert.equal(message.content[1].attachment.name, 'shot.png', 'the name the user gave travels with the image')
    assert.equal(message.content[2].attachment.mediaType, 'image/jpeg', 'a re-encoded image is admitted again as what it is now')
    // the prompt bound the receipt to the request; the Session's user message (source.rpcId), when the loop writes it, retires it
    const fileRefs = () => message.content.filter(block => block.type === 'file').length
    assert.equal(fileRefs(), 1)
    nodeAgent.session.append('user/message', createUserMessage({ content: message.content, source: message.source }), { surfaceOp: 'append' })
    await w.dispose()
  })

  it('AR-5: premise — the core refuses a file part that names a stored file instead of a receipt (what the node used to send)', async () => {
    const w = await realUploadWorld()
    await w.agent('node-chat')
    const stored = await w.ctx.attachments.admitEncodedFile({ data: Buffer.from('abc').toString('base64'), name: 'a.txt' })
    await assert.rejects(
      w.prompt({ requestId: 'old-shape', sessionId: 'node-chat', mode: 'queue', content: [{ type: 'file', attachment: stored }] }),
      error => error.code === 'session/attachment-invalid' && error.details?.reason === 'FILE_NOT_STAGED',
    )
    await w.dispose()
  })

  it('AR-5b: a busy node Bot moves the message to a fresh chat before the prompt: the file is staged for the chat it really goes to', async () => {
    const w = await realUploadWorld()
    await w.agent('mirror-1')
    await w.agent('node-chat')
    const moved = await w.agent('node-chat-2')
    const up = await pageUploads(w, 'mirror-1')
    const { node, turn } = await toNode(w, 'mirror-1', [receipt(up.stored.receiptId)], 'ex-b')
    const assembled = await node.assembleParts(turn)
    // staging for the chat the turn was addressed to (what an upload made before the move amounts to) does not survive the move
    const early = await stageFileParts({ ctx: w.ctx, warn() {} }, 'node-chat', assembled)
    await assert.rejects(w.prompt({ requestId: 'ex-b0', sessionId: 'node-chat-2', mode: 'queue', content: early }), error => error.details?.reason === 'FILE_NOT_STAGED')
    // sendUser stages after the move
    await nodeSendUser(w, { moveTo: 'node-chat-2' })({ requestId: 'ex-b', sessionId: 'node-chat', content: [{ type: 'text', text: 'and this?' }, ...assembled], mode: 'steer' })
    const message = userMessageOf(moved, 'ex-b')
    assert.deepEqual(message.content.map(block => block.type), ['text', 'file'])
    assert.equal(userMessageOf(await w.agent('node-chat'), 'ex-b'), undefined, 'nothing went to the old chat')
    await w.dispose()
  })

  it('AR-6: a node with no upload service refuses the turn with a code the hub words; a prompt the core refuses names its reason', async () => {
    const w = await realUploadWorld()
    await w.agent('mirror-1')
    const staged = await pageUploads(w, 'mirror-1')
    const ready = await toNode(w, 'mirror-1', [receipt(staged.stored.receiptId)], 'ex-6')
    const assembled = await ready.node.assembleParts(ready.turn)
    await assert.rejects(stageFileParts({ ctx: { get: () => undefined }, warn() {} }, 'node-chat', assembled), error => error.code === 'bot-attach-unsupported')
    assert.match(failureText({ code: 'E_REJECTED', message: 'bot-attach-unsupported' }), /存不下/)
    assert.match(failureText({ code: 'E_REJECTED', message: 'bot-attach-rejected:MODEL_DOES_NOT_SUPPORT_IMAGES' }), /模型不支持图片/)
    assert.match(failureText({ code: 'E_REJECTED', message: 'bot-attach-rejected:SOMETHING_NEW' }), /SOMETHING_NEW/)
    await w.dispose()
  })
})

describe('attach-real: the whole way — the page\'s prompt on the hub, the frames, the node\'s receiver, the core\'s prompt', () => {
  async function wire({ mode = 'queue', nodeSendThread } = {}) {
    const real = await realUploadWorld()
    const mirrorAgent = await real.agent('mirror-1')
    const nodeAgent = await real.agent('node-chat')
    const hub = makeWorld({ tracker: true })
    const hubServices = { attachments: real.ctx.attachments, fileUploads: real.ctx.fileUploads, agents: real.ctx.agents }
    const original = hub.rt.ctx.get
    hub.rt.ctx.get = name => hubServices[name] ?? original(name)
    hub.rt.resolveAgent = async id => (id === 'mirror-1' ? mirrorAgent : { session: hub.sessionOf(id) })
    const nodeRt = {
      ctx: real.ctx, warn() {}, state: { bots: { rb1: { id: 'rb1', name: 'Bot', type: 'local' } } }, chatOf: () => 'node-chat',
      sendUser: nodeSendUser(real),
      resolveAgent: async id => real.ctx.agents.get(id), attachWaitMs: 300,
      ...(nodeSendThread === undefined ? {} : { sendThreadTurn: nodeSendThread }),
    }
    const receiver = createAttachReceiver(nodeRt)
    nodeRt.assembleAttachmentParts = receiver.assembleParts
    const accept = createBotTurnReceiver(nodeRt)
    const delivered = []
    // the link: chunks first, then the turn, as AC's node dispatch hands them over
    const carry = async () => {
      for (const frame of hub.frames.splice(0)) {
        if (frame.type === 'bot/attach') receiver.receive(frame.payload)
        else if (frame.type === 'bot/turn') delivered.push({ payload: frame.payload, result: accept(frame.payload, {}) })
      }
    }
    return { real, hub, mirrorAgent, nodeAgent, nodeRt, receiver, accept, carry, delivered }
  }

  it('AR-7: an image and a file sent from the Bot\'s page arrive in the node Bot\'s inbox whole; the page shows both; the hub lets go of the bytes', async () => {
    const world = await wire()
    const up = await pageUploads(world.real, 'mirror-1', { bigPng: makePng(2500, 2000) })
    await world.hub.prompt({
      requestId: 'page-1', sessionId: 'mirror-1', mode: 'queue',
      content: [receipt(up.image.receiptId), receipt(up.big.receiptId), receipt(up.stored.receiptId), { type: 'text', text: 'what do these say?' }],
    })
    await settle()
    const kinds = world.hub.frames.map(frame => frame.type)
    assert.equal(kinds.at(-1), 'bot/turn')
    assert.equal(kinds.filter(kind => kind === 'bot/turn').length, 1)
    assert.ok(kinds.slice(0, -1).every(kind => kind === 'bot/attach'), 'every chunk is on the link before the turn that names them')
    await world.carry()
    await until(() => userMessageOf(world.nodeAgent, world.delivered[0].payload.exchangeId))
    const page = world.mirrorAgent.session.log.findLast(event => event.type === 'user/message').data
    assert.deepEqual(page.content.map(block => block.type), ['text', 'image', 'image', 'file'], 'the page\'s own message shows what was attached')
    assert.equal(page.source.rpcId, 'page-1')
    const message = userMessageOf(world.nodeAgent, world.delivered[0].payload.exchangeId)
    assert.notEqual(message, undefined, 'the node Bot got the message with its file')
    assert.deepEqual(message.content.map(block => block.type), ['text', 'image', 'image', 'file'])
    assert.equal(message.content[0].text, 'what do these say?')
    const chunks = []
    for await (const chunk of world.real.ctx.attachments.readFileStream(message.content[3].attachment)) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).equals(up.file), true)
    // spent: the page's upload receipts are gone with the user message; the hub's bytes went out with the frames and
    // the rest is let go when the turn ends
    assert.equal(world.real.uploads.resolve(world.mirrorAgent, up.stored.receiptId), undefined)
    const held = attachmentsOf('page-1')
    assert.deepEqual(held.items, [], 'the bytes are not kept once the frames are out')
    world.nodeRt.settleJoinedTurn(world.delivered[0].payload.exchangeId, 'they say hello')
    assert.equal((await world.delivered[0].result).ok, true)
    world.hub.emitter.emit('botTurnResult', { exchangeId: world.delivered[0].payload.exchangeId, ok: true, text: 'they say hello', seq: 0 })
    await world.hub.idle()
    assert.equal(attachmentsOf('page-1'), undefined, 'the hub let go of the blocks when the turn ended')
    await world.real.dispose()
  })

  it('AR-8: the same request sent twice is taken once (its receipts are spent the first time, so reading them again would refuse a message that went)', async () => {
    const world = await wire()
    const up = await pageUploads(world.real, 'mirror-1')
    const request = { requestId: 'page-2', sessionId: 'mirror-1', mode: 'queue', content: [receipt(up.stored.receiptId), { type: 'text', text: 'file' }] }
    assert.deepEqual(await world.hub.prompt(request), { accepted: true })
    assert.deepEqual(await world.hub.prompt(request), { accepted: true }, 'the repeat is acknowledged, not refused as a stale receipt')
    await settle()
    assert.equal(world.hub.frames.filter(frame => frame.type === 'bot/turn').length, 1, 'and it goes to the node once')
    await world.real.dispose()
  })
})

describe('attach-real: the page\'s other ways in', () => {
  it('AR-9: a message that waits behind a running turn keeps its attachments past the ordinary lifetime and is sent whole when its turn comes', async () => {
    const real = await realUploadWorld()
    const mirrorAgent = await real.agent('mirror-1')
    const hub = makeWorld({ tracker: true })
    const services = { attachments: real.ctx.attachments, fileUploads: real.ctx.fileUploads, agents: real.ctx.agents }
    const original = hub.rt.ctx.get
    hub.rt.ctx.get = name => services[name] ?? original(name)
    hub.rt.resolveAgent = async id => (id === 'mirror-1' ? mirrorAgent : { session: hub.sessionOf(id) })
    await hub.prompt(textRequest('first', 'req-first'))
    const up = await pageUploads(real, 'mirror-1')
    await hub.prompt({ requestId: 'req-queued', sessionId: 'mirror-1', mode: 'queue', content: [receipt(up.stored.receiptId), { type: 'text', text: 'second, with a file' }] })
    assert.equal(hub.frames.filter(frame => frame.type === 'bot/turn').length, 1, 'queue means wait')
    // another attachment message arrives much later, as a long running turn goes by: the clock must not eat the waiting one
    const realNow = Date.now
    Date.now = () => realNow() + 45 * 60_000
    try {
      const more = await pageUploads(real, 'mirror-1')
      stashAttachments('some-other-request', (await collectPrompt({ ctx: real.ctx, warn() {}, resolveAgent: async id => real.ctx.agents.get(id) }, bot, [receipt(more.stored.receiptId)], { sessionId: 'mirror-1', requestId: 'some-other-request' })).collected)
    } finally { Date.now = realNow }
    hub.reply(0)
    await hub.idle()
    const turns = hub.frames.filter(frame => frame.type === 'bot/turn')
    assert.equal(turns.length, 2)
    const attach = hub.frames.filter(frame => frame.type === 'bot/attach')
    assert.equal(attach.length, 1, 'the queued message\'s file goes out when it is sent')
    assert.deepEqual(turns[1].payload.attachments.map(item => [item.kind, item.name, item.bytes]), [['file', 'notes.txt', up.file.length]])
    const page = mirrorAgent.session.log.findLast(event => event.type === 'user/message').data.content
    assert.deepEqual(page.map(block => block.type), ['text', 'file'])
    await real.dispose()
  })

  it('AR-10: asked where an inserted message goes, a message with attachments is offered only the ways that carry them', async () => {
    const real = await realUploadWorld()
    const mirrorAgent = await real.agent('mirror-1')
    const hub = makeWorld({ tracker: true })
    const services = { attachments: real.ctx.attachments, fileUploads: real.ctx.fileUploads, agents: real.ctx.agents }
    const original = hub.rt.ctx.get
    hub.rt.ctx.get = name => services[name] ?? original(name)
    hub.rt.resolveAgent = async id => (id === 'mirror-1' ? mirrorAgent : { session: hub.sessionOf(id) })
    hub.rt.state.prefs = { steerAsk: true }
    const asked = []
    hub.rt.askSteer = (spec) => { asked.push(spec); return true }
    await hub.prompt(textRequest('first', 'req-first'))
    await hub.prompt({ ...textRequest('plain steer', 'req-steer-1'), mode: 'steer' })
    const up = await pageUploads(real, 'mirror-1')
    await hub.prompt({ requestId: 'req-steer-2', sessionId: 'mirror-1', mode: 'steer', content: [receipt(up.stored.receiptId), { type: 'text', text: 'steer with a file' }] })
    assert.equal(asked[0].choices, undefined, 'words only: every choice, as before')
    assert.deepEqual(asked[1].choices, ['steer', 'queue'], 'a separate task carries words only, so it is not offered')
    await real.dispose()
  })
})

describe('attach-real: what a node says when its core refuses', () => {
  it('AR-11: a refusal that waits behind another turn on the node settles the hub\'s wait with its reason instead of timing out', async () => {
    const nodeRt = {
      ctx: { get: () => undefined }, warn() {}, state: { bots: { b1: { id: 'b1', name: 'Bot', type: 'local' } } }, chatOf: () => 'node-chat',
      sendUser: async () => { throw Object.assign(new Error('Model does not support image input.'), { code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } }) },
    }
    const receiver = createAttachReceiver(nodeRt)
    nodeRt.assembleAttachmentParts = receiver.assembleParts
    const queue = []
    // a gate that holds the turn: it runs after acceptTurn has come back from sendThreadTurn
    nodeRt.sendThreadTurn = async ({ run }) => { queue.push(run); return { queued: true } }
    const accept = createBotTurnReceiver(nodeRt)
    const png = makePng(8, 8)
    receiver.receive({ exchangeId: 'ex-q', index: 0, chunk: 0, chunks: 1, data: png.toString('base64') })
    const result = accept({ remoteBotId: 'b1', exchangeId: 'ex-q', text: 'what is this', attachments: [{ index: 0, name: 'p.png', kind: 'image', mediaType: 'image/png', bytes: png.length, sha256: sha(png), chunks: 1 }] }, {})
    await settle()
    assert.equal(queue.length, 1)
    await queue[0]()
    assert.deepEqual(await result, { ok: false, exchangeId: 'ex-q', error: 'bot-attach-rejected:MODEL_DOES_NOT_SUPPORT_IMAGES', text: '' })
    // a turn with no attachment keeps the generic code
    const plain = createBotTurnReceiver({ ...nodeRt, sendThreadTurn: undefined })
    assert.equal((await plain({ remoteBotId: 'b1', exchangeId: 'ex-p', text: 'hi' }, {})).error, 'bot-turn-deliver-failed')
  })
})


describe('attach-real: a file from IM or the phone to a Bot whose page was never opened', () => {
  it('AR-12: the mirror Session is created before the file is uploaded, so the receipt has an Agent to be staged for', async () => {
    const real = await realUploadWorld()
    const hub = makeWorld({ sessionId: null })
    const services = { attachments: real.ctx.attachments, fileUploads: real.ctx.fileUploads, agents: real.ctx.agents }
    const original = hub.rt.ctx.get
    hub.rt.ctx.get = name => services[name] ?? original(name)
    // createSession makes the Session the way the core does: a real Agent lives under it
    hub.rt.createSession = async () => { await real.agent('mirror-new-0'); return 'mirror-new-0' }
    hub.rt.resolveAgent = async id => real.agent(id)
    assert.equal(hub.rt.chatOf(hub.bot.id), hub.bot.id, 'premise: without a Session chatOf answers the Bot id')
    await assert.rejects(real.uploads.uploadStream({ sessionId: hub.rt.chatOf(hub.bot.id), data: stream(Buffer.from('x')), name: 'x.txt' }), error => error.code === 'session/not-found')
    const sessionId = await uploadSessionOf(hub.rt, hub.bot.id)
    assert.equal(sessionId, 'mirror-new-0')
    const staged = await real.uploads.uploadStream({ sessionId, data: stream(Buffer.from('plan')), name: 'plan.txt' })
    const { collected } = await collectPrompt(hub.rt, hub.bot, [{ type: 'file', receiptId: staged.receiptId }], { sessionId: hub.bot.sessionId, requestId: 'im-1' })
    assert.equal(collected.items[0].data.toString(), 'plan')
    // a Bot that already has its Session, and a local Bot, are left as they are
    assert.equal(await uploadSessionOf({ botOf: () => ({ origin: 'local' }), chatOf: () => 'chat-1' }, 'b'), 'chat-1')
    await real.dispose()
  })
})
