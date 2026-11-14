import { supabase } from '../config/supabase.js'

const ROTATION_MS = 6 * 60 * 60 * 1000
const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const RETRY_MS = 20 * 1000
const MAX_OFFERS = 3
const RPC_BY_KIND = Object.freeze({
  story: 'get_or_rotate_discover_special_promotions_language_v1',
  store: 'get_or_rotate_discover_author_store_promotions_language_v1',
})
const LANGUAGE_CODES = Object.freeze({
  km: 'km',
  khmer: 'km',
  en: 'en',
  english: 'en',
  zh: 'zh',
  chinese: 'zh',
  ja: 'ja',
  japanese: 'ja',
  ko: 'ko',
  korean: 'ko',
})
const states = new Map()

export function normalizeDiscoverPromotionLanguage(value) {
  if (typeof value !== 'string') return null
  return LANGUAGE_CODES[value.trim().toLowerCase()] || null
}

export function getDiscoverPromotionWindow(now = Date.now()) {
  const slotStart = Math.floor((now + CAMBODIA_OFFSET_MS) / ROTATION_MS) * ROTATION_MS - CAMBODIA_OFFSET_MS
  return {
    slotStart,
    expiresAt: slotStart + ROTATION_MS,
    rotationKey: String(Math.floor(slotStart / 1000)),
  }
}

function normalizeRotation(kind, language, data, expectedWindow, validateOffer) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid language promotion rotation')
  }
  if (normalizeDiscoverPromotionLanguage(data.language) !== language) {
    throw new Error('Promotion rotation language mismatch')
  }

  const slotStart = Date.parse(String(data.slot_start_at || ''))
  const expiresAt = Date.parse(String(data.expires_at || ''))
  if (slotStart !== expectedWindow.slotStart || expiresAt !== expectedWindow.expiresAt) {
    throw new Error('Promotion rotation window mismatch')
  }
  if (!Array.isArray(data.promotions) || data.promotions.length > MAX_OFFERS) {
    throw new Error('Invalid promotion rotation offers')
  }

  const promotions = data.promotions.map((offer, index) => validateOffer(offer, language, expiresAt, index + 1))
  const ids = promotions.map((offer) => String(kind === 'story' ? offer.story_id : offer.product_id))
  if (new Set(ids).size !== ids.length) {
    throw new Error('Duplicate language promotion offers')
  }

  return {
    promotions,
    promotion: promotions[0] || null,
    slot_start_at: new Date(slotStart).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    rotation_key: expectedWindow.rotationKey,
    language,
    ...(kind === 'store' ? { currency: 'USD' } : {}),
    slotStart,
    expiresAt,
  }
}

export async function getDiscoverPromotionLanguageRotation(kind, rawLanguage, validateOffer) {
  const language = normalizeDiscoverPromotionLanguage(rawLanguage)
  const rpc = RPC_BY_KIND[kind]
  if (!language || !rpc || typeof validateOffer !== 'function') {
    throw new Error('Invalid promotion rotation request')
  }

  const key = `${kind}:${language}`
  let state = states.get(key)
  if (!state) {
    state = { rotation: null, pending: null, retryUntil: 0, retrySlotStart: null }
    states.set(key, state)
  }

  const expected = getDiscoverPromotionWindow()
  if (state.rotation?.slotStart === expected.slotStart && state.rotation.expiresAt > Date.now()) {
    return state.rotation
  }
  if (state.pending?.slotStart === expected.slotStart) {
    return state.pending.promise
  }
  if (state.retrySlotStart === expected.slotStart && Date.now() < state.retryUntil) {
    throw new Error('Promotion rotation temporarily unavailable')
  }

  const promise = (async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const window = getDiscoverPromotionWindow()
      const { data, error } = await supabase.rpc(rpc, { p_language: language })
      if (error) throw error
      try {
        const rotation = normalizeRotation(kind, language, data, window, validateOffer)
        if (getDiscoverPromotionWindow().slotStart !== rotation.slotStart) {
          if (attempt === 0) continue
          throw new Error('Promotion rotation changed during request')
        }
        state.rotation = rotation
        state.retryUntil = 0
        state.retrySlotStart = null
        return rotation
      } catch (error) {
        if (getDiscoverPromotionWindow().slotStart !== window.slotStart && attempt === 0) continue
        throw error
      }
    }
    throw new Error('Promotion rotation changed during request')
  })()
    .catch((error) => {
      state.retryUntil = Date.now() + RETRY_MS
      state.retrySlotStart = getDiscoverPromotionWindow().slotStart
      throw error
    })
    .finally(() => {
      if (state.pending?.promise === promise) state.pending = null
    })

  state.pending = { slotStart: expected.slotStart, promise }
  return promise
}
