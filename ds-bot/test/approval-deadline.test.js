import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withDeadline, deadlineScope } from './approval-deadline.js'
import { threadWorld, makeBot } from './thread-t2-world.js'

test('D1 withDeadline rejects with the label and bound, and passes a settled value', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 20, 'lbl'), { message: 'lbl: no settle within 20 ms' })
  assert.equal(await withDeadline(Promise.resolve(7), 1000, 'ok'), 7)
})

test('D1 deadlineScope cleanup settles a pending approval as cancelled', async () => {
  const w = threadWorld()
  const scope = deadlineScope()
  const bot = await makeBot(w)
  const request = w.ctx.listeners.get('approval/request')[0]({ agent: { session: { id: w.rt.chatOf(bot.id) } }, toolName: 'shell', callId: 'c1', reason: 'r', signal: scope.signal() }, () => new Promise(() => {}))
  assert.equal(w.rt.approvalsView().length, 1)
  scope.cleanup()
  assert.equal(await withDeadline(request, 2000, 'scope-cleanup'), 'cancelled')
  assert.equal(w.rt.approvalsView().length, 0)
})

test('D3 an unresolved approval fixture fails naturally by its deadline and cleans up', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/approval-unresolved.fixture.js', import.meta.url))
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const child = spawn(process.execPath, ['--import', './test/harness-resolve.mjs', '--test', fixture], { cwd, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { out += chunk })
  const killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 20000)
  const [code, signal] = await new Promise(resolve => child.on('close', (c, s) => resolve([c, s])))
  clearTimeout(killer)
  assert.equal(signal, null, `killed by ${signal}: HANG\n${out}`)
  assert.notEqual(code, 0, out)
  assert.match(out, /unresolved-approval: no settle within 300 ms/)
  assert.match(out, /pending=0/)
})
