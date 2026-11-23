import { supabase } from '../config/supabase.js'
import { currentSmartPdfCampaignWindow } from './smartPdfCampaign.service.js'
import { SMART_PDF_POLICY } from './smartPdfPolicy.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const PLACEMENTS = new Set(['stories', 'manga', 'discover'])
const EVENT_TYPES = new Set(['impression', 'click'])
const RECENT_TTL_MS = 120000
const TOTAL_TTL_MS = 60000
const recentCache = new Map()
const totalCache = new Map()

function validatedHash(readerHash) {
  const value = String(readerHash || '')
  if (!HASH.test(value)) throw new TypeError('Invalid PDF reader hash')
  return value
}

function validProductIds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 10) throw new RangeError('Expected 1–10 PDF product IDs')
  const ids = [...new Set(values.map((value) => String(value || '').trim().toLowerCase()))]
  if (ids.some((id) => !UUID.test(id))) throw new TypeError('Invalid PDF product ID')
  return ids
}

function slotKey(now) {
  return currentSmartPdfCampaignWindow(now).rotation_key
}

export function invalidateSmartPdfExposure(readerHash = '') {
  if (!readerHash) {
    recentCache.clear()
    totalCache.clear()
    return
  }
  recentCache.delete(String(readerHash))
}

export async function readSmartPdfRecentExposure(readerHash, { db = supabase, now = Date.now() } = {}) {
  const hash = validatedHash(readerHash)
  const cached = db === supabase ? recentCache.get(hash) : null
  if (cached?.expiresAt > now) return new Map(cached.value)
  const since = new Date(now - SMART_PDF_POLICY.exposureLookbackMs).toISOString()
  const { data, error } = await db.from('smart_pdf_reader_exposure')
    .select('product_id,last_seen_at')
    .eq('reader_hash', hash)
    .gte('last_seen_at', since)
    .order('last_seen_at', { ascending: false })
    .limit(3000)
  if (error) throw error
  const records = new Map()
  for (const item of data || []) {
    const id = String(item.product_id || '')
    const seen = Date.parse(item.last_seen_at || '')
    if (UUID.test(id) && Number.isFinite(seen) && !records.has(id)) records.set(id, seen)
  }
  if (db === supabase) {
    if (recentCache.size >= 64) recentCache.delete(recentCache.keys().next().value)
    recentCache.set(hash, { value: records, expiresAt: now + RECENT_TTL_MS })
  }
  return new Map(records)
}

export async function readSmartPdfExposureTotals(productIds, { db = supabase, now = Date.now() } = {}) {
  const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(String))]
  if (ids.length > 400 || ids.some((id) => !UUID.test(id))) throw new RangeError('Invalid PDF exposure product list')
  const results = {}
  const missing = []
  for (const id of ids) {
    const value = db === supabase ? totalCache.get(id) : null
    if (value?.expiresAt > now) results[id] = value.value
    else missing.push(id)
  }
  for (let offset = 0; offset < missing.length; offset += 100) {
    const chunk = missing.slice(offset, offset + 100)
    const { data, error } = await db.from('smart_pdf_product_exposure_totals')
      .select('product_id,impressions,clicks')
      .in('product_id', chunk)
    if (error) throw error
    const byId = new Map((data || []).map((item) => [String(item.product_id), item]))
    for (const id of chunk) {
      const row = byId.get(id)
      const value = { impressions: Math.max(0, Number(row?.impressions) || 0), clicks: Math.max(0, Number(row?.clicks) || 0) }
      results[id] = value
      if (db === supabase) {
        if (totalCache.size >= 4000) totalCache.delete(totalCache.keys().next().value)
        totalCache.set(id, { value, expiresAt: now + TOTAL_TTL_MS })
      }
    }
  }
  return results
}

export async function recordSmartPdfEvents({
  readerHash, placement, eventType, productIds, rotationKey,
  db = supabase, now = Date.now(),
} = {}) {
  const hash = validatedHash(readerHash)
  if (!PLACEMENTS.has(placement)) throw new TypeError('Invalid PDF promotion placement')
  if (!EVENT_TYPES.has(eventType)) throw new TypeError('Invalid PDF promotion event type')
  const ids = validProductIds(productIds)
  const current = slotKey(now)
  const previous = slotKey(now - 6 * 3600000)
  if (String(rotationKey || '') !== current && String(rotationKey || '') !== previous) {
    const error = new Error('PDF promotion event slot has expired')
    error.statusCode = 409
    throw error
  }
  const { data, error } = await db.rpc('smart_pdf_record_events_v1', {
    p_reader_hash: hash,
    p_slot_key: String(rotationKey),
    p_placement: placement,
    p_event_type: eventType,
    p_product_ids: ids,
  })
  if (error) throw error
  const output = Array.isArray(data) ? data[0] : data
  invalidateSmartPdfExposure(hash)
  for (const id of ids) totalCache.delete(id)
  return {
    accepted_count: Number(output?.accepted_count || 0),
    new_impressions: Number(output?.new_impressions || 0),
    new_clicks: Number(output?.new_clicks || 0),
  }
}
