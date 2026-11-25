// A minimal MCP server over stdio (newline-delimited JSON-RPC): one tool, `echo`, which also reports whether an env
// variable the client was started with reached it (so a test can see what crossed the process boundary).
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } })
  } else if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools: [{ name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  } else if (message.method === 'tools/call') {
    const text = String(message.params?.arguments?.text ?? '')
    send({ id: message.id, result: { content: [{ type: 'text', text: `echo: ${text} (key ${process.env.ECHO_KEY ?? 'none'})` }] } })
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: 'method not found' } })
  }
})
