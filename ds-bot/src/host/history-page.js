// A Session event can expand into several display rows. Re-read the same
// bounded source page while delivering its remaining rows, then advance parts.
export function limitHistoryRows(items, next, events, part, cursor, limit) {
  if (limit === undefined) return { items, cursor: next }
  const skip = cursor?.skip ?? 0
  const end = Math.max(0, items.length - skip)
  const start = Math.max(0, end - limit)
  return {
    items: items.slice(start, end),
    cursor: start > 0 && events.length > 0
      ? { part, beforeSeq: cursor?.beforeSeq ?? events.at(-1).seq + 1, skip: items.length - start }
      : next,
  }
}
