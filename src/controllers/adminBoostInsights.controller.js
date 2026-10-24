import { supabase } from '../config/supabase.js'

const DAY_MS = 86400000
const dailyCache = new Map()
const pending = new Map()

function cambodiaDay() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function loadReport(params) {
  const asOf = cambodiaDay()
  const key = JSON.stringify([asOf, params])
  const cached = dailyCache.get(key)
  if (cached) return cached
  if (pending.has(key)) return pending.get(key)

  const promise = (async () => {
    const name = params.audience === 'reader'
      ? 'get_shadow_boost_reader_insights'
      : 'get_shadow_boost_author_insights'
    const args = params.audience === 'reader'
      ? { p_start: params.start, p_end: params.end }
      : {
          p_kind: params.kind,
          p_start: params.start,
          p_end: params.end,
          p_page: params.page,
          p_limit: params.limit,
          p_search: params.search,
        }
    const { data, error } = await supabase.rpc(name, args)
    if (error) throw error
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid Boost Analytics snapshot')
    }
    if (dailyCache.size >= 200) dailyCache.clear()
    dailyCache.set(key, data)
    return data
  })().finally(() => pending.delete(key))

  pending.set(key, promise)
  return promise
}

export async function getAdminBoostInsights(req, res) {
  const audience = String(req.query.audience || '')
  const kind = String(req.query.kind || 'post')
  const start = String(req.query.start || '')
  const end = String(req.query.end || '')
  const search = String(req.query.search || '').trim()
  const page = Number(req.query.page ?? 1)
  const limit = Number(req.query.limit ?? 20)
  const yesterday = new Date(Date.parse(`${cambodiaDay()}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)

  if (
    !['reader', 'author'].includes(audience) ||
    (audience === 'author' && !['post', 'book'].includes(kind)) ||
    !validDate(start) || !validDate(end) || start > end || end > yesterday ||
    Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) > 365 * DAY_MS ||
    !Number.isSafeInteger(page) || page < 1 || page > 100000 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
    search.length > 80
  ) {
    return res.status(400).json({ ok: false, message: 'Invalid Boost Analytics filters' })
  }

  try {
    const data = await loadReport({ audience, kind, start, end, search: audience === 'author' ? search : '', page, limit })
    res.set('Cache-Control', 'private, max-age=300')
    return res.status(200).json({ ok: true, data })
  } catch (error) {
    console.error('ADMIN_BOOST_INSIGHTS_ERROR:', error)
    return res.status(503).json({ ok: false, message: 'Boost Analytics is not available yet' })
  }
}
