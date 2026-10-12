import { supabase } from '../config/supabase.js'

const ROTATION_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const MAX_PROMOTIONS = 3
const ERROR_RETRY_MS = 20 * 1000
const ROTATION_FUNCTION = 'get_or_rotate_discover_author_store_promotions_v1'

let cachedRotation = null
let pendingRotation = null
let retryAfter = 0
let retryWindowStart = 0

function currentRotationWindow(now = Date.now()) {
  const cambodiaTime = now + CAMBODIA_OFFSET_MS
  const dayStart = Math.floor(cambodiaTime / DAY_MS) * DAY_MS
  const slotStart = dayStart + Math.floor((cambodiaTime - dayStart) / ROTATION_MS) * ROTATION_MS - CAMBODIA_OFFSET_MS
  return { slotStart, expiresAt: slotStart + ROTATION_MS }
}

function timestamp(value) {
  if (!value) return NaN
  return new Date(value).getTime()
}

function toCents(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  const cents = Math.round(number * 100)
  if (!Number.isSafeInteger(cents) || Math.abs(number * 100 - cents) > 0.001) return null
  return cents
}

function normalizeOffer(item, position, expiresAt) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('Invalid author store promotion product')
  }

  const productId = String(item.product_id || '').trim()
  const authorPageId = String(item.author_page_id || '').trim()
  const pageUsername = String(item.page_username || '').trim()
  const title = String(item.title || '').trim()
  const coverUrl = String(item.cover_url || '').trim()
  const type = String(item.product_type || '').toLowerCase()
  const originalCents = toCents(item.original_price_usd)
  const authorCents = toCents(item.author_price_usd)
  const promotionCents = toCents(item.promotion_price_usd)
  const discountPercent = Number(item.discount_percent)
  const discountSource = String(item.discount_source || '').toLowerCase()

  if (
    !productId || !authorPageId || !pageUsername || !title || !coverUrl ||
    !['book', 'pdf'].includes(type) ||
    Number(item.slot_position) !== position ||
    timestamp(item.expires_at) !== expiresAt ||
    originalCents === null || authorCents === null || promotionCents === null ||
    originalCents < authorCents || authorCents < 1 || promotionCents < 1 ||
    promotionCents > authorCents ||
    !Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 99 ||
    !['author', 'admin', 'none'].includes(discountSource) ||
    String(item.currency || '').toUpperCase() !== 'USD'
  ) {
    throw new Error('Invalid author store promotion details or USD price')
  }

  if (type === 'book' && (position !== 1 || promotionCents !== authorCents || Number(item.stock_quantity) < 1 || item.pre_order === true)) {
    throw new Error('Invalid book promotion or stock status')
  }

  if (type === 'pdf' && promotionCents > Math.max(1, Math.floor(originalCents * 0.8))) {
    throw new Error('PDF promotion must be at least 20 percent off')
  }

  return {
    id: String(item.id || `author-store-${productId}`),
    product_id: productId,
    author_page_id: authorPageId,
    page_username: pageUsername,
    page_name: String(item.page_name || ''),
    product_type: type,
    title,
    author_name: String(item.author_name || ''),
    description: String(item.description || ''),
    cover_url: coverUrl,
    profile_image_url: coverUrl,
    stock_quantity: type === 'book' ? Number(item.stock_quantity) : null,
    currency: 'USD',
    original_price_usd: originalCents / 100,
    author_price_usd: authorCents / 100,
    promotion_price_usd: promotionCents / 100,
    discount_percent: discountPercent,
    discount_source: discountSource,
    slot_position: position,
    expires_at: new Date(expiresAt).toISOString(),
    product_path: `/author/page/${encodeURIComponent(pageUsername)}/store/product/${encodeURIComponent(productId)}`,
  }
}

function normalizeRotation(data, expectedWindow) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid author store rotation response')
  }

  const slotStart = timestamp(data.slot_start_at)
  const expiresAt = timestamp(data.expires_at)

  if (slotStart !== expectedWindow.slotStart || expiresAt !== expectedWindow.expiresAt) {
    throw new Error('Author store promotion rotation window mismatch')
  }

  if (!Array.isArray(data.promotions) || data.promotions.length > MAX_PROMOTIONS) {
    throw new Error('Invalid author store promotion carousel')
  }

  const promotions = data.promotions.map((item, index) => normalizeOffer(item, index + 1, expiresAt))
  const productIds = promotions.map((item) => item.product_id)

  if (new Set(productIds).size !== productIds.length) {
    throw new Error('Duplicate products in author store promotion')
  }

  return {
    promotions,
    promotion: promotions[0] || null,
    slot_start_at: new Date(slotStart).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    rotation_key: String(Math.floor(slotStart / 1000)),
    currency: 'USD',
    slotStart,
    expiresAt,
  }
}

async function fetchRotation() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expectedWindow = currentRotationWindow()
    const { data, error } = await supabase.rpc(ROTATION_FUNCTION)
    if (error) throw error

    try {
      return normalizeRotation(data, expectedWindow)
    } catch (error) {
      if (currentRotationWindow().slotStart !== expectedWindow.slotStart && attempt === 0) {
        continue
      }
      throw error
    }
  }

  throw new Error('Author store promotion changed during request')
}

export async function getCurrentDiscoverAuthorStorePromotions() {
  const window = currentRotationWindow()
  const now = Date.now()

  if (cachedRotation?.slotStart === window.slotStart && cachedRotation.expiresAt > now) {
    return cachedRotation
  }

  if (pendingRotation?.slotStart === window.slotStart) {
    return pendingRotation.promise
  }

  if (now < retryAfter && retryWindowStart === window.slotStart) {
    throw new Error('Author store promotion temporarily unavailable')
  }

  const promise = fetchRotation()
    .then((rotation) => {
      if (currentRotationWindow().slotStart === rotation.slotStart && Date.now() < rotation.expiresAt) {
        cachedRotation = rotation
      }
      retryAfter = 0
      retryWindowStart = 0
      return rotation
    })
    .catch((error) => {
      retryAfter = Date.now() + ERROR_RETRY_MS
      retryWindowStart = window.slotStart
      throw error
    })
    .finally(() => {
      if (pendingRotation?.promise === promise) pendingRotation = null
    })

  pendingRotation = { slotStart: window.slotStart, promise }
  return promise
}

export async function getActiveDiscoverAuthorStorePromotions(req, res) {
  try {
    let rotation = await getCurrentDiscoverAuthorStorePromotions()
    if (Date.now() >= rotation.expiresAt) rotation = await getCurrentDiscoverAuthorStorePromotions()
    if (Date.now() >= rotation.expiresAt) throw new Error('Author store promotion has expired')

    const secondsRemaining = Math.max(0, Math.floor((rotation.expiresAt - Date.now()) / 1000))
    res.set('Cache-Control', `public, max-age=${Math.min(30, secondsRemaining)}, must-revalidate`)

    return res.status(200).json({
      ok: true,
      promotions: rotation.promotions,
      promotion: rotation.promotion,
      slot_start_at: rotation.slot_start_at,
      expires_at: rotation.expires_at,
      rotation_key: rotation.rotation_key,
      currency: rotation.currency,
    })
  } catch (error) {
    console.error('GET DISCOVER AUTHOR STORE PROMOTION ERROR:', error)
    res.set('Cache-Control', 'no-store')
    return res.status(503).json({
      ok: false,
      message: 'Author store promotion is temporarily unavailable',
    })
  }
}
