// The core's own upload and prompt-admission path, for tests that must not trust a fake: a real Cordis Context with the
// real AgentRegistry / session store (agent-loop-testkit), the real LocalAttachmentStore (dsh-attachment-local), the real
// FileUploads service (dsh-client-file-upload) and the core's own prompt admission (dsh-api-session-controller's
// SessionCommandController.prompt, loaded from the installed package with one `export` appended so the class can be
// built without the rest of the controller). Only `commands` / `connection` (which FileUploads registers with) are stubs.
import { deflateSync } from 'node:zlib'
import { mkdtempSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}
/** A valid RGB PNG (a gradient, so it does not compress to nothing). */
export function makePng(width = 64, height = 48) {
  const row = 1 + width * 3
  const raw = Buffer.alloc(row * height)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const at = y * row + 1 + x * 3
    raw[at] = (x * 255 / width) & 255; raw[at + 1] = (y * 255 / height) & 255; raw[at + 2] = ((x * 7 + y * 13) & 255)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

let commandsClass
async function realCommands() {
  if (commandsClass !== undefined) return commandsClass
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (/dsh-api-session-controller\/lib\/index\.js$/.test(url) && loaded.source != null) {
        loaded.source = `${Buffer.from(loaded.source).toString('utf8')}\nexport { SessionCommandController }\n`
      }
      return loaded
    },
  })
  commandsClass = (await import('@deepseek-ai/dsh-api-session-controller')).SessionCommandController
  return commandsClass
}

/**
 * { ctx, uploads, store, agent(sessionId), commands, prompt(request), dispose() }
 * `prompt` is the core's own sessionController.prompt: the receipts in the content are resolved against the agent that
 * owns the Session, admitted, bound to the requestId and put in the Agent's inbox.
 */
export async function realUploadWorld() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.plugin(LocalAttachmentStore, { dshHome: mkdtempSync(join(tmpdir(), 'dsb-real-up-')) })
  class Commands extends Service { constructor(c) { super(c, 'commands') } registerFileReceiptResolver() { return () => {} } }
  class Connection extends Service { constructor(c) { super(c, 'connection'); this.fetch = { register: () => () => {} } } }
  ctx.plugin(Commands)
  ctx.plugin(Connection)
  await new Promise(resolve => setTimeout(resolve, 30))
  ctx.plugin(FileUploads)
  await new Promise(resolve => setTimeout(resolve, 30))
  await mountAgentLoopTestHarness(ctx)
  const Commands2 = await realCommands()
  const agents = {
    resolveAgent: async sessionId => { const agent = ctx.agents.get(sessionId); return agent === undefined ? { error: new Error('not found') } : { agent } },
    serializeImageAdmission: (_agent, operation) => operation(),
  }
  const commands = new Commands2(ctx, agents, process.cwd())
  const world = {
    ctx, commands,
    get uploads() { return ctx.fileUploads },
    get store() { return ctx.attachments },
    agent: async sessionId => ctx.agents.get(sessionId) ?? await ctx.agentLoop.create(SessionId(sessionId), {}),
    prompt: request => commands.prompt(request, { kind: 'user', rpcId: request.requestId }),
    dispose: () => ctx.fiber.dispose(),
  }
  return world
}
