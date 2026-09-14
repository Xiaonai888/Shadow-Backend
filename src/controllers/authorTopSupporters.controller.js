import {
  getAuthorTopSupportersPage,
  getCambodiaMonthKey,
} from '../services/authorTopSupporters.service.js'
import { serveAuthorCachedJson } from '../services/authorRequestCache.service.js'

function positiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)

  if (!Number.isFinite(number) || number < 1) {
    return fallback
  }

  return Math.min(number, max)
}

async function getMyAuthorTopSupportersUncached(req, res) {
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
    const month = getCambodiaMonthKey()

    const data = await getAuthorTopSupportersPage({
      userId,
      month,
      page,
      limit,
    })

    return res.status(200).json(data)
  } catch (error) {
    console.error('GET MY AUTHOR TOP SUPPORTERS ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.statusCode === 400
          ? error.message
          : 'Failed to load top supporters',
    })
  }
}

export async function getMyAuthorTopSupporters(req, res) {
  if (!req.user?.user_id) {
    return res.status(401).json({
      ok: false,
      message: 'Unauthorized',
    })
  }

  const page = positiveInt(req.query?.page, 1, 10000)
  const limit = positiveInt(req.query?.limit, 20, 50)
  const month = getCambodiaMonthKey()

  return serveAuthorCachedJson({
    req,
    res,
    namespace: 'author-top-supporters',
    ttlMs: 30 * 1000,
    variant: {
      month,
      page,
      limit,
    },
    handler: getMyAuthorTopSupportersUncached,
  })
}
