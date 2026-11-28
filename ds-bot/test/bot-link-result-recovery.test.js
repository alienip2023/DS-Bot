import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { answer, install } from '../src/host/bot-link.js'

test('W3 result survives a failed transport enqueue and is retried after restart', async () => {
  const posts = []
  let saved = { works: { 'original-work': { from: 'chief', to: 'worker', link: { nodeId: 'hub' } } } }
  function worker({ offline = false } = {}) {
    const state = structuredClone(saved)
    let dispose
    const rt = {
      state,
      ctx: {
        get: name => name === 'remote-agent:bot-network' ? network : undefined,
        effect: callback => { dispose = callback() },
      },
      botOf: id => ({ name: id }),
      save: async () => { saved = structuredClone(state) },
      closeWork: id => { delete state.works[id]; saved = structuredClone(state) },
    }
    const network = {
      nodeId: 'node-a',
      onReliable: () => () => {},
      post: (type, data, opts) => {
        posts.push({ type, data, rid: opts?.rid })
        if (offline) throw new Error('Cluster could not save')
        return opts?.rid
      },
    }
    return { rt, dispose: () => dispose?.() }
  }
  const before = worker({ offline: true })
  await assert.rejects(answer(before.rt, { id: 'original-work', text: 'finished', outcome: 'done' }), /Cluster could not save/)
  assert.equal(saved.works['original-work']?.link.pendingResult?.text, 'finished')

  const after = worker()
  install(after.rt)
  try {
    await setImmediate()
    assert.equal(saved.works['original-work'], undefined)
    assert.equal(posts.length, 2)
    assert.equal(typeof posts[0].rid, 'string')
    assert.deepEqual(posts[0], posts[1])
    assert.deepEqual(posts[1].data, { id: 'original-work', text: 'finished', outcome: 'done' })
  } finally {
    after.dispose()
  }
})
