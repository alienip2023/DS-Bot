// Spawned by approval-persistence.test.js (not collected: not *.test.js in test/).
// argv: <home> <point>   point = after-temp-write | before-rename | after-rename
// Loads a store and the approvals module on <home>, saves a baseline, then answers one
// approval with fs hooks armed so this process SIGKILLs itself at <point>. Prints
//   BASE <json-of-the-baseline-file>   once the baseline is on disk
//   ACK                                if the answer resolved (it must not, at any point)
// The hooks wrap node:fs/promises in this child only; no product file is edited.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { install as installStore } from '../../src/host/store.js'
import { install as installApprovals } from '../../src/host/approvals.js'

const [home, point] = process.argv.slice(2)
// Synchronous, so a line written just before the SIGKILL is not lost in a pipe buffer.
const say = line => fs.writeSync(1, `${line}\n`)
const statePath = join(home, 'state.json')
const handlers = []
const rt = {
  home, statePath,
  ctx: { logger: { warn() {} }, effect() {}, on: (name, h) => { if (name === 'approval/request') handlers.push(h) } },
  autoRoomName: () => 'Room', retitleRoom: async () => {}, warn() {},
}
installStore(rt)
installApprovals(rt)
await rt.load()
rt.state.prefs.marker = 'baseline'
await rt.save({ required: true })
say(`BASE ${JSON.stringify(await fsp.readFile(statePath, 'utf8'))}`)

const die = () => process.kill(process.pid, 'SIGKILL')
const { writeFile, rename } = fsp
fsp.writeFile = async (path, ...rest) => {
  const done = await writeFile(path, ...rest)
  if (point === 'after-temp-write' && String(path).startsWith(`${statePath}.`) && String(path).endsWith('.tmp')) die()
  return done
}
fsp.rename = async (from, to) => {
  if (to === statePath) say('RENAME')
  if (point === 'before-rename' && to === statePath) die()
  const done = await rename(from, to)
  if (point === 'after-rename' && to === statePath) die()
  return done
}
syncBuiltinESMExports()

rt.chatOwners.set('sess', 'bot1')
void handlers[0]({ agent: { session: { id: 'sess' } }, toolName: 'shell', callId: 'c1', reason: 'r', signal: new AbortController().signal }, () => new Promise(() => {}))
const [entry] = rt.approvalsView()
say(`FP ${entry.fingerprint}`)
await rt.answerApproval(entry.id, 'allow', { sessionId: entry.sessionId, fingerprint: entry.fingerprint })
say('ACK')
