// Both plugins together: an image and a file go from the hub's collector through the REAL AC validators and frame
// handlers (bot/attach, bot/turn) into the node's real receiver, and come out as the parts the Bot's Session takes.
// Needs the AC repo (0.4.25+): REMOTE_AGENT_REPO, or a sibling `dsh-ai-cluster`; skipped when it is not there.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { CHUNK_BYTES, MAX_ATTACHMENTS, MAX_TOTAL_BYTES, collectPrompt, createAttachReceiver, sendChunks } from '../src/host/joined-attachments.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const candidates = [process.env.REMOTE_AGENT_REPO, resolve(PLUGIN, '../../dsh-ai-cluster'), resolve(PLUGIN, '../../../Projects/dsh-ai-cluster')]
  .filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
const repo = candidates.find(dir => existsSync(join(dir, 'lib/bot-attach.js')))
const skip = repo === undefined ? 'AC repo with bot/attach not found (set REMOTE_AGENT_REPO)' : false
const load = async (file) => import(pathToFileURL(join(repo, 'lib', file)).href)
const sha = buffer => createHash('sha256').update(buffer).digest('hex')

test('an image and a 2 MB file cross the real AC frame path and arrive whole', { skip }, async () => {
  const { validateBotAttach, validateBotTurn, NODE_TO_HUB, HUB_TO_NODE } = await load('protocol.js')
  const { handleBotAttachFrame } = await load('bot-attach.js')
  assert.equal(HUB_TO_NODE.BOT_ATTACH, 'bot/attach')

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const big = Buffer.alloc(2 * 1024 * 1024 + 123, 5)
  const store = {
    readImage: async ref => ({ data: new Uint8Array(png), ref }),
    readFileStream: async function* () { yield new Uint8Array(big) },
    admitPromptContent: async parts => parts.map(() => ({ type: 'image', attachment: { attachmentId: 'a', bytes: png.length } })),
    admitEncodedFile: async ({ data, name }) => ({ attachmentId: 'f', name, bytes: Buffer.from(data, 'base64').length }),
  }
  const hubRt = { ctx: { get: name => (name === 'attachments' ? store : undefined) }, warn() {} }
  const bot = { id: 'joined:n1:b1', worker: { nodeId: 'n1', remoteBotId: 'b1' } }
  const { text, collected } = await collectPrompt(hubRt, bot, [
    { type: 'text', text: 'see these' },
    { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'shot.png' },
    { type: 'file', attachment: { attachmentId: 'f', name: 'dump.bin', bytes: big.length } },
  ])

  // the hub: the frames it would put on the link
  const wire = []
  const manifest = sendChunks({ send: (nodeId, type, payload) => { wire.push({ type, payload }); return true } }, { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-1', items: collected.items })
  wire.push({ type: 'bot/turn', payload: { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex-1', text, attachments: manifest } })
  assert.ok(wire.filter(frame => frame.type === 'bot/attach').length >= 4, 'the 2 MB file is several chunks')

  // the node: AC validates and dispatches each frame; ds-bot's receiver keeps the chunks
  const nodeRt = { ctx: { get: name => (name === 'attachments' ? store : undefined) }, warn() {} }
  nodeRt.attachWaitMs = 200
  const node = createAttachReceiver(nodeRt)
  const ctx = { get: name => (name === 'remote-agent:bot-attach' ? node.receive : undefined) }
  let turn
  for (const frame of wire) {
    if (frame.type === 'bot/attach') {
      assert.equal(validateBotAttach(frame.payload).ok, true, 'AC accepts every chunk')
      assert.equal(handleBotAttachFrame({ frame: { id: 'f' }, data: frame.payload, ctx, send() {}, sendError() { assert.fail('no error frame') } }).accepted, true)
    } else {
      const checked = validateBotTurn(frame.payload)
      assert.equal(checked.ok, true)
      turn = checked.turn
    }
  }
  assert.deepEqual(turn.attachments, manifest, 'AC passes the manifest through untouched')
  const parts = await node.assembleParts(turn)
  assert.deepEqual([parts[0].type, parts[0].mediaType, parts[0].name], ['image', 'image/png', 'shot.png'])
  assert.equal(Buffer.from(parts[0].data, 'base64').equals(png), true)
  assert.deepEqual([parts[1].type, parts[1].name, parts[1].data.length], ['file', 'dump.bin', big.length])
  assert.equal(sha(big), manifest[1].sha256)
})

test('AC refuses a damaged manifest rather than dropping it: the turn is rejected', { skip }, async () => {
  const { validateBotTurn } = await load('protocol.js')
  const bad = validateBotTurn({ nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'e', text: 'x', attachments: [{ index: 0, name: 'a', kind: 'file', bytes: 5, sha256: 'nope', chunks: 1 }] })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bot-turn-attachments-invalid')
})

test('the largest message ds-bot lets through (8 attachments, 20 MiB) fits AC\'s validators, and a full chunk fits one sealed frame', { skip }, async () => {
  const { validateBotAttach, validateBotTurn, BOT_ATTACH_LIMITS, MAX_CONTROL_FRAME_BYTES, encodeFrame } = await load('protocol.js')
  const { generateEphemeral, createSession } = await load('e2e.js')
  assert.deepEqual([BOT_ATTACH_LIMITS.maxAttachments, BOT_ATTACH_LIMITS.maxBytes], [MAX_ATTACHMENTS, MAX_TOTAL_BYTES], 'the hub\'s limits are AC\'s')
  assert.ok(Math.ceil(MAX_TOTAL_BYTES / CHUNK_BYTES) <= BOT_ATTACH_LIMITS.maxChunks, 'one attachment of the whole budget is at most maxChunks chunks')
  assert.ok(Math.ceil(CHUNK_BYTES / 3) * 4 <= BOT_ATTACH_LIMITS.maxChunkChars, 'a full chunk\'s base64 is within maxChunkChars')

  // one 20 MiB file, and eight attachments that together are 20 MiB
  for (const sizes of [[MAX_TOTAL_BYTES], Array.from({ length: 8 }, () => MAX_TOTAL_BYTES / 8)]) {
    const items = sizes.map((size, index) => { const data = Buffer.alloc(size, index + 1); return { index, kind: 'file', name: `f${index}.bin`, data, sha256: sha(data) } })
    const frames = []
    const manifest = sendChunks({ send: (_n, _t, payload) => { frames.push(payload); return true } }, { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex', items })
    assert.ok(frames.every(frame => validateBotAttach(frame).ok), 'AC accepts every chunk')
    const checked = validateBotTurn({ nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex', text: '', attachments: manifest })
    assert.equal(checked.ok, true, 'AC accepts the manifest (an empty text is fine beside attachments)')
  }

  // a full chunk, sealed the way the hub link seals it, is one frame well under AC's control-frame limit
  const node = generateEphemeral()
  const hub = generateEphemeral()
  const hubSide = createSession({ role: 'hub', ownPrivB64: hub.privateKeyB64, peerPubB64: node.publicKeyB64, nodePubB64: node.publicKeyB64, hubPubB64: hub.publicKeyB64 })
  const full = Buffer.alloc(CHUNK_BYTES, 255)
  let payload
  sendChunks({ send: (_n, _t, body) => { payload ??= body; return true } }, { nodeId: 'n1', remoteBotId: 'b1', exchangeId: 'ex', items: [{ index: 0, kind: 'file', name: 'f', data: full, sha256: sha(full) }] })
  const sealed = encodeFrame({ t: 'bot/attach', id: 'frame-1', d: hubSide.sealFrame('bot/attach', 'frame-1', payload), to: 'n1' })
  assert.ok(Buffer.byteLength(sealed) < MAX_CONTROL_FRAME_BYTES / 2, `a sealed full chunk is ${Buffer.byteLength(sealed)} bytes, limit ${MAX_CONTROL_FRAME_BYTES}`)
})
