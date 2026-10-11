import { supabase } from '../config/supabase.js'

const periodCache = new Map()
const pendingPeriods = new Map()
const MAX_CACHE_ITEMS = 160
const LIVE_TTL_MS = 2 * 60 * 1000
const HISTORY_TTL_MS = 5 * 60 * 1000

const cambodiaDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Phnom_Penh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function getCambodiaDay() {
  const parts = Object.fromEntries(
    cambodiaDayFormatter.formatToParts(new Date()).map((part) => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function clearExpiredCache() {
  const now = Date.now()
  for (const [key, entry] of periodCache) {
    if (entry.expiresAt <= now) periodCache.delete(key)
  }
  while (periodCache.size >= MAX_CACHE_ITEMS) {
    periodCache.delete(periodCache.keys().next().value)
  }
}

async function loadReaderPeriod({ scope, period, from, to, order, sort, page, search, refresh, today }) {
  const key = JSON.stringify([today, scope, period, from, to, order, sort, page, search])
  const cached = periodCache.get(key)

  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value
  if (pendingPeriods.has(key)) return pendingPeriods.get(key)

  const request = (async () => {
    const { data, error } = await supabase.rpc('get_admin_reader_activity_period_v1', {
      p_scope: scope,
      p_period: period,
      p_custom_from: from || null,
      p_custom_to: to || null,
      p_order: order,
      p_sort: sort,
      p_page: page,
      p_search: search,
    })

    if (error) throw error
    if (!data || data.ok !== true || !Array.isArray(data.items)) {
      throw new Error('Invalid reader period response')
    }

    const ttl = data.period_in_progress ? LIVE_TTL_MS : HISTORY_TTL_MS
    clearExpiredCache()
    periodCache.set(key, { value: data, expiresAt: Date.now() + ttl })
    return data
  })()

  pendingPeriods.set(key, request)
  try {
    return await request
  } finally {
    if (pendingPeriods.get(key) === request) pendingPeriods.delete(key)
  }
}

export async function getAdminReaderPeriod(req, res) {
  res.set('Cache-Control', 'private, no-store')

  try {
    const scope = String(req.query.scope || 'story').trim().toLowerCase()
    const period = String(req.query.period || 'today').trim().toLowerCase()
    const order = String(req.query.order || 'top').trim().toLowerCase()
    const sort = String(req.query.sort || 'count').trim().toLowerCase()
    const search = String(req.query.q || '').trim().replace(/[%_,()]/g, ' ').slice(0, 100)
    const pageNumber = Number(req.query.page || 1)
    const from = String(req.query.from || '').trim()
    const to = String(req.query.to || '').trim()
    const refresh = String(req.query.refresh || '') === '1'
    const today = getCambodiaDay()

    if (!['story', 'reader'].includes(scope) ||
        !['today', 'yesterday', '7d', 'week', 'month', 'year', 'custom'].includes(period) ||
        !['top', 'low'].includes(order) || !['count', 'change', 'views'].includes(sort)) {
      return res.status(400).json({ ok: false, message: 'Invalid reader period filter' })
    }

    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 100000) {
      return res.status(400).json({ ok: false, message: 'Invalid page' })
    }

    if (period === 'custom') {
      if (!validDate(from) || !validDate(to) || from > to || to > today ||
          (new Date(to).getTime() - new Date(from).getTime()) / 86400000 > 365) {
        return res.status(400).json({ ok: false, message: 'Invalid custom date range' })
      }
    }

    const data = await loadReaderPeriod({
      scope, period, from: period === 'custom' ? from : '',
      to: period === 'custom' ? to : '', order, sort,
      page: pageNumber, search, refresh, today,
    })

    return res.status(200).json(data)
  } catch (error) {
    console.error('ADMIN READER PERIOD ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load reader period statistics' })
  }
}
