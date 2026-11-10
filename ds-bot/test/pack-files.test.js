// s50 / merge plan I14: what `npm pack` would ship. The merged package.json must keep this fork's files[]
// (src/gateway/ is not part of upstream's), its name and its repository (alienip2023), and the pack must be
// self-contained: every relative import of every packed .js file resolves to a file that is in the pack.
// `npm pack --dry-run --json` is the real packer's own answer; nothing is written, no network is used.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0]
const packed = new Set(pack.files.map(file => file.path))

test('M-pack-identity: the package is still this fork\'s — name ds-bot, repository/homepage/bugs under alienip2023, a -fork. version', () => {
  assert.equal(pkg.name, 'ds-bot')
  assert.equal(pack.name, 'ds-bot')
  assert.match(pkg.repository.url, /github\.com\/alienip2023\/DS-Bot(\.git)?$/)
  assert.equal(pkg.repository.directory, 'ds-bot')
  assert.match(pkg.homepage, /github\.com\/alienip2023\/DS-Bot/)
  assert.match(pkg.bugs.url, /github\.com\/alienip2023\/DS-Bot/)
  assert.match(pkg.version, /^0\.3\.\d+-fork\.\d+$/)
  assert.equal(pack.version, pkg.version)
})

test('M-pack-gateway: every file of src/gateway/ is in the pack, and so are the entry, the bundles and the patch', () => {
  const gateway = readdirSync(join(ROOT, 'src/gateway')).filter(name => name.endsWith('.js'))
  assert.ok(gateway.length >= 7)
  for (const name of gateway) assert.ok(packed.has(`src/gateway/${name}`), `src/gateway/${name}`)
  for (const file of ['index.js', 'client.js', 'office.js', 'web-search.js', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']) assert.ok(packed.has(file), file)
  assert.ok(pkg.files.includes('src/gateway/'))
})

test('M-pack-closed: every relative import of every packed .js file resolves inside the pack (nothing the package needs is left out)', () => {
  const missing = []
  for (const path of packed) {
    if (!path.endsWith('.js') || path === 'client.js' || path === 'office.js' || path === 'web-search.js') continue
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]))
      if (!packed.has(target)) missing.push(`${path} -> ${target}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('M-pack-no-secrets: no file the pack ships is a state file, a credentials file or a test fixture', () => {
  const bad = [...packed].filter(path => /(^|\/)(state\.json|\.credentials\.yaml|\.env[^/]*|test\/|dev\/|node_modules\/)/.test(path))
  assert.deepEqual(bad, [])
})
