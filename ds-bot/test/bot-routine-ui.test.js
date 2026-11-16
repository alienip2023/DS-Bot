import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: "export { SchedulesPage } from './src/client/schedules.js'", resolveDir: new URL('../', import.meta.url).pathname },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function page(view, start) {
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
    useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }),
    useState: value => [value === null ? view : typeof value === 'function' ? value() : value, () => {}],
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : {} })
  const bot = { id: 'joined:n1:remote', name: 'Node writer', origin: 'joined' }
  const roster = { bots: [bot], byId: { [bot.id]: bot }, rooms: [], roomsById: {} }
  const requests = []
  const actions = { scheduleCreate: async request => { requests.push(request); return view } }
  const tree = module.exports.SchedulesPage({ roster, actions, start })
  const nodes = []
  const texts = []
  function visit(node) {
    if (typeof node === 'string') { texts.push(node); return }
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (typeof node.type === 'function') {
      if (['TaskRow', 'TaskForm'].includes(node.type.name)) visit(node.type(node.props))
      return
    }
    nodes.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  return { nodes, texts, requests }
}

test('the task page identifies the joined Bot and shows its last failure', () => {
  const run = { id: 'run-1', status: 'failed', error: 'E_OFFLINE: node offline', queuedAt: Date.now() }
  const w = page({ available: true, tasks: [{ id: 'routine-1', title: 'Check', target: { kind: 'bot', botId: 'joined:n1:remote' }, botId: 'joined:n1:remote', kind: 'every', everySeconds: 60, scheduledAt: new Date(Date.now() + 60_000).toISOString(), status: 'active', lastRun: run, runs: [run] }] })
  assert.ok(w.texts.includes('Node writer'))
  assert.ok(w.texts.includes('Last run: Failed'))
  assert.ok(w.texts.some(text => text.includes('E_OFFLINE: node offline')))
  assert.ok(w.nodes.some(node => node.props?.role === 'alert'))
})

test('the creation form sends a stable Bot target for a joined Bot', async () => {
  const w = page({ available: true, tasks: [] }, 'joined:n1:remote')
  const form = w.nodes.find(node => node.type === 'form')
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.requests.length, 1)
  assert.equal(w.requests[0].target.kind, 'bot')
  assert.equal(w.requests[0].target.botId, 'joined:n1:remote')
})
