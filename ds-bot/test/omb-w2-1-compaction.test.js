// DS-P2-W2-1: the bounded, deterministic local compaction digest. Offline: no network,
// no real model. liveFor is a counting stub, so a leaked dispatch is a counted assertion
// failure and never a crash.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalAgentAdapter, digestChunks, compactionChunks, COMPACTION_FOLD_BUDGET } from '../src/host/local-agents/adapter.js'

const STUB = Symbol('stub-live')
const bytes = text => Buffer.byteLength(text, 'utf8')
const msg = (role, text) => ({ role, content: [{ type: 'text', text }] })
const SYNTH_TEXT = 'SYNTHETIC-FINAL-PROMPT write the checkpoint now'
const synthetic = (text = SYNTH_TEXT) => msg('user', text)
const filler = i => `u${i} ` + 'ü漢 lorem ipsum '.repeat(8).trim()
const longText = tag => `${'x'.repeat(400)} ${tag}`

function fixture() {
  const counters = { liveFor: 0, prompt: 0, embed: 0 }
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    embed: () => { counters.embed++ },
    presetFor: () => 'workspace-write',
    customAgents: () => [],
  })
  const engine = { prompt: () => { counters.prompt++; return (async function* () {})() } }
  adapter.liveFor = async () => {
    counters.liveFor++
    void engine
    throw STUB // harmless: counted above, never reaches a real engine
  }
  const dispatches = () => counters.liveFor + counters.prompt + counters.embed
  return { adapter, counters, dispatches }
}

// Drain the whole stream; the stub's sentinel is swallowed, anything else is reported.
async function run(adapter, options) {
  let text = ''
  let error
  try {
    for await (const chunk of adapter.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
  } catch (caught) {
    if (caught !== STUB) error = caught
  }
  return { text, error }
}

const digest = messages => compactionChunks(messages).find(chunk => chunk.type === 'text-delta').text
const compaction = messages => ({ purpose: 'compaction', sessionId: 's1', messages })

function history(exchanges, { pending, tail = true } = {}) {
  const out = []
  for (let i = 1; i <= exchanges; i++) {
    const last = i > exchanges - 2
    out.push(msg('user', last && tail ? longText(`Q${i}-END`) : filler(i)))
    out.push(msg('assistant', last && tail ? longText(`A${i}-END`) : filler(i).replace(/^u/, 'a')))
  }
  if (pending !== undefined) out.push(msg('user', pending))
  return out
}
const lineOf = message => `${message.role}: ${message.content[0].text}`

test('digest-bounds-over-8kib', () => {
  const text = digest([...history(40), synthetic()])
  const folded = text.slice(0, text.lastIndexOf('\n'))
  assert.ok(bytes(folded) <= 8192, 'digest-bounds-over-8kib: folded output must be <= 8192 bytes')
})

test('digest-keeps-recent-exchanges', () => {
  const messages = history(6)
  const text = digest([...messages, synthetic()])
  const at = messages.slice(-4).map(lineOf).map(line => text.indexOf(line))
  assert.ok(at.every(i => i >= 0) && at.every((i, k) => k === 0 || i > at[k - 1]), 'digest-keeps-recent-exchanges: latest exchange text must appear verbatim')
})

test('digest-never-folds-pending-request', () => {
  const pending = longText('PENDING-END')
  const completed = history(6)
  const text = digest([...completed, msg('user', pending), synthetic()])
  // The pending request is protected and does not count toward K: the last two completed exchanges stay verbatim too.
  const kept = completed.slice(-4).map(lineOf).every(line => text.includes(line))
  assert.ok(text.includes(`user: ${pending}`) && kept, 'digest-never-folds-pending-request: pending request must appear verbatim and unfolded')
})

test('digest-evicts-oldest-first', () => {
  const messages = history(150, { tail: false })
  // Skip the oldest 4 and the newest 4 lines: only the middle is judged, so which recent exchanges
  // are retained does not matter here, only the order of eviction.
  const middle = messages.slice(4, -4).map(lineOf)
  const text = digest([...messages, synthetic()])
  const present = new Set(text.split('\n'))
  const first = middle.findIndex(line => present.has(line))
  const suffix = first > 0 && middle.slice(first).every(line => present.has(line))
  const marker = /\[digest: (\d+) earlier lines omitted\]/.exec(text)
  const cost = message => bytes(lineOf(message)) + 1
  const foldable = messages.slice(0, -4)
  const historyBudget = COMPACTION_FOLD_BUDGET - bytes('[Earlier conversation, condensed]\n') - 64
  let used = messages.slice(-4).reduce((sum, message) => sum + cost(message), 0)
  let dropped = foldable.length
  while (dropped > 0 && used + cost(foldable[dropped - 1]) <= historyBudget) {
    used += cost(foldable[--dropped])
  }
  assert.ok(suffix && marker !== null && Number(marker[1]) === dropped, 'digest-evicts-oldest-first: oldest foldable entries must be evicted first')
})

test('digest-preserves-citations-verbatim', () => {
  const straddle = 'src:Fold/Straddle.MD:12-14'
  const folded = ['[7]', 'src:Fold/Notes.MD', 'https://Fold.Example.com/A/B?Q=1', 'Fold.JS:42-50', straddle]
  const kept = ['[9]', 'src:Keep/Notes.MD', 'https://Keep.Example.com/A/B?Q=1', 'Keep.JS:42-50']
  const messages = [
    msg('user', 'see [7] and src:Fold/Notes.MD and Fold.JS:42-50 for Q one'),
    // the 300-char cut lands inside this token: it must stay whole
    msg('assistant', `${'p '.repeat(139)}${straddle} tail`),
    msg('user', 'open https://Fold.Example.com/A/B?Q=1 please'),
    msg('assistant', 'done'),
    msg('user', `protected ${kept[0]} ${kept[3]}`),
    msg('assistant', `protected ${kept[1]} ok`),
    msg('user', `latest ${kept[2]}`),
    msg('assistant', 'latest done'),
  ]
  const text = digest([...messages, synthetic()])
  assert.ok([...folded, ...kept].every(token => text.includes(token)), 'digest-preserves-citations-verbatim: citation text must be unchanged')
})

test('digest-synthetic-passed-through', () => {
  const messages = history(6)
  const final = synthetic(`  ${SYNTH_TEXT}\n\t${'z'.repeat(20_000)}  `)
  const text = digest([...messages, final])
  const expected = `user: ${(SYNTH_TEXT + ' ' + 'z'.repeat(300)).slice(0, 300)}`
  const split = text.lastIndexOf('\n')
  const folded = text.slice(0, split)
  assert.equal(text.slice(split + 1), expected, 'digest-synthetic-passed-through: synthetic final line must match legacy rendering')
  assert.ok(bytes(folded) <= COMPACTION_FOLD_BUDGET, 'digest-synthetic-passed-through: synthetic final prompt must stay outside accounting')
  assert.equal(folded, digest([...messages, synthetic(' \n\t ')]), 'digest-synthetic-passed-through: an empty synthetic line adds nothing')
})

test('digest-oversize-protected-fallback', () => {
  // Fewer than two completed exchanges: everything is protected, so one oversize pending request decides.
  const big = `${'P'.repeat(20_000)} PROT-END`
  const text = digest([msg('user', 'q1'), msg('assistant', 'a1'), msg('user', big), synthetic()])
  const marker = '[digest: protected text exceeds budget; earlier history omitted]'
  assert.ok(text.includes(marker) && text.includes(`user: ${big}`), 'digest-oversize-protected-fallback: protected text must never be cut')
})

test('digest-helper-failure-falls-back', async () => {
  const messages = history(90, { tail: false })
  const build = () => {
    let reads = 0
    const content = messages[0].content
    Object.defineProperty(messages[0], 'content', { get() { if (reads++ === 0) throw new Error('boom'); return content } })
    return messages
  }
  const warnings = []
  const onWarning = warning => { if (warning.code === 'DS_DIGEST_FALLBACK') warnings.push(warning) }
  process.on('warning', onWarning)
  let text, error
  try { text = compactionChunks([...build(), synthetic()]).find(chunk => chunk.type === 'text-delta').text } catch (caught) { error = caught }
  await new Promise(resolve => setImmediate(resolve))
  process.off('warning', onWarning)
  const historyText = digestChunks(history(90, { tail: false })).find(chunk => chunk.type === 'text-delta').text
  const expected = `${historyText}\nuser: ${SYNTH_TEXT}`
  assert.ok(error === undefined && text === expected && warnings.length === 1 && !warnings[0].message.includes('ü'), 'digest-helper-failure-falls-back: must return deterministic digest on helper failure')
})

test('compaction-zero-dispatch', async () => {
  const { adapter, dispatches } = fixture()
  await run(adapter, compaction([...history(4), synthetic()]))
  assert.equal(dispatches(), 0, `compaction-zero-dispatch: expected 0 model/embedding dispatches, got ${dispatches()}`)
})

test('normal-turn-dispatch-preserved', async () => {
  const { adapter, counters } = fixture()
  await run(adapter, { sessionId: 's1', messages: [msg('user', 'hello')] })
  assert.equal(counters.liveFor, 1, 'normal-turn-dispatch-preserved: ordinary turn must still dispatch')
})
