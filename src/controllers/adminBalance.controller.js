import { supabase } from '../config/supabase.js'

const CACHE_TTL_MS = 60 * 1000
const CACHE_MAX_ENTRIES = 200
const balanceCache = new Map()

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max)
}

function cleanSearch(value) {
  return String(value || '').trim().replace(/^@+/, '').slice(0, 80)
}

function cleanSort(value) {
  return String(value || '').trim().toLowerCase() === 'asc' ? 'asc' : 'desc'
}

function cleanBoolean(value) {
  const text = String(value || '').trim().toLowerCase()
  return text === '1' || text === 'true' || text === 'yes'
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  )
}

function cleanCursorDate(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function cleanCursorKey(value) {
  const text = String(value || '').trim()
  return text ? text.slice(0, 200) : null
}

function cacheKey({
  page,
  limit,
  search,
  sort,
  dormantOnly,
  dormantDays,
}) {
  return JSON.stringify([
    page,
    limit,
    search.toLowerCase(),
    sort,
    dormantOnly,
    dormantDays,
  ])
}

function readCache(key) {
  const cached = balanceCache.get(key)
  if (!cached) return null

  if (Date.now() >= cached.expiresAt) {
    balanceCache.delete(key)
    return null
  }

  return cached.data
}

function writeCache(key, data) {
  const now = Date.now()

  for (const [entryKey, entry] of balanceCache) {
    if (now >= entry.expiresAt) balanceCache.delete(entryKey)
  }

  if (balanceCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = balanceCache.keys().next().value
    if (oldestKey) balanceCache.delete(oldestKey)
  }

  balanceCache.set(key, {
    data,
    expiresAt: now + CACHE_TTL_MS,
  })
}

export async function getAdminBalanceWallets(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 50)
    const search = cleanSearch(req.query.q)
    const sort = cleanSort(req.query.sort)
    const dormantOnly = cleanBoolean(req.query.dormant)
    const dormantDays = toPositiveInt(req.query.dormant_days, 90, 3650)
    const refresh = String(req.query.refresh || '') === '1'
    const key = cacheKey({
      page,
      limit,
      search,
      sort,
      dormantOnly,
      dormantDays,
    })

    if (!refresh) {
      const cached = readCache(key)

      if (cached) {
        return res.status(200).json({
          ...cached,
          cached: true,
          cache_ttl_seconds: 60,
        })
      }
    }

    const { data, error } = await supabase.rpc(
      'get_admin_balance_wallets_v2',
      {
        p_page: page,
        p_limit: limit,
        p_search: search,
        p_sort: sort,
        p_dormant_only: dormantOnly,
        p_dormant_days: dormantDays,
      }
    )

    if (error) throw error

    const payload = data || {
      ok: true,
      items: [],
      pagination: {
        page,
        limit,
        has_prev: page > 1,
        has_next: false,
      },
      sort,
      search,
      filters: {
        dormant_only: dormantOnly,
        dormant_days: dormantDays,
      },
    }

    writeCache(key, payload)

    return res.status(200).json({
      ...payload,
      cached: false,
      cache_ttl_seconds: 60,
    })
  } catch (error) {
    console.error('ADMIN BALANCE WALLETS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load reader balances',
      error: error.message,
    })
  }
}

export async function getAdminBalanceDiamondHistory(req, res) {
  try {
    const userId = String(req.params.userId || '').trim()

    if (!isUuid(userId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid reader ID',
      })
    }

    const limit = toPositiveInt(req.query.limit, 20, 50)
    const beforeRaw = String(req.query.before || '').trim()
    const beforeCreatedAt = cleanCursorDate(beforeRaw)
    const beforeEventKey = cleanCursorKey(req.query.before_key)

    if (beforeRaw && !beforeCreatedAt) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid history cursor',
      })
    }

    if (
      (beforeCreatedAt && !beforeEventKey) ||
      (!beforeCreatedAt && beforeEventKey)
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Incomplete history cursor',
      })
    }

    const { data, error } = await supabase.rpc(
      'get_admin_balance_diamond_history_v1',
      {
        p_user_id: userId,
        p_limit: limit,
        p_before_created_at: beforeCreatedAt,
        p_before_event_key: beforeEventKey,
      }
    )

    if (error) throw error

    return res.status(200).json(
      data || {
        ok: true,
        user_id: userId,
        items: [],
        pagination: {
          limit,
          has_next: false,
          next_cursor: null,
        },
      }
    )
  } catch (error) {
    console.error('ADMIN BALANCE DIAMOND HISTORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Diamond history',
      error: error.message,
    })
  }
}
