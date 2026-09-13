const stores = new Map()

function getClientIp(req) {
  const cfIp =
    req.headers['cf-connecting-ip']
  const forwardedFor =
    req.headers['x-forwarded-for']

  if (cfIp) {
    return String(cfIp).trim()
  }

  if (forwardedFor) {
    return String(forwardedFor)
      .split(',')[0]
      .trim()
  }

  return (
    req.socket?.remoteAddress ||
    'unknown'
  )
}

function getIdentity(
  req,
  identity
) {
  if (
    typeof identity !== 'function'
  ) {
    return getClientIp(req)
  }

  try {
    const value = String(
      identity(req) || ''
    )
      .trim()
      .slice(0, 200)

    return (
      value ||
      getClientIp(req)
    )
  } catch {
    return getClientIp(req)
  }
}

export function createRateLimit({
  key = 'global',
  windowMs = 60000,
  max = 30,
  message =
    'Too many requests. Please try again later.',
  identity,
}) {
  if (!stores.has(key)) {
    stores.set(key, new Map())
  }

  const store = stores.get(key)

  return function rateLimit(
    req,
    res,
    next
  ) {
    const now = Date.now()
    const identityValue =
      getIdentity(req, identity)
    const path =
      req.originalUrl
        .split('?')[0]
    const id =
      `${identityValue}:${req.method}:${path}`
    const current =
      store.get(id)

    if (
      !current ||
      current.resetAt <= now
    ) {
      store.set(id, {
        count: 1,
        resetAt:
          now + windowMs,
      })
      return next()
    }

    current.count += 1

    if (current.count > max) {
      const retryAfter =
        Math.max(
          1,
          Math.ceil(
            (
              current.resetAt -
              now
            ) / 1000
          )
        )

      res.setHeader(
        'Retry-After',
        String(retryAfter)
      )

      return res
        .status(429)
        .json({
          ok: false,
          message,
        })
    }

    return next()
  }
}

setInterval(() => {
  const now = Date.now()

  for (
    const store of stores.values()
  ) {
    for (
      const [
        id,
        value,
      ] of store.entries()
    ) {
      if (
        value.resetAt <= now
      ) {
        store.delete(id)
      }
    }
  }
}, 60000).unref()
