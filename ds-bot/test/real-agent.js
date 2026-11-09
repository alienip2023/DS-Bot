// A REAL production Agent (ReactLoopAgent of dsh-agent-loop) for tests that must see what the
// core does when a plugin calls agent.followup/steer/inject. It comes from the DSH checkout's
// agent-loop-testkit (DSH_HARNESS, default /private/tmp/deepseek-harness): a cordis Context with
// the real session / agents / loop services and no model adapter, so a native turn that starts
// writes turn/start and then fails — exactly the event the mirror Session must never get.
//
// Without that checkout the tests that need it skip WITH a notice (set DSH_REQUIRE_REAL_AGENT=1
// to make a missing checkout a failure instead).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HARNESS = process.env.DSH_HARNESS ?? '/private/tmp/deepseek-harness'
const KIT = join(HARNESS, 'packages/test-support/agent-loop-testkit')
const KIT_MODULES = join(KIT, 'node_modules/@deepseek-ai')

export const REAL_AGENT_AVAILABLE = existsSync(join(KIT, 'lib/index.js')) && existsSync(join(KIT_MODULES, 'cordis/lib/index.js'))
export const REAL_AGENT_SKIP = REAL_AGENT_AVAILABLE
  ? false
  : process.env.DSH_REQUIRE_REAL_AGENT === '1'
    ? false
    : `real-agent tests skipped: no agent-loop-testkit at ${KIT} (set DSH_HARNESS)`

const imp = path => import(pathToFileURL(path).href)

/** { ctx, create(sessionId) → live ReactLoopAgent, message(text), types(agent), dispose() } */
export async function realAgentWorld() {
  const tk = await imp(join(KIT, 'lib/index.js'))
  const { Context } = await imp(join(KIT_MODULES, 'cordis/lib/index.js'))
  const { SessionId } = await imp(join(KIT_MODULES, 'dsh-session/lib/index.js'))
  const { createUserMessage } = await imp(join(KIT_MODULES, 'dsh-llm/lib/index.js'))
  const ctx = new Context()
  await tk.mountAgentLoopTestDependencies(ctx)
  const harness = await tk.mountAgentLoopTestHarness(ctx)
  return {
    ctx,
    create: sessionId => harness.create(SessionId(sessionId)),
    message: (text = '继续') => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    types: agent => agent.session.log.map(event => event.type),
    dispose: () => ctx.fiber.dispose(),
  }
}

/** The cordis the production services run on — { Context, Service } from the same testkit. */
export async function realCordis() {
  const { Context, Service } = await imp(join(KIT_MODULES, 'cordis/lib/index.js'))
  return { Context, Service }
}
