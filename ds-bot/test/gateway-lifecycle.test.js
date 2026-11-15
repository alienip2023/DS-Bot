import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { test } from 'node:test'
import { createGatewayServer } from '../src/gateway/index.js'

function gateway(port = 0) {
  const published = []
  const gw = createGatewayServer({
    gatewayPort: port, secrets: new Map(), providers: [],
    rt: { ctx: { provide: (_key, value) => published.push(value) } },
  })
  return { gw, published }
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

test('stop during gateway startup cancels publication and permits a clean restart', async t => {
  const { gw, published } = gateway()
  t.after(() => gw.stop())
  const pending = gw.start()
  await gw.stop()
  assert.equal(await pending, null)
  assert.deepEqual(published, [])
  const port = await gw.start()
  assert.ok(await canConnect(port))
  await gw.stop()
  assert.equal(await canConnect(port), false)
})

test('concurrent gateway starts share one listener and stop releases its port', async t => {
  const reserve = createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const { gw, published } = gateway(port)
  t.after(() => gw.stop())
  const [first, second] = await Promise.all([gw.start(), gw.start()])
  assert.equal(first, port)
  assert.equal(second, port)
  assert.deepEqual(published, [port])
  await gw.stop()
  assert.equal(await canConnect(port), false)
})
