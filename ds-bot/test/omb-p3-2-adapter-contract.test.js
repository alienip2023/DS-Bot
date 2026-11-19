import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { ClaudeEngine } from '../src/host/local-agents/claude.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import {
  assertProviderAdapter,
  PROVIDER_ADAPTER_METHODS,
  PROVIDER_ADAPTER_OPTIONAL_METHODS,
  PROVIDER_ADAPTER_REQUIRED_METHODS,
} from '../src/host/local-agents/provider-adapter.js'

const engines = [CodexEngine, ClaudeEngine, AcpEngine]

test('provider-adapter contract: real engines satisfy the required surface', () => {
  for (const Engine of engines) {
    const engine = Object.create(Engine.prototype)
    assert.equal(assertProviderAdapter(engine), engine, Engine.name)
    for (const name of ['listModels', 'open', 'prompt']) {
      assert.equal(typeof Engine.prototype[name], 'function', `${Engine.name}.${name}`)
    }
  }
})

test('provider-adapter contract: missing members are optional', () => {
  for (const Engine of engines) {
    const diagnostic = `provider-adapter-required-missing: ${Engine.name}`
    const ownMethods = new Set(Object.getOwnPropertyNames(Engine.prototype)
      .filter(name => typeof Engine.prototype[name] === 'function'))
    assert.deepEqual(PROVIDER_ADAPTER_REQUIRED_METHODS.filter(name => !ownMethods.has(name)), [], diagnostic)

    const missing = PROVIDER_ADAPTER_METHODS.filter(name => typeof Engine.prototype[name] !== 'function')
    assert.deepEqual(missing.filter(name => !PROVIDER_ADAPTER_OPTIONAL_METHODS.includes(name)), [], diagnostic)
  }
})

test('provider-adapter contract: a missing required method is named', () => {
  assert.throws(() => assertProviderAdapter({}), {
    name: 'TypeError',
    message: 'provider-adapter-missing-method: listModels',
  }, 'provider-adapter-missing-method')

  const invalid = Object.create(AcpEngine.prototype, { cancel: { value: 1 } })
  assert.throws(() => assertProviderAdapter(invalid), {
    name: 'TypeError',
    message: 'provider-adapter-missing-method: cancel',
  }, 'provider-adapter-missing-method')
})

test('provider-adapter contract: typedef matches real call sites', () => {
  const readSource = name => readFileSync(new URL(`../src/host/local-agents/${name}.js`, import.meta.url), 'utf8')
  const code = ['adapter', 'index'].map(readSource).join('\n').replace(/^\s*\/\/.*$/gm, '')
  const calls = [...code.matchAll(/(?:\bengine\b|\bthis\.engines\.get\([^()\n]*\)\?)\.([a-zA-Z]+)(\?\.)?\(/g)]
  const properties = [...readSource('provider-adapter').matchAll(/@property \{[^\n]+\} (\[)?(\w+)/g)]
  const methods = [...new Set([...PROVIDER_ADAPTER_REQUIRED_METHODS, ...PROVIDER_ADAPTER_OPTIONAL_METHODS])].sort()
  assert.deepEqual(PROVIDER_ADAPTER_METHODS, methods, 'provider-adapter-contract-drift')
  assert.deepEqual(methods, [...new Set(calls.map(([, name]) => name))].sort(), 'provider-adapter-contract-drift')
  assert.deepEqual(properties.map(([, , name]) => name).sort(), methods, 'provider-adapter-contract-drift')

  const requiredCalls = new Set(calls.filter(([, , optional]) => !optional).map(([, name]) => name))
  const requiredProperties = properties.filter(([, optional]) => !optional).map(([, , name]) => name)
  assert.deepEqual(requiredProperties.sort(), [...requiredCalls].sort(), 'provider-adapter-contract-drift')
})
