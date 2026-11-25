// What DSH does when it opens a stored session (the check `SessionFormatError: stored log is corrupt` comes from): the
// log is replayed row by row and its turn/step relationships are checked. Writing never checks them, so a session
// can be written that cannot be opened again. Throws the loader's own error.
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { assertReleasedV4Relationships, assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'

export function assertStoredLogLoads(session) {
  const restore = sessionFormatCatalog.createRestore({ type: 'session', delegationDepth: 0, agentPreset: 'standard', ...session.header }, { recovery: 'strict', validation: 'transformed' })
  for (const row of session.snapshotEvents()) {
    assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES)
    restore.decodeRow(row)
  }
  assertReleasedV4Relationships(restore.finish(), KNOWN_SESSION_EVENT_TYPES)
}
