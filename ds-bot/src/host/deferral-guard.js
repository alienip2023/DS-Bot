const DEFERRAL = /今夜|明早|今晚|\d{1,2}[点时]\d{1,2}分|\b(?:wait\s+until|tomorrow\s+morning|tonight)\b/i

export function detectDeferral(text) {
  return typeof text === 'string' ? (DEFERRAL.exec(text)?.[0] ?? null) : null
}
