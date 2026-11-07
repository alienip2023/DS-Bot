// Pure utility: normalise the response from botCreateTargets into a plain array.
// Kept in its own file so it can be tested without React.
export function pickTargets(res) {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.value)) return res.value  // 兼容旧外壳
  return []
}
