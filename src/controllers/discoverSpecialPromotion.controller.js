import { supabase } from '../config/supabase.js'

const ROTATION_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const MIN_LOCKED_EPISODES = 5
const MAX_PROMOTIONS = 3
const ROTATION_FUNCTION = 'get_or_rotate_discover_special_promotions_v2'

let cachedRotation = null
let inflightRotation = null

function getRotationWindow(now = Date.now()) {
  const cambodiaTime = now + CAMBODIA_OFFSET_MS
  const dayStart = Math.floor(cambodiaTime / DAY_MS) * DAY_MS
  const slotStart = dayStart + Math.floor((cambodiaTime - dayStart) / ROTATION_MS) * ROTATION_MS - CAMBODIA_OFFSET_MS

  return {
    slotStart,
    expiresAt: slotStart + ROTATION_MS,
    rotationKey: String(Math.floor(slotStart / 1000)),
  }
}

function parseTimestamp(value) {
  if (!value) return NaN
  return new Date(value).getTime()
}

function validInteger(value, minimum = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= minimum
}

function normalizePromotion(item, rotationEnd) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('Invalid special promotion story data')
  }

  const storyId = String(item.story_id || '').trim()
  const coverUrl = String(item.cover_url || '').trim()
  const title = String(item.story_title || '').trim()
  const count = Number(item.locked_episode_count)
  const original = Number(item.original_price_diamonds)
  const discounted = Number(item.discounted_price_diamonds)
  const expiresAt = parseTimestamp(item.expires_at)

  if (
    !storyId ||
    !title ||
    !coverUrl ||
    !validInteger(count, MIN_LOCKED_EPISODES) ||
    !validInteger(original, count * 2) ||
    !validInteger(discounted, count) ||
    discounted !== Math.ceil(original / 2) ||
    expiresAt !== rotationEnd ||
    Number(item.discount_percent) !== 50
  ) {
    throw new Error('Invalid special promotion price, episodes, or expiry')
  }

  return {
    ...item,
    id: String(item.id || `special-${storyId}`),
    story_id: storyId,
    story_title: title,
    cover_url: coverUrl,
    profile_image_url: coverUrl,
    locked_episode_count: count,
    original_price_diamonds: original,
    discounted_price_diamonds: discounted,
    discount_percent: 50,
    expires_at: new Date(rotationEnd).toISOString(),
  }
}

function normalizeRotation(data, window) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Special promotion rotation response is invalid')
  }

  const slotStart = parseTimestamp(data.slot_start_at)
  const expiresAt = parseTimestamp(data.expires_at)

  if (slotStart !== window.slotStart || expiresAt !== window.expiresAt) {
    throw new Error('Special promotion rotation is out of date')
  }

  if (
    !Array.isArray(data.promotions) ||
    data.promotions.length > MAX_PROMOTIONS
  ) {
    throw new Error('Invalid special promotion carousel data')
  }

  const promotions = data.promotions.map((item) => normalizePromotion(item, expiresAt))
  const ids = promotions.map((item) => item.story_id)

  if (new Set(ids).size !== ids.length) {
    throw new Error('Duplicate stories in special promotion rotation')
  }

  return {
    promotions,
    promotion: promotions[0] || null,
    slot_start_at: new Date(slotStart).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    rotation_key: window.rotationKey,
    expiresAt,
    slotStart,
  }
}

async function loadRotation(window) {
  const { data, error } = await supabase.rpc(ROTATION_FUNCTION)

  if (error) throw error

  return normalizeRotation(data, window)
}

export async function getCurrentDiscoverSpecialPromotions() {
  const window = getRotationWindow()
  const now = Date.now()

  if (
    cachedRotation &&
    cachedRotation.slotStart === window.slotStart &&
    cachedRotation.expiresAt > now
  ) {
    return cachedRotation
  }

  if (inflightRotation?.slotStart === window.slotStart) {
    return inflightRotation.promise
  }

  const request = loadRotation(window)
    .then((rotation) => {
      if (
        getRotationWindow().slotStart === rotation.slotStart &&
        Date.now() < rotation.expiresAt
      ) {
        cachedRotation = rotation
      }

      return rotation
    })
    .finally(() => {
      if (inflightRotation?.promise === request) {
        inflightRotation = null
      }
    })

  inflightRotation = { slotStart: window.slotStart, promise: request }
  return request
}

export async function getCurrentDiscoverSpecialPromotion() {
  const rotation = await getCurrentDiscoverSpecialPromotions()
  return rotation.promotion
}

export async function getActiveDiscoverSpecialPromotion(req, res) {
  try {
    let rotation = await getCurrentDiscoverSpecialPromotions()

    if (Date.now() >= rotation.expiresAt) {
      rotation = await getCurrentDiscoverSpecialPromotions()
    }

    if (Date.now() >= rotation.expiresAt) {
      throw new Error('Special promotion rotation has expired')
    }

    const secondsRemaining = Math.max(0, Math.floor((rotation.expiresAt - Date.now()) / 1000))
    res.set('Cache-Control', `public, max-age=${Math.min(30, secondsRemaining)}, must-revalidate`)

    return res.status(200).json({
      ok: true,
      promotion: rotation.promotion,
      promotions: rotation.promotions,
      expires_at: rotation.expires_at,
      slot_start_at: rotation.slot_start_at,
      rotation_key: rotation.rotation_key,
    })
  } catch (error) {
    console.error('GET DISCOVER SPECIAL PROMOTION ERROR:', error)
    res.set('Cache-Control', 'no-store')

    return res.status(503).json({
      ok: false,
      message: 'Special promotion is temporarily unavailable',
    })
  }
}
