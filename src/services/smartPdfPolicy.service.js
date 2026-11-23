export const SMART_PDF_POLICY = Object.freeze({
  pageSize: 100,
  maxCandidatePages: 4,
  maxOwnershipBatches: 3,
  ownershipBatchSize: 30,
  maxRecommendations: 3,
  catalogCacheMs: 120000,
  maxCatalogCacheEntries: 48,
  exposureLookbackMs: 7 * 86400000,
  freshProductMs: 30 * 86400000,
})

export const SMART_PDF_LANGUAGE_NAMES = Object.freeze({
  km: 'Khmer',
  en: 'English',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
})

const LANGUAGE_CODES = Object.freeze({
  khmer: 'km', km: 'km', kh: 'km',
  english: 'en', en: 'en',
  chinese: 'zh', zh: 'zh',
  japanese: 'ja', ja: 'ja',
  korean: 'ko', ko: 'ko',
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeSmartPdfLanguage(value) {
  return LANGUAGE_CODES[String(value || '').trim().toLowerCase()] || null
}

export function smartPdfUsdCents(value) {
  if (value === '' || value === null || value === undefined) return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const cents = Math.round(amount * 100)
  return Number.isSafeInteger(cents) && Math.abs(amount * 100 - cents) <= 0.001 ? cents : null
}

export function evaluateSmartPdfEligibility(product, authorPage, expectedLanguage = null) {
  const reject = (reason) => ({ eligible: false, reason, record: null })
  const productId = String(product?.id || '').trim()
  if (!UUID.test(productId) || String(product?.product_type || '').toLowerCase() !== 'pdf') {
    return reject('invalid_pdf_product')
  }
  if (String(product.status || '').toLowerCase() !== 'active') return reject('product_not_active')
  if (!authorPage || String(authorPage.status || '').toLowerCase() !== 'active') return reject('author_page_not_active')
  if (String(authorPage.id) !== String(product.author_page_id)) return reject('author_page_mismatch')
  const username = String(authorPage.page_username || '').trim()
  const title = String(product.title || '').trim()
  const coverUrl = String(product.cover_url || '').trim()
  if (!username || !title || !coverUrl) return reject('missing_product_details')
  if (!String(product.pdf_storage_key || '').trim() && !String(product.pdf_file_url || '').trim()) {
    return reject('missing_pdf_file')
  }
  const language = normalizeSmartPdfLanguage(product.novel_type)
  if (!language || (expectedLanguage && language !== normalizeSmartPdfLanguage(expectedLanguage))) {
    return reject('language_mismatch')
  }
  const originalCents = smartPdfUsdCents(product.original_price)
  const saleRaw = Number(product.sale_price)
  const authorCents = product.sale_price === null || product.sale_price === undefined || saleRaw === 0
    ? originalCents : smartPdfUsdCents(product.sale_price)
  if (originalCents === null || authorCents === null || authorCents > originalCents) {
    return reject('invalid_author_price')
  }
  const createdAt = Date.parse(String(product.created_at || ''))
  const record = {
    product_id: productId,
    author_page_id: String(product.author_page_id),
    page_username: username,
    page_name: String(authorPage.page_name || ''),
    product_type: 'pdf',
    title,
    author_name: String(product.author_name || ''),
    description: String(product.description || '').slice(0, 360),
    cover_url: coverUrl,
    story_language: language,
    genre: String(product.genre || '').trim().slice(0, 100),
    category: String(product.category || '').trim().slice(0, 100),
    original_price_usd: originalCents / 100,
    author_price_usd: authorCents / 100,
    created_at: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : null,
  }
  return { eligible: true, reason: null, record }
}
