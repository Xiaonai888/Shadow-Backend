import { getAuthorMonthlyEarningsPage } from '../services/authorMonthlyEarnings.service.js'
import { serveAuthorCachedJson } from '../services/authorRequestCache.service.js'

function positiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)

  if (!Number.isFinite(number) || number < 1) {
    return fallback
  }

  return Math.min(number, max)
}

async function getMyAuthorMonthlyEarningsUncached(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const page = positiveInt(req.query?.page, 1, 10000)
    const limit = positiveInt(req.query?.limit, 20, 50)

    const data = await getAuthorMonthlyEarningsPage({
      userId,
      page,
      limit,
    })

    return res.status(200).json(data)
  } catch (error) {
    console.error('GET MY AUTHOR MONTHLY EARNINGS ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.statusCode === 400
          ? error.message
          : 'Failed to load monthly earnings',
    })
  }
}

export async function getMyAuthorMonthlyEarnings(req, res) {
  if (!req.user?.user_id) {
    return res.status(401).json({
      ok: false,
      message: 'Unauthorized',
    })
  }

  const page = positiveInt(req.query?.page, 1, 10000)
  const limit = positiveInt(req.query?.limit, 20, 50)

  return serveAuthorCachedJson({
    req,
    res,
    namespace: 'author-monthly-earnings',
    ttlMs: 60 * 1000,
    variant: {
      page,
      limit,
    },
    handler: getMyAuthorMonthlyEarningsUncached,
  })
}
