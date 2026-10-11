import { supabase } from '../config/supabase.js'

const detailCache = new Map()
const pendingDetails = new Map()
const MAX_CACHE_ITEMS = 160
const DETAIL_TTL_MS = 5 * 60 * 1000

const dayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Phnom_Penh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function cambodiaDay() {
  const parts = Object.fromEntries(dayFormatter.formatToParts(new Date()).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function trimCache() {
  for (const [key, item] of detailCache) {
    if (item.expiresAt <= Date.now()) detailCache.delete(key)
  }
  while (detailCache.size >= MAX_CACHE_ITEMS) detailCache.delete(detailCache.keys().next().value)
}

async function loadDetail(options) {
  const key = JSON.stringify([cambodiaDay(), options.scope, options.id, options.period, options.from, options.to, options.order, options.sort, options.page])
  const cached = detailCache.get(key)
  if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.value
  if (pendingDetails.has(key)) return pendingDetails.get(key)

  const request = (async () => {
    const { data, error } = await supabase.rpc('get_admin_reader_activity_period_detail_v1', {
      p_scope: options.scope,
      p_subject_id: options.id,
      p_period: options.period,
      p_custom_from: options.period === 'custom' ? options.from : null,
      p_custom_to: options.period === 'custom' ? options.to : null,
      p_order: options.order,
      p_sort: options.sort,
      p_page: options.page,
    })

    if (error) throw error
    if (!data || data.ok !== true || !Array.isArray(data.items)) {
      throw new Error('Invalid period detail response')
    }

    trimCache()
    detailCache.set(key, { value: data, expiresAt: Date.now() + DETAIL_TTL_MS })
    return data
  })()

  pendingDetails.set(key, request)
  try {
    return await request
  } finally {
    if (pendingDetails.get(key) === request) pendingDetails.delete(key)
  }
}

export async function getAdminReaderPeriodDetail(req, res) {
  res.set('Cache-Control', 'private, no-store')

  try {
    const scope = String(req.query.scope || '').trim().toLowerCase()
    const id = String(req.query.id || '').trim()
    const period = String(req.query.period || 'today').trim().toLowerCase()
    const order = String(req.query.order || 'top').trim().toLowerCase()
    const sort = String(req.query.sort || 'episodes').trim().toLowerCase()
    const from = String(req.query.from || '').trim()
    const to = String(req.query.to || '').trim()
    const page = Number(req.query.page || 1)
    const refresh = String(req.query.refresh || '') === '1'
    const today = cambodiaDay()

    if (!['story', 'reader'].includes(scope) || !id || id.length > 128 ||
        !['today', 'yesterday', '7d', 'week', 'month', 'year', 'custom'].includes(period) ||
        !['top', 'low'].includes(order) || !['episodes', 'views', 'change'].includes(sort)) {
      return res.status(400).json({ ok: false, message: 'Invalid period detail filter' })
    }
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
      return res.status(400).json({ ok: false, message: 'Invalid page' })
    }
    if (period === 'custom') {
      if (!validDate(from) || !validDate(to) || from > to || to > today ||
          (new Date(to).getTime() - new Date(from).getTime()) / 86400000 > 365) {
        return res.status(400).json({ ok: false, message: 'Invalid custom dates' })
      }
    }

    const data = await loadDetail({ scope, id, period, from, to, order, sort, page, refresh })
    return res.status(200).json(data)
  } catch (error) {
    console.error('ADMIN READER PERIOD DETAIL ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load period detail' })
  }
}
