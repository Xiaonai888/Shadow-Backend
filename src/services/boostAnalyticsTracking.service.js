import { createHmac } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const CAMPAIGN_EVENTS = new Set(['impression', 'click', 'engagement', 'follow', 'open', 'read', 'unlock'])
const READER_EVENTS = new Set(['impression', 'open', 'read', 'save', 'follow', 'unlock'])
const PURCHASE_KINDS = new Set(['episode', 'book', 'pdf'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86400000
let cleanupStarted = false

function hash(namespace, value) {
  if (!process.env.JWT_SECRET) throw new Error('Missing JWT_SECRET')
  return createHmac('sha256', process.env.JWT_SECRET).update(`${namespace}:${String(value)}`).digest('hex')
}

function todayKh() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function normalizedTags(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.filter((value) => typeof value === 'string').map((value) => value.trim().slice(0, 50)).filter(Boolean))].slice(0, 10)
}

function countCents(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

export async function recordReaderBoostInterest({ readerId, eventType, sourceId, actionId, genre, tags }) {
  if (!readerId || !sourceId || !actionId || !READER_EVENTS.has(eventType)) return { recorded: false }
  const visitorKey = hash('shadow-reader-v1', readerId)
  const eventKey = hash('shadow-reader-interest-v1', `${visitorKey}:${eventType}:${sourceId}:${actionId}`)
  const { error } = await supabase.from('shadow_reader_interest_events').upsert({
    event_key: eventKey,
    visitor_key: visitorKey,
    event_kind: eventType,
    source_key: hash('shadow-content-v1', sourceId),
    genre: typeof genre === 'string' ? genre.trim().slice(0, 80) : null,
    tags: normalizedTags(tags),
    event_day: todayKh(),
  }, { onConflict: 'event_key', ignoreDuplicates: true })
  if (error) throw error
  return { recorded: true }
}

export async function recordBoostCampaignEvent({ campaignId, readerId, verifiedVisitorId, eventType, actionId }) {
  if (!UUID.test(String(campaignId || '')) || !CAMPAIGN_EVENTS.has(eventType) || (!readerId && !verifiedVisitorId)) {
    return { recorded: false }
  }
  const { data: campaign, error: lookupError } = await supabase
    .from('shadow_boost_campaigns')
    .select('id,status,starts_at,ends_at')
    .eq('id', campaignId)
    .maybeSingle()
  if (lookupError) throw lookupError
  const now = Date.now()
  if (!campaign || campaign.status !== 'active' || !campaign.starts_at || !campaign.ends_at || now < Date.parse(campaign.starts_at) || now > Date.parse(campaign.ends_at)) {
    return { recorded: false }
  }
  const visitorKey = readerId
    ? hash('shadow-reader-v1', readerId)
    : hash('shadow-verified-visitor-v1', verifiedVisitorId)
  const dedupeSource = actionId || `${todayKh()}:${visitorKey}:${eventType}`
  const eventKey = hash('shadow-boost-event-v1', `${campaignId}:${eventType}:${dedupeSource}`)
  const { error } = await supabase.from('shadow_boost_events').upsert({
    event_key: eventKey,
    campaign_id: campaignId,
    visitor_key: visitorKey,
    event_kind: eventType,
    event_day: todayKh(),
  }, { onConflict: 'event_key', ignoreDuplicates: true })
  if (error) throw error
  return { recorded: true }
}

export async function recordVerifiedBoostConversion({ campaignId, readerId, purchaseKind, orderId, grossCents, platformShareCents, verifiedAt }) {
  if (
    !UUID.test(String(campaignId || '')) || !readerId || !orderId || !PURCHASE_KINDS.has(purchaseKind) ||
    countCents(grossCents) === null || countCents(platformShareCents) === null || platformShareCents > grossCents
  ) return { recorded: false }

  const verifiedTime = verifiedAt ? Date.parse(verifiedAt) : Date.now()
  if (!Number.isFinite(verifiedTime) || verifiedTime > Date.now() + 60000) return { recorded: false }
  const visitorKey = hash('shadow-reader-v1', readerId)
  const windowStart = new Date(verifiedTime - 7 * DAY_MS).toISOString()
  const { data: interaction, error: interactionError } = await supabase
    .from('shadow_boost_events')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('visitor_key', visitorKey)
    .in('event_kind', ['click', 'open'])
    .gte('created_at', windowStart)
    .lte('created_at', new Date(verifiedTime).toISOString())
    .limit(1)
  if (interactionError) throw interactionError
  if (!interaction?.length) return { recorded: false }

  const { error } = await supabase.from('shadow_boost_conversions').upsert({
    campaign_id: campaignId,
    purchase_kind: purchaseKind,
    order_key: hash('shadow-verified-order-v1', `${purchaseKind}:${orderId}`),
    gross_cents: grossCents,
    platform_share_cents: platformShareCents,
    verified_at: new Date(verifiedTime).toISOString(),
  }, { onConflict: 'purchase_kind,order_key', ignoreDuplicates: true })
  if (error) throw error
  return { recorded: true }
}

export function startBoostAnalyticsRetention() {
  if (cleanupStarted) return
  cleanupStarted = true
  const cleanup = async () => {
    const { error } = await supabase.rpc('prune_shadow_boost_analytics_v2')
    if (error) console.error('BOOST_ANALYTICS_RETENTION_ERROR:', error)
  }
  cleanup().catch((error) => console.error('BOOST_ANALYTICS_RETENTION_ERROR:', error))
  const timer = setInterval(() => cleanup().catch((error) => console.error('BOOST_ANALYTICS_RETENTION_ERROR:', error)), DAY_MS)
  timer.unref?.()
}
