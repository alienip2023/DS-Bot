// Pure helper: label text for a joined Bot's sidebar row.
// Knife: remove the tFn call → sidebar label test fails.
export function joinedMachineLabel(worker, tFn) {
  const host = worker.hostname || worker.nodeId
  return tFn('Running on {host}', { host })
}
