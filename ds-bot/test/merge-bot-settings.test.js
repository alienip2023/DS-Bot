// s50 merge M5: see the tests below.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/bot-settings.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useRef: current => ({ current }), useId: () => 'id', Fragment: Symbol('Fragment'),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { BotSettingsForm } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}
function settings(bot) {
  const roster = { mainBotIds: [], mainBotId: null, rooms: [], models: [], memory: false }
  return walk(BotSettingsForm({ bot, roster, actions: {}, run: fn => fn }))
}
const names = tree => tree.filter(node => typeof node.type === 'function').map(node => node.type.name)
const base = { id: 'b', name: 'Writer', role: 'Writer', instructions: '', capabilities: [] }
const joined = { ...base, id: 'joined:n1:rb1', origin: 'joined', type: 'remote-worker', worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true } }

// s50 (merge, M5): the settings page of a Bot merges upstream's "Runs on" card (a model or a CLI agent ON THIS
// MACHINE) with this fork's model picker that lists the NODE's models for a remote Bot.
test('M-settings-local: a local Bot gets the "Runs on" card and the node-aware model picker', () => {
  const found = names(settings(base))
  assert.ok(found.includes('RunModeCard'), found.join(','))
  assert.ok(found.includes('BotModelMenu'), found.join(','))
})

test('M-settings-joined: a remote Bot keeps the node-aware model picker and has no "Runs on" card (it runs on its node)', () => {
  const found = names(settings(joined))
  assert.ok(found.includes('BotModelMenu'), found.join(','))
  assert.equal(found.includes('RunModeCard'), false)
})

test('M-settings-joined-not-by-type: only a Bot that is really a remote shadow loses the card', () => {
  for (const bot of [{ ...base, origin: 'joined' }, { ...base, type: 'remote-worker', worker: { home: 'local' } }, { ...joined, worker: { ...joined.worker, home: 'local' } }]) {
    assert.ok(names(settings(bot)).includes('RunModeCard'), JSON.stringify(bot.worker ?? bot.origin))
  }
})
