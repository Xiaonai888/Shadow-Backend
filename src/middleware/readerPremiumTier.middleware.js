import { supabase } from '../config/supabase.js'

const CACHE_MS = 15000
const CACHE_LIMIT = 2000
const premiumCache = new Map()
const pendingPremium = new Map()

async function isPremiumActive(userId) {
  const now = Date.now()
  const cached = premiumCache.get(userId)
  if (cached && cached.cachedUntil > now) {
    return cached.isPremium && cached.expiresAt > now
  }

  let pending = pendingPremium.get(userId)
  if (!pending) {
    pending = (async () => {
      const { data, error } = await supabase
        .from('users')
        .select('is_premium, premium_expires_at')
        .eq('id', userId)
        .maybeSingle()

      if (error) throw error

      const expiresAt = Date.parse(data?.premium_expires_at || '')
      const entry = {
        isPremium: Boolean(data?.is_premium),
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
        cachedUntil: Date.now() + CACHE_MS,
      }

      if (premiumCache.size >= CACHE_LIMIT) {
        premiumCache.delete(premiumCache.keys().next().value)
      }
      premiumCache.set(userId, entry)
      return entry
    })()
    pendingPremium.set(userId, pending)
    pending.finally(() => {
      if (pendingPremium.get(userId) === pending) {
        pendingPremium.delete(userId)
      }
    }).catch(() => {})
  }

  const entry = await pending
  return entry.isPremium && entry.expiresAt > Date.now()
}

export async function loadReaderPremiumTier(req, res, next) {
  const userId = req.user?.user_id || req.user?.id
  if (!userId) return next()

  try {
    if (await isPremiumActive(userId)) {
      req.user.reader_tier = 'premium'
    }
    return next()
  } catch (error) {
    console.error('READER_PREMIUM_TIER_ERROR:', error)
    return res.status(503).json({
      ok: false,
      message: 'Premium status temporarily unavailable',
    })
  }
}
