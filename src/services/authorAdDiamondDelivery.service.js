import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTENT_TYPES = new Set(['post', 'story', 'product'])

function deliveryError(status, code, message) {
  const error = new Error(message)
  error.httpStatus = status
  error.publicCode = code
  return error
}

function requireUuid(value, name) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!UUID.test(id)) {
    throw deliveryError(400, 'INVALID_AUTHOR_AD_DIAMOND_REACH', `Invalid ${name}`)
  }
  return id
}

function requireVisibility(visibleMs, visibleRatio) {
  if (!Number.isSafeInteger(visibleMs) || visibleMs < 1000 || visibleMs > 120000
    || typeof visibleRatio !== 'number' || !Number.isFinite(visibleRatio)
    || visibleRatio < 0.5 || visibleRatio > 1) {
    throw deliveryError(400, 'INVALID_AUTHOR_AD_DIAMOND_REACH', 'Invalid ad visibility')
  }
}

export async function recordVerifiedAuthorAdDiamondReach({
  campaignId,
  viewerUserId,
  verifiedActionId,
  contentType,
  visibleMs,
  visibleRatio,
} = {}) {
  if (process.env.AUTHOR_ADS_DELIVERY_ENABLED !== 'true') {
    throw deliveryError(503, 'AUTHOR_ADS_DELIVERY_DISABLED', 'Boost delivery is disabled')
  }
  if (!CONTENT_TYPES.has(contentType)) {
    throw deliveryError(400, 'INVALID_AUTHOR_AD_DIAMOND_REACH', 'Invalid Boost content type')
  }
  if (contentType !== 'post' && process.env.AUTHOR_ADS_BOOK_DELIVERY_ENABLED !== 'true') {
    throw deliveryError(503, 'AUTHOR_ADS_BOOK_DELIVERY_DISABLED', 'Book Boost delivery is disabled')
  }

  const id = requireUuid(campaignId, 'campaign ID')
  const viewerId = requireUuid(viewerUserId, 'viewer ID')
  const actionId = requireUuid(verifiedActionId, 'receipt action ID')
  requireVisibility(visibleMs, visibleRatio)

  const { data, error } = await supabase.rpc('record_author_ad_diamond_reach_v1', {
    p_campaign_id: id,
    p_viewer_user_id: viewerId,
    p_verified_action_id: actionId,
    p_metadata: {
      content_type: contentType,
      measurement: 'client_reported',
      reported_visible_ms: visibleMs,
      reported_visible_ratio: visibleRatio,
    },
  })

  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw deliveryError(503, 'AUTHOR_AD_DIAMOND_REACH_SQL_REQUIRED', 'Diamond reach is not available yet')
    }
    if (error.code === 'P0001' || error.code === 'P0002') {
      throw deliveryError(409, 'AUTHOR_AD_DIAMOND_REACH_DENIED', 'Boost campaign is not eligible')
    }
    if (error.code === '22023' || error.code === '23505') {
      throw deliveryError(400, 'INVALID_AUTHOR_AD_DIAMOND_REACH', 'Invalid Diamond reach event')
    }
    throw error
  }

  const row = Array.isArray(data) ? data[0] : data
  const spent = Number(row?.spent_diamonds)
  const remaining = Number(row?.remaining_diamonds)
  if (!row || row.campaign_id !== id || !UUID.test(String(row.event_id || ''))
    || typeof row.recorded !== 'boolean'
    || !['active', 'completed', 'paused', 'scheduled', 'cancelled', 'rejected'].includes(row.campaign_status)
    || !Number.isSafeInteger(spent) || spent < 0
    || !Number.isSafeInteger(remaining) || remaining < 0) {
    throw deliveryError(502, 'INVALID_AUTHOR_AD_DIAMOND_REACH_RESULT', 'Invalid Diamond reach response')
  }

  return {
    recorded: row.recorded,
    campaignId: id,
    eventId: row.event_id,
    status: row.campaign_status,
    spentDiamonds: spent,
    remainingDiamonds: remaining,
  }
}
