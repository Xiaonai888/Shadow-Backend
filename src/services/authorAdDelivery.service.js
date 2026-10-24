import { createHmac } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENT_TYPES = new Set(['impression', 'click', 'reading_start', 'follow', 'unlock', 'purchase'])
const MAX_CHARGE_CENTS = 1000000

function validUuid(value) {
  return typeof value === 'string' && UUID.test(value.trim())
}

function safeText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > 0 && text.length <= max ? text : ''
}

function hmac(namespace, value) {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 16) throw new Error('Author ad event signing is not configured')
  return createHmac('sha256', secret).update(namespace).update(':').update(value).digest('hex')
}

function cents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CHARGE_CENTS) {
    throw new TypeError(`Invalid ${field}`)
  }
  return value
}

function eventPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('A verified author ad event is required')
  }

  const campaignId = safeText(input.campaignId, 36)
  const actionId = safeText(input.verifiedActionId, 256)
  const eventType = safeText(input.eventType, 32)
  const viewerUserId = safeText(input.viewerUserId, 36)
  const verifiedSessionId = safeText(input.verifiedSessionId, 256)
  const chargeCents = cents(input.chargeCents ?? 0, 'charge amount')
  const attributedRevenueCents = cents(input.attributedRevenueCents ?? 0, 'attributed revenue')

  if (!validUuid(campaignId) || !actionId || !EVENT_TYPES.has(eventType)) {
    throw new TypeError('Invalid verified author ad event identity')
  }
  if (viewerUserId && !validUuid(viewerUserId)) {
    throw new TypeError('Invalid verified author ad viewer')
  }
  if (!viewerUserId && !verifiedSessionId) {
    throw new TypeError('A verified viewer is required')
  }
  if (eventType !== 'purchase' && attributedRevenueCents > 0) {
    throw new TypeError('Attributed revenue requires a verified purchase')
  }

  const metadata = input.metadata ?? {}
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('Invalid author ad delivery metadata')
  }
  if (Buffer.byteLength(JSON.stringify(metadata)) > 4096) {
    throw new TypeError('Author ad delivery metadata exceeds 4 KB')
  }

  return {
    p_campaign_id: campaignId,
    p_event_key: hmac('shadow-author-ad-event-v1', `${campaignId}:${eventType}:${actionId}`),
    p_event_type: eventType,
    p_viewer_user_id: viewerUserId || null,
    p_viewer_session_hash: verifiedSessionId
      ? hmac('shadow-author-ad-viewer-v1', verifiedSessionId)
      : null,
    p_amount_cents: chargeCents,
    p_attributed_revenue_cents: attributedRevenueCents,
    p_metadata: metadata,
  }
}

export async function recordVerifiedAuthorAdDelivery(input) {
  const payload = eventPayload(input)
  const { data, error } = await supabase.rpc('record_author_ad_delivery_spend_v1', payload)
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      const missing = new Error('Author ad delivery SQL is not installed')
      missing.code = 'AUTHOR_AD_DELIVERY_SQL_REQUIRED'
      throw missing
    }
    throw error
  }

  const result = Array.isArray(data) ? data[0] : data
  if (!result || result.campaign_id !== payload.p_campaign_id || !validUuid(result.event_id)) {
    throw new Error('Author ad delivery response is invalid')
  }

  return {
    recorded: result.recorded === true,
    campaignId: result.campaign_id,
    eventId: result.event_id,
    status: result.campaign_status,
    spentCents: Number(result.spent_cents),
    remainingCents: Number(result.remaining_cents),
  }
}
