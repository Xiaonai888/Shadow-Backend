import { getDiscoverPromotionWindow } from './discoverPromotionLanguageRotation.service.js'
import { normalizeSmartPdfLanguage, smartPdfUsdCents } from './smartPdfPolicy.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_OFFERS = 3

export function currentSmartPdfCampaignWindow(now = Date.now()) {
  const window = getDiscoverPromotionWindow(now)
  return {
    slot_start_at: new Date(window.slotStart).toISOString(),
    expires_at: new Date(window.expiresAt).toISOString(),
    rotation_key: String(window.rotationKey),
    slotStart: window.slotStart,
    expiresAt: window.expiresAt,
  }
}

export function priceSmartPdfCandidate(candidate, { window = currentSmartPdfCampaignWindow() } = {}) {
  const id = String(candidate?.product_id || '').trim().toLowerCase()
  const authorPageId = String(candidate?.author_page_id || '').trim()
  const username = String(candidate?.page_username || '').trim()
  const title = String(candidate?.title || '').trim()
  const coverUrl = String(candidate?.cover_url || '').trim()
  const language = normalizeSmartPdfLanguage(candidate?.story_language)
  const originalCents = smartPdfUsdCents(candidate?.original_price_usd)
  const authorCents = smartPdfUsdCents(candidate?.author_price_usd)
  if (
    !UUID.test(id) || !authorPageId || !username || !title || !coverUrl || !language ||
    String(candidate?.product_type || '').toLowerCase() !== 'pdf' ||
    originalCents === null || authorCents === null || authorCents > originalCents ||
    authorCents > Math.max(1, Math.floor(originalCents * 0.8)) ||
    !Number.isFinite(window?.expiresAt) || window.expiresAt <= Date.now()
  ) return null
  const discountPercent = Math.max(20, Math.min(99, Math.round((originalCents - authorCents) * 100 / originalCents)))
  return {
    id: `author-store-${id}`,
    product_id: id,
    author_page_id: authorPageId,
    page_username: username,
    page_name: String(candidate.page_name || ''),
    author_name: String(candidate.author_name || ''),
    product_type: 'pdf',
    title,
    description: String(candidate.description || ''),
    cover_url: coverUrl,
    profile_image_url: coverUrl,
    story_language: language,
    currency: 'USD',
    original_price_usd: originalCents / 100,
    author_price_usd: authorCents / 100,
    promotion_price_usd: authorCents / 100,
    discount_percent: discountPercent,
    discount_source: 'author',
    expires_at: window.expires_at,
    product_path: `/author/page/${encodeURIComponent(username)}/store/product/${encodeURIComponent(id)}`,
  }
}

export function buildSmartPdfCampaignResponse(offers, { language = 'km', window = currentSmartPdfCampaignWindow() } = {}) {
  const selected = normalizeSmartPdfLanguage(language)
  if (!selected) throw new TypeError('Invalid PDF Story Language')
  if (!Number.isFinite(window?.expiresAt) || window.expiresAt <= Date.now()) {
    const error = new Error('PDF campaign slot has expired')
    error.statusCode = 409
    throw error
  }
  const seen = new Set()
  const promotions = []
  for (const candidate of Array.isArray(offers) ? offers : []) {
    if (promotions.length >= MAX_OFFERS) break
    const offer = priceSmartPdfCandidate(candidate, { window })
    if (!offer || offer.story_language !== selected || seen.has(offer.product_id)) continue
    seen.add(offer.product_id)
    promotions.push({ ...offer, slot_position: promotions.length + 1 })
  }
  return {
    ok: true,
    promotions,
    promotion: promotions[0] || null,
    language: selected,
    currency: 'USD',
    slot_start_at: window.slot_start_at,
    expires_at: window.expires_at,
    rotation_key: window.rotation_key,
  }
}
