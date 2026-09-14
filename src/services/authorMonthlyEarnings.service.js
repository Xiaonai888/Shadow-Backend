import { supabase } from '../config/supabase.js'

function positiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)

  if (!Number.isFinite(number) || number < 1) {
    return fallback
  }

  return Math.min(number, max)
}

export async function getAuthorMonthlyEarningsPage({
  userId,
  page = 1,
  limit = 20,
} = {}) {
  const normalizedUserId = String(userId || '').trim()

  if (!normalizedUserId) {
    const error = new Error('Unauthorized')
    error.statusCode = 401
    throw error
  }

  const normalizedPage = positiveInt(page, 1, 10000)
  const normalizedLimit = positiveInt(limit, 20, 50)

  const { data, error } = await supabase.rpc(
    'get_author_monthly_earnings_v1',
    {
      p_user_id: normalizedUserId,
      p_page: normalizedPage,
      p_limit: normalizedLimit,
    }
  )

  if (error) throw error

  return data || {
    ok: true,
    has_author_page: false,
    source: 'author_earnings',
    summary: {
      total_months: 0,
      total_paid_diamonds: 0,
      total_author_diamonds: 0,
      total_author_usd: 0,
      total_unlocks: 0,
    },
    items: [],
    pagination: {
      page: normalizedPage,
      limit: normalizedLimit,
      total: 0,
      total_pages: 0,
      has_prev: normalizedPage > 1,
      has_next: false,
    },
  }
}
