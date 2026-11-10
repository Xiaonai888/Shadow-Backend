const MAX_ENTRIES = 300
const DEFAULT_TTL_MS = 30 * 60 * 1000
const entries = new Map()

function trimEntries(now) {
  for (const [key, entry] of entries) {
    if (!entry.pending && entry.expiresAt <= now) entries.delete(key)
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export async function readStudioChannelCache({ ownerId, segment, ttlMs = DEFAULT_TTL_MS }, loader) {
  if (!ownerId || !segment || typeof loader !== 'function') {
    throw new TypeError('Invalid Studio channel cache request.')
  }

  const key = `${ownerId}:${segment}`
  const now = Date.now()
  const current = entries.get(key)

  if (current && (current.pending || current.expiresAt > now)) {
    entries.delete(key)
    entries.set(key, current)
    return { value: await (current.pending || current.value), cached: true }
  }

  if (current) entries.delete(key)

  const lifetime = Number.isFinite(ttlMs) ? Math.max(1000, Math.min(ttlMs, 6 * 60 * 60 * 1000)) : DEFAULT_TTL_MS
  const entry = { pending: null, value: null, expiresAt: now + lifetime }
  const pending = Promise.resolve().then(loader)
  entry.pending = pending
  entries.set(key, entry)
  trimEntries(now)

  try {
    const value = await pending
    if (entries.get(key) === entry) {
      entry.value = value
      entry.pending = null
      entry.expiresAt = Date.now() + lifetime
    }
    return { value, cached: false }
  } catch (error) {
    if (entries.get(key) === entry) entries.delete(key)
    throw error
  }
}

export function invalidateStudioChannelCache(ownerId) {
  if (!ownerId) return
  const prefix = `${ownerId}:`
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
}
