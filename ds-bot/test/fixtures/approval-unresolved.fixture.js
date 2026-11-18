// Opens an approval and never answers it. The deadline must fail this test by itself; the
// child's cleanup then aborts the request and prints pending=0. Spawned by approval-deadline.test.js.
import { test } from 'node:test'
import { threadWorld, makeBot } from '../thread-t2-world.js'
import { withDeadline, deadlineScope } from '../approval-deadline.js'

test('unresolved approval fails by its own deadline', async () => {
  const w = threadWorld()
  const scope = deadlineScope()
  try {
    const bot = await makeBot(w)
    const request = w.ctx.listeners.get('approval/request')[0]({ agent: { session: { id: w.rt.chatOf(bot.id) } }, toolName: 'shell', callId: 'c1', reason: 'r', signal: scope.signal() }, () => new Promise(() => {}))
    await withDeadline(request, 300, 'unresolved-approval')
  } finally {
    scope.cleanup()
    await new Promise(resolve => setImmediate(resolve))
    console.log(`pending=${w.rt.approvalsView().length}`)
  }
})
