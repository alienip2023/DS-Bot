// Where a Bot's portable state lives on this machine (the step journal AC writes per turn).
// Same rule as AC's lib/persist/bots-root.js, so both plugins look in the same place:
// DSH_BOTS_DIR, else ~/.dsh/bots. Resolved per call so a test can point it elsewhere.
import { homedir } from 'node:os'
import { join } from 'node:path'

export function botsRoot() {
  const override = process.env.DSH_BOTS_DIR
  return typeof override === 'string' && override !== '' ? override : join(homedir(), '.dsh', 'bots')
}
