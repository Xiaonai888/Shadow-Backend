import { supabase } from '../config/supabase.js'

const rankingCache = new Map()
const rankingPending = new Map()
const RANKING_CACHE_LIMIT = 180
const LIST_TTL_MS = 2 * 60 * 1000
const DETAIL_TTL_MS = 5 * 60 * 1000

const cambodiaDayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Phnom_Penh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function cambodiaDay() {
  const values = Object.fromEntries(
    cambodiaDayFormat.formatToParts(new Date()).map((part) => [part.type, part.value])
  )
  return `${values.year}-${values.month}-${values.day}`
}

function clearOldCache() {
  const now = Date.now()
  for (const [key, value] of rankingCache) {
    if (value.expiresAt <= now) rankingCache.delete(key)
  }
  while (rankingCache.size >= RANKING_CACHE_LIMIT) {
    rankingCache.delete(rankingCache.keys().next().value)
  }
}

async function getRankingData({ scope, page, order, parentId, refresh }) {
  const key = `${cambodiaDay()}:${scope}:${page}:${order}:${parentId || ''}`
  const isDetail = scope.endsWith('_detail')
  const ttl = isDetail ? DETAIL_TTL_MS : LIST_TTL_MS
  const cached = rankingCache.get(key)

  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.data
  if (rankingPending.has(key)) return rankingPending.get(key)

  const task = (async () => {
    const { data, error } = await supabase.rpc('get_admin_reader_ranking_v1', {
      p_scope: scope,
      p_page: page,
      p_order: order,
      p_parent_id: parentId,
    })

    if (error) throw error
    if (!data || data.ok !== true || !Array.isArray(data.items)) {
      throw new Error('Invalid reader ranking response')
    }

    clearOldCache()
    rankingCache.set(key, { data, expiresAt: Date.now() + ttl })
    return data
  })()

  rankingPending.set(key, task)
  try {
    return await task
  } finally {
    if (rankingPending.get(key) === task) rankingPending.delete(key)
  }
}

export async function getAdminReaderRanking(req, res) {
  try {
    const scope = String(req.query.scope || 'story').trim().toLowerCase()
    const order = String(req.query.order || 'top').trim().toLowerCase()
    const rawPage = Number.parseInt(String(req.query.page || '1'), 10)
    const page = Number.isFinite(rawPage) ? Math.min(100000, Math.max(1, rawPage)) : 1
    const parentId = String(req.query.parent_id || '').trim() || null
    const refresh = ['1', 'true'].includes(String(req.query.refresh || '').toLowerCase())

    if (!['story', 'reader', 'story_detail', 'reader_detail'].includes(scope)) {
      return res.status(400).json({ ok: false, message: 'Invalid ranking scope' })
    }
    if (!['top', 'low'].includes(order)) {
      return res.status(400).json({ ok: false, message: 'Invalid ranking order' })
    }
    if (scope.endsWith('_detail') && (!parentId || parentId.length > 128)) {
      return res.status(400).json({ ok: false, message: 'Invalid ranking detail ID' })
    }

    const data = await getRankingData({ scope, page, order, parentId, refresh })
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json(data)
  } catch (error) {
    console.error('ADMIN READER RANKING ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load reader ranking' })
  }
}
