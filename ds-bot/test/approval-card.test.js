// W1-2: the native approval card. Static rows, spy actions, a tiny hook runtime; no timers
// except test-owned deadlines.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { CARD_STATES, planAnswer, rowBinding, stateAfterError } from '../src/client/approval-card-model.js'
import { DICTIONARY } from '../src/client/i18n.js'
import { withDeadline } from './approval-deadline.js'

const ROW = { id: 'a1', botId: 'b1', roomId: 'r1', answerable: true, tool: 'shell', sessionId: 's1', fingerprint: 'f1' }
const CTX = { botId: 'b1', roomId: 'r1' }
const BOT = { id: 'b1', name: 'Ann' }
const ROOM = { id: 'r1' }

// A minimal hook runtime: state and refs persist per mounted component.
async function load() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/member-status.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  let slots = []
  let cursor = 0
  const react = {
    createContext: initial => ({ value: initial }), useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn,
    useId: () => 'id', useSyncExternalStore: (_s, get) => get(), useEffect: () => {}, useLayoutEffect: () => {}, Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: initial }
      const slot = slots[index]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useRef: (initial) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: name => ({ react, 'react-dom': {}, '@deepseek-ai/dsh-client-ui-primitives': {} })[name] ?? (() => { throw new Error(name) })(),
  })
  return {
    memberApprovals: props => module.exports.MemberApprovals(props),
    mount(props) {
      slots = []
      return () => { cursor = 0; return module.exports.ApprovalCard(props) }
    },
  }
}

const texts = (node) => (node == null || node === false ? [] : typeof node === 'string' ? [node] : [...(node.children ?? [])].flat(Infinity).flatMap(texts))
const buttons = (node) => (node == null || typeof node !== 'object' ? [] : [...(node.type === 'button' ? [node] : []), ...(node.children ?? []).flat(Infinity).flatMap(buttons)])
const spy = (impl) => { const calls = []; return { calls, actions: { answerApproval: (...args) => { calls.push(args); return impl ? impl(...args) : Promise.resolve({ ok: true }) }, reportError: () => {}, openSession: () => {} } } }
const click = (render, label) => buttons(render()).find(b => texts(b).join('') === label).props.onClick()
const tick = () => new Promise(resolve => setImmediate(resolve))

test('A1 actionable row plans a send with the row binding only', () => {
  assert.deepEqual(planAnswer(ROW, CTX, 'allow'), { kind: 'send', id: 'a1', choice: 'allow', binding: { sessionId: 's1', fingerprint: 'f1' } })
  assert.equal(planAnswer(ROW, CTX, 'reject').choice, 'reject')
})

test('A2 unbound rows never send', () => {
  for (const patch of [{ sessionId: undefined }, { sessionId: '' }, { fingerprint: undefined }, { fingerprint: '' }, { sessionId: 1 }, { fingerprint: {} }]) {
    assert.deepEqual(planAnswer({ ...ROW, ...patch }, CTX, 'allow'), { kind: 'block', state: 'unbound' }, JSON.stringify(patch))
  }
  assert.equal(rowBinding({ sessionId: 's' }), undefined)
})

test('A3 mismatched rows never send', () => {
  for (const row of [{ ...ROW, botId: 'other' }, { ...ROW, roomId: 'other' }, { ...ROW, roomId: undefined }]) {
    assert.equal(planAnswer(row, CTX, 'allow').state, 'unbound')
  }
  assert.equal(planAnswer(ROW, { botId: 'b1' }, 'allow').state, 'unbound')
})

test('A4 a row that is not answerable is unavailable', () => {
  assert.deepEqual(planAnswer({ ...ROW, answerable: false }, CTX, 'allow'), { kind: 'block', state: 'unavailable' })
})

test('A2-A4 rendered card: blocked clicks make 0 calls and show fixed text', async () => {
  const m = await load()
  for (const [row, room] of [
    [{ ...ROW, fingerprint: '' }, ROOM],
    [{ ...ROW, botId: 'x' }, ROOM],
    [ROW, { id: 'r2' }],
    [ROW, undefined],
  ]) {
    const { calls, actions } = spy()
    const render = m.mount({ approval: row, bot: BOT, room, actions })
    click(render, 'Allow once')
    assert.equal(calls.length, 0)
    assert.match(texts(render()).join(' '), /cannot be verified/)
  }
  const { calls, actions } = spy()
  const render = m.mount({ approval: { ...ROW, answerable: false }, bot: BOT, room: ROOM, actions })
  assert.deepEqual(buttons(render()).map(b => texts(b).join('')), ["Open Ann's chat"], 'not answerable shows only the open-chat button')
  assert.equal(calls.length, 0)
})

test("A5 one click sends one call; a synchronous double click sends once; binding is the row's", async () => {
  const m = await load()
  const { calls, actions } = spy()
  const render = m.mount({ approval: ROW, bot: BOT, room: ROOM, actions })
  click(render, 'Allow once'); click(render, 'Reject')
  await withDeadline(tick(), 2000, 'a5')
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['a1', 'allow', { sessionId: 's1', fingerprint: 'f1' }]])
})

test('A6 error mapping and frozen state set', async () => {
  assert.deepEqual([...CARD_STATES], ['open', 'sending', 'sent', 'unavailable', 'unbound', 'unverified'])
  assert.equal(stateAfterError({ code: 'bot/stale' }), 'unavailable')
  assert.equal(stateAfterError({ code: 'NETWORK' }), 'unverified')
  assert.equal(stateAfterError(new Error('x')), 'unverified')
  const m = await load()
  for (const [impl, re] of [
    [undefined, /Answer sent/],
    [async () => { throw Object.assign(new Error('x'), { code: 'bot/stale' }) }, /no longer available/],
    [async () => { throw Object.assign(new Error('x'), { code: 'NETWORK' }) }, /Could not confirm/],
    [() => { throw new Error('sync') }, /Could not confirm/],
  ]) {
    const { actions } = spy(impl)
    const render = m.mount({ approval: ROW, bot: BOT, room: ROOM, actions })
    click(render, 'Allow once')
    await withDeadline(tick(), 2000, 'a6')
    assert.match(texts(render()).join(' '), re)
  }
  // an unverified answer can be retried: the host settles first-wins
  const { calls, actions } = spy(async () => { throw Object.assign(new Error('x'), { code: 'NETWORK' }) })
  const render = m.mount({ approval: ROW, bot: BOT, room: ROOM, actions })
  click(render, 'Allow once'); await tick(); click(render, 'Allow once'); await tick()
  assert.equal(calls.length, 2)
})

test('A7 result text names no outcome; the open state still shows both buttons', async () => {
  const m = await load()
  const open = m.mount({ approval: ROW, bot: BOT, room: ROOM, actions: spy().actions })
  assert.deepEqual(buttons(open()).map(b => texts(b).join('')), ['Reject', 'Allow once'])
  const noteOf = render => texts(render().children.at(-1)).join(' ')
  for (const impl of [undefined, async () => { throw Object.assign(new Error('x'), { code: 'bot/stale' }) }, async () => { throw new Error('n') }]) {
    const render = m.mount({ approval: ROW, bot: BOT, room: ROOM, actions: spy(impl).actions })
    click(render, 'Allow once'); await tick()
    assert.notEqual(noteOf(render), '')
    assert.doesNotMatch(noteOf(render), /allowed|rejected|expired|cancel/i)
  }
  const bad = m.mount({ approval: { ...ROW, sessionId: '' }, bot: BOT, room: ROOM, actions: spy().actions })
  click(bad, 'Reject')
  assert.notEqual(noteOf(bad), '')
  assert.doesNotMatch(noteOf(bad), /allowed|rejected|expired|cancel/i)
})

test('A9/A10 own-chat row has only the open-chat button; open card keeps the baseline structure', async () => {
  const m = await load()
  const own = m.mount({ approval: { ...ROW, roomId: undefined }, bot: BOT, room: ROOM, actions: spy().actions })
  assert.deepEqual(buttons(own()).map(b => texts(b).join('')), ["Open Ann's chat"])
  const open = m.mount({ approval: ROW, bot: BOT, room: ROOM, actions: spy().actions })
  assert.deepEqual(buttons(open()).map(b => b.props.className), ['bt-q-btn', 'bt-q-submit'])
})

test('A11 the four new keys exist in every locale', () => {
  const keys = ['Answer sent. Waiting for the host to confirm.', 'This approval is no longer available.', 'Could not confirm the answer. It may still be pending.', 'This approval cannot be verified here. Open the chat to answer.']
  for (const loc of ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de']) for (const key of keys) assert.ok(Object.hasOwn(DICTIONARY[loc] ?? {}, key), `${loc}: ${key}`)
})

test('A3b the room reaches the card: MemberApprovals and the drawer both pass it down', async () => {
  const m = await load()
  const tree = m.memberApprovals({ entry: { state: 'ask', approvals: [ROW] }, bot: BOT, room: ROOM, actions: spy().actions })
  assert.equal(tree.children.flat(Infinity)[0].props.room.id, 'r1')
  const drawer = readFileSync(fileURLToPath(new URL('../src/client/details-drawer.js', import.meta.url)), 'utf8')
  assert.match(drawer, /h\(MemberApprovals, \{ entry, bot: member, room, actions \}\)/)
})
