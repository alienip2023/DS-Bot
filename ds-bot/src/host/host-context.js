import { readFileSync } from 'node:fs'
import os from 'node:os'
import { basename } from 'node:path'
import { dshVersion } from './diagnostics.js'

// Host environment for the model (contract §N.2, N-1): a remote worker's Bot knew nothing about the
// machine it runs on, so asked "what system are you on" it guessed (macOS, from the user's wording).
// This module puts a short, fixed, locally collected description of THIS machine into the runtime
// context snapshot that DSH renders in the node's own process for every turn.
//
// Rules the code below keeps (each has a test in test/host-context*.test.js):
//  - collected only here, from `node:os` and /etc/os-release — no frame, Bot record, or config of the
//    hub is read (I1, I2). The only outside input is the node's own `remote-agent:node-policy`
//    service (its roots).
//  - nothing secret or identifying beyond the machine itself: no home directory, DSH home, state
//    dir, credentials path, environment variables, IP/MAC, tokens, full shell path (I3).
//  - the same bytes on every turn: no uptime, free memory, load, time (I4).
//  - `auto` switches the text on only where the node-policy service exists, so a hub's own prompt
//    is byte for byte what it was before this module (I5). What counts is the SERVICE, not its roots:
//    ra registers `remote-agent:node-policy` also when the node has no roots (it only warns, then
//    provides `{ roots: [] }`, dsh-remote-agent lib/node/index.js:664-677), so such a worker still gets
//    the text — only the "Writable workspace roots" line is missing. A process without the service at
//    all (a hub) gets nothing.
//  - a field that cannot be read is left out, never written as "unknown".

export const CONTEXT_NAME = 'ds-bot:host-environment'
// Between HARNESS_SOURCE (200) and WEB_SURFACE (210) in dsh-system-prompt's CONTEXT_ORDERS.
export const CONTEXT_ORDER = 205
export const NODE_POLICY = 'remote-agent:node-policy'
export const MODES = ['auto', 'on', 'off']
export const FIELDS = ['node', 'hostname', 'os', 'cpu', 'memory', 'runtime', 'account', 'shell', 'roots']

const HEADER = 'Host environment (this machine, collected locally; it is not the user\'s controller computer):'
const FOOTER = 'If asked about this machine, answer from these facts; run a shell command (uname -a) only if you need more. Do not infer the OS from the user\'s wording, from other Bots\' messages, or from earlier conversation parts.'

// What the machine tells about itself. Every method may throw or return nothing: the field is then
// left out. Tests hand in their own probe; nothing else in this file touches the machine.
export const realProbe = {
  platform: () => os.platform(),
  arch: () => os.arch(),
  release: () => os.release(),
  hostname: () => os.hostname(),
  cpuCount: () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length),
  totalMemory: () => os.totalmem(),
  // The shell is only ever reported by its basename; `os.userInfo()` has no home directory in what is kept.
  user: () => {
    const info = os.userInfo()
    return { name: info.username, uid: info.uid, shell: process.env.SHELL || info.shell }
  },
  nodeVersion: () => process.version,
  dshVersion,
  osRelease: () => readFileSync('/etc/os-release', 'utf8'),
}

const attempt = (read) => {
  try { return read() } catch { return undefined }
}

// One line of plain text: control characters out, a sane length.
const plain = (value, max = 120) => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
  return text === '' ? undefined : text
}

function prettyName(probe, platform) {
  if (platform === 'linux') {
    const text = attempt(() => probe.osRelease())
    const match = typeof text === 'string' ? /^PRETTY_NAME=(.*)$/m.exec(text) : null
    const value = match === null ? undefined : plain(match[1].trim().replace(/^(["'])(.*)\1$/, '$2'))
    return value ?? 'Linux'
  }
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  return plain(platform)
}

/** 2 GiB-class steps: 7.75 GiB reads as "8 GiB class" (a VM never reports exactly 8). */
export function memoryClass(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined
  const gib = bytes / 2 ** 30
  if (gib >= 0.75) return `${2 ** Math.round(Math.log2(gib))} GiB class`
  return `${Math.max(1, 2 ** Math.round(Math.log2(bytes / 2 ** 20)))} MiB class`
}

/** The facts, read once. Fields that cannot be read are simply absent. */
export function collectHost(probe = realProbe) {
  const platform = plain(attempt(() => probe.platform()))
  const user = attempt(() => probe.user())
  const shell = typeof user?.shell === 'string' ? plain(basename(user.shell)) : undefined
  const cores = attempt(() => probe.cpuCount())
  return {
    hostname: plain(attempt(() => probe.hostname())),
    os: prettyName(probe, platform),
    platform,
    arch: plain(attempt(() => probe.arch())),
    kernel: plain(attempt(() => probe.release())),
    cores: Number.isSafeInteger(cores) && cores > 0 ? cores : undefined,
    memory: memoryClass(attempt(() => probe.totalMemory())),
    nodeVersion: plain(attempt(() => probe.nodeVersion())),
    dshVersion: plain(attempt(() => probe.dshVersion())),
    user: plain(user?.name),
    uid: Number.isSafeInteger(user?.uid) ? user.uid : undefined,
    shell,
  }
}

// A workspace root that points into a DSH home is not something to announce.
const hiddenRoot = (root) => /(^|[\\/])\.dsh(-[\w-]+)?([\\/]|$)/.test(root)

/**
 * The text. Pure: the same facts, policy and fields give the same bytes. `policy` is the node's own
 * `remote-agent:node-policy` ({ roots, nodeId? }); `fields` is the allow-list (default: all).
 */
export function renderHostContext(facts = {}, { policy, fields = FIELDS } = {}) {
  const allowed = new Set(fields)
  const lines = []

  const nodeId = allowed.has('node') ? plain(policy?.nodeId, 80) : undefined
  const hostname = allowed.has('hostname') ? facts.hostname : undefined
  if (nodeId !== undefined && hostname !== undefined) lines.push(`- Node: ${nodeId} (hostname ${hostname})`)
  else if (nodeId !== undefined) lines.push(`- Node: ${nodeId}`)
  else if (hostname !== undefined) lines.push(`- Node: hostname ${hostname}`)

  if (allowed.has('os')) {
    const parts = [facts.os, [facts.platform, facts.arch].filter(Boolean).join(' ') || undefined, facts.kernel === undefined ? undefined : `kernel ${facts.kernel}`].filter(Boolean)
    if (parts.length > 0) lines.push(`- OS: ${parts.join(', ')}`)
  }

  const cpu = []
  if (allowed.has('cpu') && facts.cores !== undefined) cpu.push(`CPU: ${facts.cores} cores`)
  if (allowed.has('memory') && facts.memory !== undefined) cpu.push(`Memory: ${facts.memory}`)
  if (cpu.length > 0) lines.push(`- ${cpu.join('; ')}`)

  if (allowed.has('runtime')) {
    const runtime = [facts.nodeVersion === undefined ? undefined : `Node ${facts.nodeVersion}`, facts.dshVersion === undefined ? undefined : `DSH ${facts.dshVersion}`].filter(Boolean)
    if (runtime.length > 0) lines.push(`- Runtime: ${runtime.join(', ')}`)
  }

  const account = []
  if (allowed.has('account') && facts.user !== undefined) account.push(facts.uid === undefined ? facts.user : `${facts.user} (uid ${facts.uid})`)
  if (allowed.has('shell') && facts.shell !== undefined) account.push(`shell: ${facts.shell}`)
  if (account.length > 0) lines.push(`- Account: ${account.join('; ')}`)

  if (allowed.has('roots') && Array.isArray(policy?.roots)) {
    const roots = policy.roots.map(root => plain(root, 200)).filter(root => root !== undefined && !hiddenRoot(root))
    if (roots.length > 0) lines.push(`- Writable workspace roots: ${roots.join(', ')}`)
  }

  if (lines.length === 0) return ''
  return [HEADER, ...lines, FOOTER].join('\n')
}

// A bad value must not stop ds-bot from starting: this is an extra line of prompt, not something
// the rest depends on. Anything not understood reads as `off` ({ invalid: true } lets install say so).
function modeAndFields(config) {
  const value = config.hostContext ?? undefined
  if (value !== undefined && typeof value !== 'string' && (typeof value !== 'object' || Array.isArray(value))) return { mode: 'off', invalid: true }
  const mode = typeof value === 'string' ? value : value?.mode ?? 'auto'
  if (!MODES.includes(mode)) return { mode: 'off', invalid: true }
  const list = typeof value === 'object' && value !== null ? value.fields : undefined
  if (list !== undefined && (!Array.isArray(list) || list.some(name => !FIELDS.includes(name)))) return { mode: 'off', invalid: true }
  return { mode, fields: list ?? FIELDS }
}

export function install(rt) {
  const { ctx, config } = rt
  const { mode, fields, invalid } = modeAndFields(config)
  // Said once, without the value (a config can hold anything, a secret included).
  if (invalid) ctx.logger?.warn?.('ds-bot: hostContext is not valid (mode auto, on or off; fields from the documented list): the host environment is off')
  if (mode === 'off') return
  // `config.hostProbe` is a test seam (a YAML config cannot carry functions); the real machine otherwise.
  const probe = typeof config.hostProbe === 'object' && config.hostProbe !== null ? config.hostProbe : realProbe
  if (typeof ctx.systemPrompt?.context !== 'function') {
    if (mode === 'on') ctx.logger?.warn?.('ds-bot: host environment not added: no systemPrompt.context')
    return
  }

  const policyOf = () => {
    let policy
    try { policy = ctx.get?.(NODE_POLICY) } catch { policy = undefined }
    return policy !== null && typeof policy === 'object' ? policy : undefined
  }

  // Collected once, then the very same text for the life of the process (a node restart refreshes it).
  let text
  let warned = false
  const current = () => {
    if (text !== undefined) return text
    try {
      const policy = policyOf()
      // auto: only a worker (the process that has a node-policy). The service may come up after this
      // plugin, so this is decided when the text is asked for, not at install.
      if (mode === 'auto' && policy === undefined) return ''
      text = renderHostContext(collectHost(probe), { policy, fields })
      return text
    } catch (error) {
      // A prompt context that throws would fail every turn of every session on this machine.
      if (!warned) { warned = true; ctx.logger?.warn?.('ds-bot: host environment left out: %s', error?.message ?? String(error)) }
      return ''
    }
  }

  ctx.effect(() => ctx.systemPrompt.context({ name: CONTEXT_NAME, order: CONTEXT_ORDER, interpolate: false, text: current }), 'ds-bot: host environment')
}
