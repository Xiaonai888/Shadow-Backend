import { supabase } from '../config/supabase.js'
import { getAuthorStorePdfOwnership } from './authorStorePdfOwnership.service.js'
import { getDiscoverPromotionWindow } from './discoverPromotionLanguageRotation.service.js'
import { getSmartPdfCatalogCount, readSmartPdfCandidatePage } from './smartPdfCatalog.service.js'
import { SMART_PDF_POLICY, normalizeSmartPdfLanguage } from './smartPdfPolicy.service.js'
import { selectSmartPdfCandidates, smartPdfStableHash } from './smartPdfSelection.service.js'

export async function getSmartPdfRecommendationCandidates({
  readerId = '', readerKey = '', language = 'km', interests = {},
  recentExposure = new Map(), exposureTotals = {}, excludeProductIds = [],
  limit = SMART_PDF_POLICY.maxRecommendations, db = supabase,
  now = Date.now(),
} = {}) {
  const selectedLanguage = normalizeSmartPdfLanguage(language)
  if (!selectedLanguage) throw new TypeError('Invalid PDF Story Language')
  const take = Number(limit)
  if (!Number.isSafeInteger(take) || take < 1 || take > SMART_PDF_POLICY.maxRecommendations) {
    throw new RangeError('Invalid PDF promotion slot count')
  }
  const slot = getDiscoverPromotionWindow(now)
  const rotationKey = slot.rotationKey
  const identity = String(readerId || readerKey || 'anonymous')
  const base = {
    slot_start_at: new Date(slot.slotStart).toISOString(),
    expires_at: new Date(slot.expiresAt).toISOString(),
    rotation_key: rotationKey,
    language: selectedLanguage,
  }
  const availableCount = await getSmartPdfCatalogCount({ language: selectedLanguage, db, now })
  if (!availableCount) return { ...base, candidates: [], scanned: 0 }
  const pageCount = Math.ceil(availableCount / SMART_PDF_POLICY.pageSize)
  const firstPage = smartPdfStableHash(`${identity}:${rotationKey}:${selectedLanguage}`) % pageCount
  const pool = []
  let scanned = 0
  const seenIds = new Set()
  for (let position = 0; position < Math.min(pageCount, SMART_PDF_POLICY.maxCandidatePages); position += 1) {
    const index = (firstPage + position) % pageCount
    const page = await readSmartPdfCandidatePage({
      language: selectedLanguage,
      offset: index * SMART_PDF_POLICY.pageSize,
      limit: SMART_PDF_POLICY.pageSize,
      db, now,
    })
    scanned += page.scanned
    for (const item of page.records) {
      if (seenIds.has(item.product_id)) continue
      seenIds.add(item.product_id)
      pool.push(item)
    }
    if (pool.length >= SMART_PDF_POLICY.ownershipBatchSize * SMART_PDF_POLICY.maxOwnershipBatches) break
  }
  if (!pool.length) return { ...base, candidates: [], scanned }
  const ranked = selectSmartPdfCandidates({
    candidates: pool, readerKey: identity, slotKey: rotationKey,
    interests, recentExposure, exposureTotals, excludedProductIds: excludeProductIds,
    limit: Math.min(pool.length, SMART_PDF_POLICY.ownershipBatchSize * SMART_PDF_POLICY.maxOwnershipBatches), now,
  })
  if (!readerId) return { ...base, candidates: ranked.slice(0, take), scanned }
  const results = []
  for (let offset = 0; offset < ranked.length && results.length < take; offset += SMART_PDF_POLICY.ownershipBatchSize) {
    const batch = ranked.slice(offset, offset + SMART_PDF_POLICY.ownershipBatchSize)
    const states = await getAuthorStorePdfOwnership(String(readerId), batch.map((item) => item.product_id))
    const permitted = new Set(states.filter((item) => item.product_type === 'pdf' && item.state === 'available')
      .map((item) => String(item.product_id)))
    for (const item of batch) {
      if (!permitted.has(item.product_id)) continue
      results.push(item)
      if (results.length >= take) break
    }
  }
  return { ...base, candidates: results, scanned }
}
