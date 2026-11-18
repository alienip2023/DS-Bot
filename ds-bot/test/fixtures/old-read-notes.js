// Verbatim readNotes from 03fd913c5360dc4e2ab1f424b2ca159bd57235ba:ds-bot/src/host/resume.js (lines 107-115),
// kept as the reference old reader for the DS-1 compatibility check. Do not edit.
import { readFileSync } from 'node:fs'

export const readNotes = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    return { turns: object(parsed?.turns), queued: object(parsed?.queued) }
  } catch {
    return { turns: {}, queued: {} }
  }
}
