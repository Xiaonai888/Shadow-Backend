import { supabase } from '../config/supabase.js'

const ALLOWED_STATUSES = new Set([
  'all',
  'pending',
  'available',
  'paid',
  'unknown',
])

const ALLOWED_SORTS = new Set([
  'author_earned_desc',
  'paid_diamonds_desc',
  'platform_earned_desc',
  'transactions_desc',
  'latest_desc',
])

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max)
}

function cleanText(value, max = 80) {
  return String(value || '').trim().slice(0, max)
}

function parseBoundary(value, endExclusive = false) {
  const text = cleanText(value, 64)

  if (!text) return null

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const date = new Date(
    dateOnly ? `${text}T00:00:00+07:00` : text
  )

  if (Number.isNaN(date.getTime())) {
    const error = new Error('Invalid date range')
    error.statusCode = 400
    throw error
  }

  if (dateOnly && endExclusive) {
    date.setTime(date.getTime() + 24 * 60 * 60 * 1000)
  }

  return date.toISOString()
}

export async function getAdminAuthorIncome(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 50)
    const search = cleanText(req.query.q)
    const shareSource = cleanText(req.query.share_source, 64).toLowerCase()
    const statusRaw = cleanText(req.query.status, 24).toLowerCase() || 'all'
    const sortRaw = cleanText(req.query.sort, 40).toLowerCase() || 'author_earned_desc'
    const status = ALLOWED_STATUSES.has(statusRaw) ? statusRaw : 'all'
    const sort = ALLOWED_SORTS.has(sortRaw) ? sortRaw : 'author_earned_desc'
    const from = parseBoundary(req.query.from, false)
    const to = parseBoundary(req.query.to, true)

    const { data, error } = await supabase.rpc(
      'get_admin_author_income_v1',
      {
        p_page: page,
        p_limit: limit,
        p_search: search,
        p_from: from,
        p_to: to,
        p_share_source: shareSource,
        p_status: status,
        p_sort: sort,
      }
    )

    if (error) throw error

    return res.status(200).json(
      data || {
        ok: true,
        source: 'author_earnings',
        summary: {
          paid_diamonds: 0,
          net_paid_diamonds: 0,
          author_earned_diamonds: 0,
          platform_earned_diamonds: 0,
          author_earnings_usd: 0,
          platform_income_usd: 0,
          author_net_payout_usd: 0,
          withholding_usd: 0,
          pending_payout_usd: 0,
          paid_payout_usd: 0,
          transaction_count: 0,
          author_count: 0,
          reconciliation_difference_diamonds: 0,
        },
        items: [],
        pagination: {
          page,
          limit,
          total: 0,
          total_pages: 0,
          has_prev: page > 1,
          has_next: false,
        },
      }
    )
  } catch (error) {
    console.error('GET ADMIN AUTHOR INCOME ERROR:', error)

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to load author income',
      })
  }
}
