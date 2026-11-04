/** Reuses unchanged JSON-shaped values, including records moved within an ID-keyed list. */
export function reuseEqual<T>(previous: T | undefined, next: T): T {
  if (Object.is(previous, next)) return previous as T
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next
    const byId = new Map<string, unknown>()
    for (const item of previous) if (item && typeof item.id === 'string') byId.set(item.id, item)
    let unchanged = previous.length === next.length
    const items = next.map((item, index) => {
      const old = item && typeof item.id === 'string' ? byId.get(item.id) : previous[index]
      const reused = reuseEqual(old, item)
      if (reused !== previous[index]) unchanged = false
      return reused
    })
    return (unchanged ? previous : items) as T
  }
  if (Array.isArray(previous)) return next
  const old = previous as Record<string, unknown>
  const value = next as Record<string, unknown>
  const keys = Object.keys(value)
  let unchanged = Object.keys(old).length === keys.length
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    result[key] = reuseEqual(old[key], value[key])
    if (!Object.hasOwn(old, key) || result[key] !== old[key]) unchanged = false
  }
  return (unchanged ? previous : result) as T
}
