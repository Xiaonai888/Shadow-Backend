import { supabase } from '../config/supabase.js'

const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 200
const PERIODS = new Set(['today', 'week', 'last7', 'last30', 'month', 'year', 'custom', 'all'])
const cache = new Map()

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function getFilters(query) {
  const period = typeof query.period === 'string' ? query.period.trim().toLowerCase() : 'month'
  if (!PERIODS.has(period)) return null
  if (period !== 'custom') return { period, from: null, to: null }
  const from = query.from
  const to = query.to
  if (!validDate(from) || !validDate(to) || from > to) return null
  return { period, from, to }
}

function getCambodiaToday() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function pruneCache() {
  const now = Date.now()
  for (const [key, value] of cache) {
    if (!value.pending && value.expiresAt <= now) cache.delete(key)
  }
  if (cache.size <= MAX_CACHE_ENTRIES) return
  for (const [key, value] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES) break
    if (!value.pending) cache.delete(key)
  }
}

async function createReport(userId, filters) {
  const { data, error } = await supabase.rpc('get_author_income_report_export_guarded_v1', {
    p_user_id: userId,
    p_period: filters.period,
    p_from: filters.from,
    p_to: filters.to,
  })
  if (error) throw error
  if (!data || data.ok !== true || !Array.isArray(data.rows) || !data.totals || data.rows.length > 500) {
    throw new Error('INVALID_REPORT_DATA')
  }
  return { ...data, generated_at: new Date().toISOString(), max_rows: 500 }
}

export async function getMyAuthorIncomeReportExport(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const userId = String(req.user?.user_id || '').trim()
  if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })

  const filters = getFilters(req.query || {})
  if (!filters) return res.status(400).json({ ok: false, message: 'Invalid report period or date range' })

  const dateKey = ['today', 'week', 'last7', 'last30', 'month', 'year'].includes(filters.period)
    ? getCambodiaToday()
    : ''
  const key = JSON.stringify([userId, filters.period, filters.from, filters.to, dateKey])
  const existing = cache.get(key)
  if (existing?.value && existing.expiresAt > Date.now()) {
    cache.delete(key)
    cache.set(key, existing)
    return res.status(200).json(existing.value)
  }

  const entry = existing?.pending ? existing : {
    pending: createReport(userId, filters),
    value: null,
    expiresAt: 0,
  }
  cache.set(key, entry)
  try {
    const report = await entry.pending
    if (!entry.value) {
      entry.value = report
      entry.expiresAt = Date.now() + CACHE_TTL_MS
      entry.pending = null
    }
    pruneCache()
    return res.status(200).json(entry.value)
  } catch (error) {
    if (cache.get(key) === entry) cache.delete(key)
    const limitMatch = String(error?.message || '').match(/^REPORT_LIMIT_REACHED:(\d+)/)
    if (limitMatch) {
      const retryAfter = Math.max(1, Number(limitMatch[1]))
      res.set('Retry-After', String(retryAfter))
      return res.status(429).json({ ok: false, code: 'REPORT_LIMIT_REACHED', retry_after_seconds: retryAfter, message: 'You can generate 10 new income reports per hour. Please retry later.' })
    }
    console.error('AUTHOR INCOME REPORT EXPORT ERROR:', error)
    return res.status(503).json({ ok: false, message: 'Could not prepare a verified income report' })
  }
}
