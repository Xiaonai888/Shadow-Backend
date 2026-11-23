import { supabase } from '../config/supabase.js'
import { getAuthorStorePdfOwnership } from './authorStorePdfOwnership.service.js'
import { readSmartPdfCandidatePage, getSmartPdfCatalogCount } from './smartPdfCatalog.service.js'
import { currentSmartPdfCampaignWindow, priceSmartPdfCandidate, buildSmartPdfCampaignResponse } from './smartPdfCampaign.service.js'
import { readSmartPdfRecentExposure, readSmartPdfExposureTotals } from './smartPdfExposure.service.js'
import { SMART_PDF_POLICY, normalizeSmartPdfLanguage } from './smartPdfPolicy.service.js'
import { selectSmartPdfCandidates, smartPdfStableHash } from './smartPdfSelection.service.js'

const MAX_SELECTED = SMART_PDF_POLICY.ownershipBatchSize * SMART_PDF_POLICY.maxOwnershipBatches

export async function selectSmartPdfPromotion({
  readerIdentity, language = 'km', interests = {}, excludedProductIds = [],
  db = supabase, now = Date.now(),
} = {}) {
  const selectedLanguage = normalizeSmartPdfLanguage(language)
  if (!selectedLanguage) throw new TypeError('Invalid PDF Story Language')
  const readerHash = String(readerIdentity?.readerHash || '')
  if (!/^[0-9a-f]{64}$/.test(readerHash)) throw new TypeError('Verified PDF reader identity is required')
  const readerId = String(readerIdentity?.readerId || '')
  const window = currentSmartPdfCampaignWindow(now)
  const empty = () => buildSmartPdfCampaignResponse([], { language: selectedLanguage, window })
  const total = await getSmartPdfCatalogCount({ language: selectedLanguage, db, now })
  if (!total) return empty()
  const pages = Math.ceil(total / SMART_PDF_POLICY.pageSize)
  const start = smartPdfStableHash(`${readerHash}:${window.rotation_key}:${selectedLanguage}`) % pages
  const offersById = new Map()
  for (let offset = 0; offset < Math.min(SMART_PDF_POLICY.maxCandidatePages, pages); offset += 1) {
    const page = await readSmartPdfCandidatePage({
      language: selectedLanguage,
      offset: ((start + offset) % pages) * SMART_PDF_POLICY.pageSize,
      limit: SMART_PDF_POLICY.pageSize,
      db, now,
    })
    for (const record of page.records) {
      const offer = priceSmartPdfCandidate(record, { window })
      if (offer && !offersById.has(offer.product_id)) offersById.set(offer.product_id, offer)
    }
    if (offersById.size >= MAX_SELECTED) break
  }
  if (!offersById.size) return empty()
  const [recentExposure, exposureTotals] = await Promise.all([
    readSmartPdfRecentExposure(readerHash, { db, now }),
    readSmartPdfExposureTotals([...offersById.keys()], { db, now }),
  ])
  const ranked = selectSmartPdfCandidates({
    candidates: [...offersById.values()],
    readerKey: readerHash,
    slotKey: window.rotation_key,
    interests,
    recentExposure,
    exposureTotals,
    excludedProductIds,
    limit: Math.min(MAX_SELECTED, offersById.size),
    now,
  })
  const chosen = []
  if (!readerId) {
    chosen.push(...ranked.slice(0, SMART_PDF_POLICY.maxRecommendations))
  } else {
    for (let offset = 0; offset < ranked.length && chosen.length < SMART_PDF_POLICY.maxRecommendations; offset += SMART_PDF_POLICY.ownershipBatchSize) {
      const batch = ranked.slice(offset, offset + SMART_PDF_POLICY.ownershipBatchSize)
      const states = await getAuthorStorePdfOwnership(readerId, batch.map((item) => item.product_id))
      const available = new Set((Array.isArray(states) ? states : [])
        .filter((item) => item.product_type === 'pdf' && item.state === 'available')
        .map((item) => String(item.product_id)))
      for (const item of batch) {
        if (!available.has(item.product_id)) continue
        chosen.push(item)
        if (chosen.length >= SMART_PDF_POLICY.maxRecommendations) break
      }
    }
  }
  if (currentSmartPdfCampaignWindow().rotation_key !== window.rotation_key) {
    const error = new Error('PDF promotion slot changed during selection')
    error.statusCode = 409
    throw error
  }
  return buildSmartPdfCampaignResponse(chosen, { language: selectedLanguage, window })
}
