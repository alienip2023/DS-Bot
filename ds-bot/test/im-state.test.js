// P2 (fork.63): a profile whose saved state has `im: {}` (no `connections` key) must still
// produce a state view. `state.im ??= {...}` does not assign when state.im is `{}`, so the
// old accessor handed back undefined and Object.values(undefined) threw, which made the
// whole 'state' endpoint fail and left the sidebar without any Bot.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRuntime } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

function world(im) {
  const ctx = fakeContext()
  const routes = []
  ctx.connection.fetch.register = route => { routes.push(route); return () => {} }
  const rt = createRuntime(ctx, { home: mkdtempSync(join(tmpdir(), 'ds-bot-im-state-')) })
  if (im !== undefined) rt.state.im = im
  // Workspace/model/secret loading is not what is under test; the view assembly is.
  rt.bootstrap = async () => {}
  rt.catalog = async () => {}
  rt.loadSecrets = async () => {}
  const call = async (endpoint, payload = {}) => {
    const route = routes.find(r => r.path === ROUTE)
    assert.ok(route, 'the api route is registered')
    const response = await route.fetch({ json: async () => ({ endpoint, payload }), signal: new AbortController().signal })
    return JSON.parse(await response.text())
  }
  return { rt, call }
}

describe('P2: state.im without a connections map', () => {
  it('P2-a imView does not throw when state.im is {} and lists no connections', () => {
    const { rt } = world({})
    const view = rt.imView()
    assert.deepEqual(view.connections, [])
    assert.deepEqual(rt.state.im.connections, {}, 'the missing map is created, so later writes land in state')
  })

  it('P2-b the real "state" endpoint answers (sidebar data) when state.im is {}', async () => {
    const { call } = world({})
    const body = await call('state', {})
    assert.equal(body.ok, true, JSON.stringify(body.error ?? body).slice(0, 200))
    assert.deepEqual((body.value ?? body.result ?? body).im?.connections ?? [], [])
  })

  it('P2-c an existing connections map is kept as is, and null state.im is initialised', () => {
    const kept = world({ connections: { c1: { id: 'c1', platform: 'x', settings: {}, secrets: {} } } })
    assert.deepEqual(Object.keys(kept.rt.state.im.connections), ['c1'])
    const nulled = world(null)
    assert.deepEqual(nulled.rt.imView().connections, [])
  })
})
