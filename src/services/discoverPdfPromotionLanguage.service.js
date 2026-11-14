import {
  getDiscoverPromotionLanguageRotation,
  getDiscoverPromotionWindow,
  normalizeDiscoverPromotionLanguage,
} from './discoverPromotionLanguageRotation.service.js'

function toCents(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  const cents = Math.round(number * 100)
  return Number.isSafeInteger(cents) && Math.abs(number * 100 - cents) < 0.001 ? cents : null
}

function validatePdfOffer(item, language, expiresAt, position) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('Invalid PDF promotion')
  }

  const productId = String(item.product_id || '').trim()
  const authorPageId = String(item.author_page_id || '').trim()
  const username = String(item.page_username || '').trim()
  const title = String(item.title || '').trim()
  const coverUrl = String(item.cover_url || '').trim()
  const original = toCents(item.original_price_usd)
  const author = toCents(item.author_price_usd)
  const promotion = toCents(item.promotion_price_usd)
  const discount = Number(item.discount_percent)
  const source = String(item.discount_source || '').trim().toLowerCase()

  if (
    !productId || !authorPageId || !username || !title || !coverUrl ||
    item.product_type !== 'pdf' ||
    normalizeDiscoverPromotionLanguage(item.story_language) !== language ||
    Number(item.slot_position) !== position ||
    Date.parse(String(item.expires_at || '')) !== expiresAt ||
    String(item.currency || '').toUpperCase() !== 'USD' ||
    original === null || author === null || promotion === null ||
    original < author || author < 1 || promotion < 1 || promotion > author ||
    promotion > Math.max(1, Math.floor(original * 0.8)) ||
    !Number.isInteger(discount) || discount < 0 || discount > 99 ||
    !['author', 'admin', 'none'].includes(source)
  ) {
    throw new Error('Invalid PDF promotion language, price, or expiry')
  }

  return {
    id: `author-store-${productId}`,
    product_id: productId,
    author_page_id: authorPageId,
    page_username: username,
    page_name: String(item.page_name || ''),
    product_type: 'pdf',
    title,
    author_name: String(item.author_name || ''),
    description: String(item.description || ''),
    cover_url: coverUrl,
    profile_image_url: coverUrl,
    story_language: language,
    stock_quantity: null,
    currency: 'USD',
    original_price_usd: original / 100,
    author_price_usd: author / 100,
    promotion_price_usd: promotion / 100,
    discount_percent: discount,
    discount_source: source,
    slot_position: position,
    expires_at: new Date(expiresAt).toISOString(),
    product_path: `/author/page/${encodeURIComponent(username)}/store/product/${encodeURIComponent(productId)}`,
  }
}

export function getCurrentDiscoverPdfPromotionsForLanguage(rawLanguage) {
  const language = normalizeDiscoverPromotionLanguage(rawLanguage)
  if (!language) throw new Error('Invalid Story Language')
  if (language === 'km') {
    return getDiscoverPromotionLanguageRotation('store', language, validatePdfOffer)
  }

  const window = getDiscoverPromotionWindow()
  return Promise.resolve({
    promotions: [],
    promotion: null,
    slot_start_at: new Date(window.slotStart).toISOString(),
    expires_at: new Date(window.expiresAt).toISOString(),
    rotation_key: window.rotationKey,
    language,
    currency: 'USD',
    slotStart: window.slotStart,
    expiresAt: window.expiresAt,
  })
}
