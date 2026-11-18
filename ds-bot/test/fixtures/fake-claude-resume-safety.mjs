// Explicit protocol refusal and captured input for resume safety tests.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, scenario, stderr = ''] = process.argv.slice(2)
const counter = join(dir, 'runs')
const run = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1
writeFileSync(counter, String(run))
const log = value => appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ run, ...value })}\n`)
const argv = process.argv.slice(5)
const config = argv.indexOf('--mcp-config')
if (config !== -1) argv[config + 1] = '<test-mcp-config>'
log({ type: 'spawn', argv, runtime: process.execPath })
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const refuse = () => {
  process.stderr.write(stderr)
  process.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, num_turns: 0 })}\n`, () => process.exit(1))
}
if ((scenario === 'before' && run === 1) || (scenario === 'twice' && run <= 2)) {
  refuse()
} else if (scenario === 'unknown' && run === 1) {
  process.stderr.write(stderr, () => process.exit(1))
} else {
  let rest = ''
  let turn = 0
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    rest += chunk
    let at
    while ((at = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, at)
      rest = rest.slice(at + 1)
      if (line === '') continue
      const message = JSON.parse(line)
      log({ type: 'stdin', message })
      if (message.type !== 'user') continue
      turn += 1
      if (run === 1 && (scenario === 'after' || scenario === 'protocol-after')) {
        if (scenario === 'protocol-after') refuse()
        else process.stderr.write(stderr, () => process.exit(1))
        continue
      }
      send({ type: 'system', subtype: 'init', session_id: `session-${run}` })
      if (scenario === 'permission') {
        send({ type: 'control_request', request_id: `approval-${run}-${turn}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: `action-${run}-${turn}` } } })
      } else {
        send({ type: 'assistant', message: { content: [{ type: 'text', text: `success-${run}-${turn}` }] } })
        send({ type: 'result', subtype: 'success' })
      }
    }
  })
}
