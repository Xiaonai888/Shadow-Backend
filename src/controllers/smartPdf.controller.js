import { currentSmartPdfCampaignWindow } from '../services/smartPdfCampaign.service.js'
import { selectSmartPdfPromotion } from '../services/smartPdfDelivery.service.js'
import { recordSmartPdfEvents } from '../services/smartPdfExposure.service.js'
import { normalizeSmartPdfLanguage } from '../services/smartPdfPolicy.service.js'
import { getSmartPdfReaderIdentity, SmartPdfRequestError } from '../services/smartPdfReaderIdentity.service.js'

const PLACEMENTS = new Set(['stories', 'manga', 'discover'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_EXCLUSIONS = 90

function privateResponse(res) {
  res.set('Cache-Control', 'private, no-store')
}

function fail(res, error) {
  if (error instanceof SmartPdfRequestError || Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
    return res.status(error.statusCode || 400).json({ ok: false, message: error.message })
  }
  console.error('SMART_PDF_API_ERROR:', String(error?.message || error))
  return res.status(503).json({ ok: false, message: 'Smart PDF Promotion is temporarily unavailable' })
}

function placementOf(value) {
  const placement = String(value || '').trim()
  if (!PLACEMENTS.has(placement)) throw new SmartPdfRequestError('Invalid PDF promotion placement')
  return placement
}

function interestsOf(value) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SmartPdfRequestError('Invalid PDF interests')
  }
  const entries = Object.entries(value)
  if (entries.length > 24) throw new SmartPdfRequestError('Too many PDF interests')
  const interests = {}
  for (const [name, rawWeight] of entries) {
    const key = String(name).trim().toLowerCase()
    const weight = Number(rawWeight)
    if (!key || key.length > 60 || !Number.isFinite(weight) || weight < 0 || weight > 40) {
      throw new SmartPdfRequestError('Invalid PDF interest value')
    }
    interests[key] = weight
  }
  return interests
}

function excludedOf(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_EXCLUSIONS) {
    throw new SmartPdfRequestError('Invalid excluded PDF products')
  }
  const ids = [...new Set(value.map((id) => String(id || '').trim().toLowerCase()))]
  if (ids.some((id) => !UUID.test(id))) throw new SmartPdfRequestError('Invalid PDF product ID')
  return ids
}

function productIdsOf(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10) {
    throw new SmartPdfRequestError('Expected 1–10 PDF product IDs')
  }
  const ids = [...new Set(value.map((id) => String(id || '').trim().toLowerCase()))]
  if (ids.some((id) => !UUID.test(id))) throw new SmartPdfRequestError('Invalid PDF product ID')
  return ids
}

export function getSmartPdfPromotionVersion(req, res) {
  privateResponse(res)
  const window = currentSmartPdfCampaignWindow()
  return res.json({
    ok: true,
    rotation_key: window.rotation_key,
    slot_start_at: window.slot_start_at,
    expires_at: window.expires_at,
  })
}

export async function postSmartPdfPromotionSelection(req, res) {
  privateResponse(res)
  try {
    const readerIdentity = getSmartPdfReaderIdentity(req)
    const placement = placementOf(req.body?.placement)
    const language = normalizeSmartPdfLanguage(req.body?.story_language)
    if (!language) throw new SmartPdfRequestError('Invalid PDF Story Language')
    const result = await selectSmartPdfPromotion({
      readerIdentity,
      language,
      interests: interestsOf(req.body?.interests),
      excludedProductIds: excludedOf(req.body?.exclude_product_ids),
    })
    return res.json({ ...result, placement })
  } catch (error) {
    return fail(res, error)
  }
}

export async function postSmartPdfPromotionEvents(req, res) {
  privateResponse(res)
  try {
    const readerIdentity = getSmartPdfReaderIdentity(req)
    const placement = placementOf(req.body?.placement)
    const eventType = String(req.body?.event_type || '').trim()
    if (eventType !== 'impression' && eventType !== 'click') {
      throw new SmartPdfRequestError('Invalid PDF promotion event')
    }
    const outcome = await recordSmartPdfEvents({
      readerHash: readerIdentity.readerHash,
      placement,
      eventType,
      productIds: productIdsOf(req.body?.product_ids),
      rotationKey: String(req.body?.rotation_key || ''),
    })
    return res.json({ ok: true, ...outcome })
  } catch (error) {
    return fail(res, error)
  }
}
