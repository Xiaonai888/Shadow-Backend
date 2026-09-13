import { supabase } from '../config/supabase.js'
import { serveAuthorCachedJson } from '../services/authorRequestCache.service.js'

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const ALLOWED_RANGES = new Set(['today', 'last7', 'last30', 'custom'])

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max)
}

function cambodiaDayStart(date = new Date()) {
  const local = new Date(date.getTime() + CAMBODIA_OFFSET_MS)
  return new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate()
    ) - CAMBODIA_OFFSET_MS
  )
}

function parseLocalDate(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const test = new Date(Date.UTC(year, month - 1, day))

  if (
    test.getUTCFullYear() !== year ||
    test.getUTCMonth() !== month - 1 ||
    test.getUTCDate() !== day
  ) {
    return null
  }

  return new Date(
    Date.UTC(year, month - 1, day) - CAMBODIA_OFFSET_MS
  )
}

function dateText(date) {
  const local = new Date(date.getTime() + CAMBODIA_OFFSET_MS)
  return [
    local.getUTCFullYear(),
    String(local.getUTCMonth() + 1).padStart(2, '0'),
    String(local.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function buildRange(query = {}) {
  const range = String(query.range || 'last30').trim().toLowerCase()

  if (!ALLOWED_RANGES.has(range)) {
    const error = new Error('Invalid recent earnings range')
    error.statusCode = 400
    throw error
  }

  const todayStart = cambodiaDayStart()
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS)
  const earliestStart = new Date(todayStart.getTime() - 29 * DAY_MS)

  if (range === 'today') {
    return { range, start: todayStart, end: tomorrowStart }
  }

  if (range === 'last7') {
    return {
      range,
      start: new Date(todayStart.getTime() - 6 * DAY_MS),
      end: tomorrowStart,
    }
  }

  if (range === 'last30') {
    return { range, start: earliestStart, end: tomorrowStart }
  }

  const from = parseLocalDate(query.from)
  const to = parseLocalDate(query.to)

  if (!from || !to) {
    const error = new Error('Custom range requires valid from and to dates')
    error.statusCode = 400
    throw error
  }

  if (
    from.getTime() < earliestStart.getTime() ||
    to.getTime() > todayStart.getTime()
  ) {
    const error = new Error('Recent Earnings only supports the latest 30 days')
    error.statusCode = 400
    throw error
  }

  if (from.getTime() > to.getTime()) {
    const error = new Error('From date cannot be after to date')
    error.statusCode = 400
    throw error
  }

  const inclusiveDays =
    Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1

  if (inclusiveDays > 30) {
    const error = new Error('Custom range cannot exceed 30 days')
    error.statusCode = 400
    throw error
  }

  return {
    range,
    start: from,
    end: new Date(to.getTime() + DAY_MS),
  }
}

function normalizeRequest(req) {
  const dateRange = buildRange(req.query)

  return {
    page: toPositiveInt(req.query?.page, 1, 10000),
    limit: toPositiveInt(req.query?.limit, 20, 50),
    range: dateRange.range,
    start: dateRange.start.toISOString(),
    end: dateRange.end.toISOString(),
    from: dateText(dateRange.start),
    to: dateText(new Date(dateRange.end.getTime() - DAY_MS)),
  }
}

async function getMyAuthorRecentEarningsUncached(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const normalized =
      req.recentEarningsQuery || normalizeRequest(req)

    const { data, error } = await supabase.rpc(
      'get_author_recent_earnings_v1',
      {
        p_user_id: userId,
        p_start: normalized.start,
        p_end: normalized.end,
        p_page: normalized.page,
        p_limit: normalized.limit,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ...(data || {
        ok: true,
        has_author_page: false,
        source: 'author_earnings',
        summary: {
          total_transactions: 0,
          total_paid_diamonds: 0,
          total_author_diamonds: 0,
          total_author_usd: 0,
        },
        items: [],
        pagination: {
          page: normalized.page,
          limit: normalized.limit,
          total: 0,
          total_pages: 0,
          has_prev: normalized.page > 1,
          has_next: false,
        },
      }),
      filter: {
        range: normalized.range,
        from: normalized.from,
        to: normalized.to,
      },
    })
  } catch (error) {
    console.error('GET MY AUTHOR RECENT EARNINGS ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.statusCode === 400
          ? error.message
          : 'Failed to load recent earnings',
    })
  }
}

export async function getMyAuthorRecentEarnings(req, res) {
  try {
    if (!req.user?.user_id) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const normalized = normalizeRequest(req)
    req.recentEarningsQuery = normalized

    return serveAuthorCachedJson({
      req,
      res,
      namespace: 'author-recent-earnings',
      ttlMs: 15 * 1000,
      variant: {
        page: normalized.page,
        limit: normalized.limit,
        range: normalized.range,
        from: normalized.from,
        to: normalized.to,
      },
      handler: getMyAuthorRecentEarningsUncached,
    })
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      ok: false,
      message:
        error.message || 'Invalid recent earnings request',
    })
  }
}
