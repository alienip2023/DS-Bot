const markers = /\[\s*(?:information\s+only\s*\]|provenance\s*:)/gi
const markerEscapes = new RegExp(String.raw`\\+(?=${markers.source})`, 'gi')

export function escapeProvenance(text) {
  return String(text).replace(markers, match => `\\${match}`)
}

export function labelInformationOnly(text) {
  // Markdown consumes a lone backslash before a bracket. Encode each literal
  // backslash and escape the bracket too, so the marker stays visibly escaped.
  const body = escapeProvenance(text).replace(markerEscapes, slashes => '\\'.repeat(2 * slashes.length + 1))
  return `[information only] ${body}`
}
