// The memory backends a Bot may choose, as the settings and create screens offer them.
// `federation` is only offered where this machine is a node joined to a hub: a Bot on
// the hub's own machine has no frame to send, so the host refuses that backend (P10).
export function memoryBackendChoices({ federate = false } = {}) {
  const choices = [
    { value: 'auto', label: 'Auto Detect' },
    { value: 'mneme', label: 'dsh-mneme (Force)' },
    { value: 'file', label: 'File Memory (Force)' },
  ]
  if (federate) choices.push({ value: 'federation', label: 'Federated (hub nodes)' })
  choices.push({ value: 'none', label: 'Disabled' })
  return choices
}

// Whether the screen should offer the federated backend at all.
export const canFederate = roster => roster?.memoryFederation?.canFederate === true

// Whether the details drawer shows the hub's federated memory at all: a machine that
// joined a hub has three layers to show, a plain local install has none.
export const canShowMemoryHub = roster => roster?.memoryFederation?.hub === true
