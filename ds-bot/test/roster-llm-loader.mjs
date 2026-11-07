// Roster tests must not need a local @deepseek-ai/dsh-llm install.
// node --import ./test/roster-llm-loader.mjs --test test/roster-join-sidebar.test.js
import { registerHooks } from 'node:module'

const stub = new URL('./roster-llm-stub.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') {
      return { url: stub, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
