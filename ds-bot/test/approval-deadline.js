// Test-owned deadlines for tests that open approvals. A test that waits on an approval nobody
// answers must fail by its own bound, never hang the runner or lean on --test-force-exit.

export function withDeadline(promise, ms, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no settle within ${ms} ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// Every signal handed to an approval request is registered here; cleanup() aborts them all,
// so approvals still pending settle as 'cancelled'.
export function deadlineScope() {
  const controllers = []
  return {
    signal() { const controller = new AbortController(); controllers.push(controller); return controller.signal },
    cleanup() { for (const controller of controllers) controller.abort() },
  }
}
