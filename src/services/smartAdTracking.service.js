import { createHmac } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { smartAdCambodiaSlot, SMART_AD_POLICY } from './smartAdEligibility.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VISITOR = /^[a-zA-Z0-9._:-]{8,128}$/
const EVENT_TYPES = new Set(['impression', 'click'])
const PLACEMENTS = new Set(['discover', 'opening', 'freeUnlock', 'me'])
const STATS_TTL_MS = 60000
const MAX_STATS_CACHE = 4000
const statsCache = new Map()

export class SmartAdRequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'SmartAdRequestError'
    this.status = status
  }
}

export function requireSmartAdPlacement(value) {
  const placement = String(value || '').trim()
  if (!PLACEMENTS.has(placement)) throw new SmartAdRequestError('Unknown Smart Ad placement')
  return placement
}

export function getSmartAdReaderHash(req) {
  const secret = String(process.env.JWT_SECRET || '')
  if (!secret) throw new Error('JWT_SECRET must be configured')
  const authHeader = String(req.headers?.authorization || '')
  let identity
  if (authHeader) {
    if (!authHeader.startsWith('Bearer ')) throw new SmartAdRequestError('Invalid authorization', 401)
    try {
      const payload = jwt.verify(authHeader.slice(7), secret)
      if (payload?.type !== 'reader' || !payload?.user_id) {
        throw new SmartAdRequestError('Reader authentication required', 403)
      }
      identity = `reader:${String(payload.user_id)}`
    } catch (error) {
      if (error instanceof SmartAdRequestError) throw error
      throw new SmartAdRequestError('Invalid reader authentication', 401)
    }
  } else {
    const visitor = String(req.headers?.['x-shadow-visitor-id'] || '').trim()
    if (!VISITOR.test(visitor)) {
      throw new SmartAdRequestError('X-Shadow-Visitor-Id is required for anonymous Smart Ads')
    }
    identity = `visitor:${visitor}`
  }
  return createHmac('sha256', secret).update(`shadow-smart-ad:v1:${identity}`).digest('hex')
}

export function validateSmartAdStoryIds(value, max = 10) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new SmartAdRequestError(`Supply 1-${max} story IDs`)
  }
  const ids = [...new Set(value.map((entry) => String(entry || '').trim().toLowerCase()))]
  if (ids.some((id) => !UUID.test(id))) throw new SmartAdRequestError('Invalid story ID')
  return ids
}

export function resolveSmartAdEventSlot(value, now = Date.now()) {
  const current = smartAdCambodiaSlot(now).slot_key
  if (!value || value === current) return current
  const previous = smartAdCambodiaSlot(now - SMART_AD_POLICY.rotationMs).slot_key
  if (String(value) === previous) return previous
  throw new SmartAdRequestError('Smart Ad rotation slot has expired', 409)
}

export async function readSmartAdSeenHistory(readerHash, slotKey, { db = supabase } = {}) {
  const { data, error } = await db.from('smart_ad_reader_exposure')
    .select('story_id')
    .eq('reader_hash', readerHash)
    .eq('slot_key', slotKey)
    .limit(SMART_AD_POLICY.maxCapacity)
  if (error) throw error
  return (data || []).map((row) => String(row.story_id))
}

export async function readSmartAdExposureTotals(storyIds, { db = supabase, now = Date.now() } = {}) {
  const ids = [...new Set((Array.isArray(storyIds) ? storyIds : []).map(String))]
  const response = {}
  const missing = []
  for (const id of ids) {
    const item = statsCache.get(id)
    if (item && item.expiresAt > now) response[id] = item.value
    else missing.push(id)
  }
  for (let start = 0; start < missing.length; start += 100) {
    const chunk = missing.slice(start, start + 100)
    const { data, error } = await db.from('smart_ad_story_exposure_totals')
      .select('story_id,impressions,clicks').in('story_id', chunk)
    if (error) throw error
    const result = new Map((data || []).map((row) => [String(row.story_id), row]))
    for (const id of chunk) {
      const row = result.get(id)
      const value = { impressions: Number(row?.impressions || 0), clicks: Number(row?.clicks || 0) }
      response[id] = value
      if (statsCache.size >= MAX_STATS_CACHE) statsCache.delete(statsCache.keys().next().value)
      statsCache.set(id, { value, expiresAt: now + STATS_TTL_MS })
    }
  }
  return response
}

export async function recordSmartAdEvents({
  readerHash, slotKey, placement, type, storyIds, db = supabase,
}) {
  requireSmartAdPlacement(placement)
  if (!EVENT_TYPES.has(type)) throw new SmartAdRequestError('Unknown Smart Ad event type')
  const ids = validateSmartAdStoryIds(storyIds)
  const { data, error } = await db.rpc('smart_ad_record_events_v1', {
    p_reader_hash: readerHash,
    p_slot_key: slotKey,
    p_placement: placement,
    p_event_type: type,
    p_story_ids: ids,
  })
  if (error) throw error
  for (const id of ids) statsCache.delete(id)
  const item = Array.isArray(data) ? data[0] : data
  return {
    accepted_count: Number(item?.accepted_count || 0),
    new_impressions: Number(item?.new_impressions || 0),
    new_clicks: Number(item?.new_clicks || 0),
  }
}
