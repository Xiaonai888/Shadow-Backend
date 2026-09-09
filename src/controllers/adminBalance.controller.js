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

function cacheKey({ page, limit, search, sort }) {
  return JSON.stringify([page, limit, search.toLowerCase(), sort])
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
    const refresh = String(req.query.refresh || '') === '1'
    const key = cacheKey({ page, limit, search, sort })

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
      'get_admin_balance_wallets_v1',
      {
        p_page: page,
        p_limit: limit,
        p_search: search,
        p_sort: sort,
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
