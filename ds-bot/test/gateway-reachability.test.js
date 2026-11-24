// A node can only use a gateway it can reach. Before fork.112 a gateway on 127.0.0.1 (the default) was
// still written into every node's provider baseURL, so the node's model calls went to its own loopback.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gatewayReachableHost } from '../src/host/config-source.js'

test('loopback and wildcard binds have no address to give a node', () => {
  for (const host of [undefined, '', 'localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '::', '::1', '[::1]']) {
    assert.equal(gatewayReachableHost(host), undefined, String(host))
  }
})

test('a LAN or public address is given out as is; IPv6 in brackets', () => {
  assert.equal(gatewayReachableHost('192.168.1.5'), '192.168.1.5')
  assert.equal(gatewayReachableHost(' gw.example.com '), 'gw.example.com')
  assert.equal(gatewayReachableHost('fd00::5'), '[fd00::5]')
})
