import { supabase } from '../config/supabase.js'

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

function positiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)

  if (!Number.isFinite(number) || number < 1) {
    return fallback
  }

  return Math.min(number, max)
}

export function getCambodiaMonthKey(date = new Date()) {
  const local = new Date(date.getTime() + CAMBODIA_OFFSET_MS)
  const year = local.getUTCFullYear()
  const month = String(local.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

export async function getAuthorTopSupportersPage({
  userId,
  month = getCambodiaMonthKey(),
  page = 1,
  limit = 20,
} = {}) {
  const normalizedUserId = String(userId || '').trim()
  const normalizedMonth = String(month || '').trim()

  if (!normalizedUserId) {
    const error = new Error('Unauthorized')
    error.statusCode = 401
    throw error
  }

  if (!MONTH_PATTERN.test(normalizedMonth)) {
    const error = new Error('Invalid month')
    error.statusCode = 400
    throw error
  }

  const normalizedPage = positiveInt(page, 1, 10000)
  const normalizedLimit = positiveInt(limit, 20, 50)

  const { data, error } = await supabase.rpc(
    'get_author_top_supporters_v1',
    {
      p_user_id: normalizedUserId,
      p_month: normalizedMonth,
      p_page: normalizedPage,
      p_limit: normalizedLimit,
    }
  )

  if (error) throw error

  return data || {
    ok: true,
    has_author_page: false,
    month: normalizedMonth,
    source: 'author_earnings',
    summary: {
      total_supporters: 0,
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
