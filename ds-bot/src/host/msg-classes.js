// Two named message classes replace the per-role skip list.
// control: never rendered, never queued. visible: always rendered, always queued.
const CONTROL_ROLES = new Set(['kickoff', 'continue', 'update'])

export function classify(role) {
  return CONTROL_ROLES.has(role) ? 'control' : 'visible'
}
