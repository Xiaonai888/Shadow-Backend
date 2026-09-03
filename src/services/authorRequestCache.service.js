const cache = new Map()

const MAX_CACHE_ENTRIES = 1000
const STALE_ENTRY_GRACE_MS = 10 * 60 * 1000

function normalizeUserId(req) {
  return String(
    req?.user?.user_id ||
      req?.user?.id ||
      ''
  ).trim()
}

function normalizeVariant(value) {
  if (value === null || value === undefined) return ''

  if (typeof value === 'string') {
    return value.trim()
  }

  return JSON.stringify(value)
}

function buildKey(namespace, userId, variant) {
  return [
    String(namespace || '').trim(),
    String(userId || '').trim(),
    normalizeVariant(variant),
  ].join(':')
}

function getEntry(key) {
  let entry = cache.get(key)

  if (!entry) {
    entry = {
      value: null,
      expiresAt: 0,
      request: null,
      lastAccessAt: Date.now(),
    }
    cache.set(key, entry)
  }

  entry.lastAccessAt = Date.now()
  return entry
}

function pruneCache(now = Date.now()) {
  if (cache.size <= MAX_CACHE_ENTRIES) return

  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES) break

    if (
      !entry.request &&
      entry.expiresAt < now &&
      now - entry.lastAccessAt > STALE_ENTRY_GRACE_MS
    ) {
      cache.delete(key)
    }
  }
}

function createCapturedResponse() {
  let statusCode = 200
  let body
  let bodySent = false
  const headers = {}

  const captured = {
    status(code) {
      const nextCode = Number(code)

      if (Number.isInteger(nextCode)) {
        statusCode = nextCode
      }

      return captured
    },

    set(field, value) {
      if (
        field &&
        typeof field === 'object' &&
        !Array.isArray(field)
      ) {
        for (const [key, item] of Object.entries(field)) {
          headers[String(key)] = item
        }

        return captured
      }

      if (field) {
        headers[String(field)] = value
      }

      return captured
    },

    header(field, value) {
      return captured.set(field, value)
    },

    json(value) {
      body = value
      bodySent = true
      return value
    },

    send(value) {
      body = value
      bodySent = true
      return value
    },

    get result() {
      return {
        statusCode,
        headers,
        body,
        bodySent,
      }
    },
  }

  return captured
}

function replayResult(res, result) {
  for (const [key, value] of Object.entries(
    result.headers || {}
  )) {
    res.set(key, value)
  }

  res.set('Cache-Control', 'private, no-store')

  return res
    .status(result.statusCode || 200)
    .json(result.body)
}

async function executeHandler(req, handler) {
  const captured = createCapturedResponse()

  await handler(req, captured)

  const result = captured.result

  if (!result.bodySent) {
    throw new Error(
      'Cached author handler completed without a JSON response'
    )
  }

  return result
}

export async function serveAuthorCachedJson({
  req,
  res,
  namespace,
  ttlMs,
  variant = '',
  handler,
}) {
  if (typeof handler !== 'function') {
    throw new Error('Cached author handler is required')
  }

  const userId = normalizeUserId(req)
  const ttl = Math.max(0, Number(ttlMs || 0))

  if (!userId || !ttl) {
    return handler(req, res)
  }

  const key = buildKey(
    namespace,
    userId,
    variant
  )
  const entry = getEntry(key)
  const now = Date.now()

  if (
    entry.value &&
    now < entry.expiresAt
  ) {
    return replayResult(res, entry.value)
  }

  if (!entry.request) {
    entry.request = executeHandler(req, handler)
      .then((result) => {
        if (
          result.statusCode >= 200 &&
          result.statusCode < 300
        ) {
          entry.value = result
          entry.expiresAt = Date.now() + ttl
        }

        return result
      })
      .finally(() => {
        entry.request = null
        pruneCache()
      })
  }

  const result = await entry.request

  return replayResult(res, result)
}

export function invalidateAuthorRequestCache({
  userId,
  namespace = '',
} = {}) {
  const normalizedUserId = String(
    userId || ''
  ).trim()
  const normalizedNamespace = String(
    namespace || ''
  ).trim()

  if (!normalizedUserId && !normalizedNamespace) {
    return
  }

  for (const key of cache.keys()) {
    const [
      keyNamespace,
      keyUserId,
    ] = key.split(':')

    if (
      normalizedUserId &&
      keyUserId !== normalizedUserId
    ) {
      continue
    }

    if (
      normalizedNamespace &&
      keyNamespace !== normalizedNamespace
    ) {
      continue
    }

    cache.delete(key)
  }
}
