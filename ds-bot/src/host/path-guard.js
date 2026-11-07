/**
 * Path boundary guard: checks whether `resolved` is inside (or equal to) `root`.
 * Uses the provided `sep` character and optionally ignores case (for win32).
 *
 * @param {string} resolved - The already-resolved candidate path.
 * @param {string} root - The already-resolved root path.
 * @param {{ sep?: string, ignoreCase?: boolean }} options
 * @returns {boolean}
 */
export function isInsideRoot(resolved, root, { sep = '/', ignoreCase = false } = {}) {
  const r = ignoreCase ? resolved.toLowerCase() : resolved
  const ro = ignoreCase ? root.toLowerCase() : root
  if (r === ro) return true
  return r.startsWith(ro + sep)
}
