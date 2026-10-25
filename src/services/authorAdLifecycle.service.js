import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OWNER_ACTIONS = new Set(['start', 'pause', 'resume'])

function lifecycleError(code, message, status = 409) {
  const error = new Error(message)
  error.code = code
  error.httpStatus = status
  error.publicCode = code
  return error
}

function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value.trim())) {
    throw lifecycleError('INVALID_AUTHOR_AD_ID', `Invalid ${field}`, 400)
  }
  return value.trim()
}

function requireOwnerAction(value) {
  if (typeof value !== 'string' || !OWNER_ACTIONS.has(value)) {
    throw lifecycleError('INVALID_AUTHOR_AD_ACTION', 'Invalid campaign action', 400)
  }
  return value
}

function assertDeliveryEnabled(action, kind) {
  if (action !== 'start' && action !== 'resume') return
  if (process.env.AUTHOR_ADS_DELIVERY_ENABLED !== 'true') {
    throw lifecycleError('AUTHOR_ADS_DELIVERY_NOT_READY', 'Boost delivery is not enabled yet', 503)
  }
  if (kind === 'book' && process.env.AUTHOR_ADS_BOOK_DELIVERY_ENABLED !== 'true') {
    throw lifecycleError('AUTHOR_ADS_BOOK_DELIVERY_NOT_READY', 'Book Boost delivery is not enabled yet', 503)
  }
}

async function transition(campaignId, action, ownerUserId = null) {
  const atomicDiamondStart = action === 'start' && typeof ownerUserId === 'string'
  const functionName = atomicDiamondStart
    ? 'start_author_ad_campaign_with_diamonds_v1'
    : 'transition_author_ad_campaign_v1'
  const params = atomicDiamondStart
    ? { p_campaign_id: campaignId, p_owner_user_id: ownerUserId }
    : { p_campaign_id: campaignId, p_action: action }

  const { data, error } = await supabase.rpc(functionName, params)

  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883' ||
      error.code === '42P01' || error.code === 'PGRST205') {
      throw lifecycleError(
        atomicDiamondStart ? 'AUTHOR_AD_DIAMOND_START_SQL_REQUIRED' : 'AUTHOR_AD_LIFECYCLE_SQL_REQUIRED',
        atomicDiamondStart ? 'Atomic Diamond Boost start SQL is not installed' : 'Author ad lifecycle SQL is not installed',
        503
      )
    }
    if (error.code === 'P0002') {
      throw lifecycleError('AUTHOR_AD_CAMPAIGN_NOT_FOUND', 'Campaign not found', 404)
    }
    if (error.code === 'P0001') {
      throw lifecycleError(
        atomicDiamondStart ? 'AUTHOR_AD_DIAMOND_START_DENIED' : 'AUTHOR_AD_TRANSITION_DENIED',
        atomicDiamondStart ? 'Campaign cannot start or Reader Diamonds balance is insufficient' : 'Campaign cannot change status yet'
      )
    }
    if (error.code === '22023') {
      throw lifecycleError('INVALID_AUTHOR_AD_DIAMOND_START', 'Invalid campaign funding request', 400)
    }
    throw error
  }

  const row = Array.isArray(data) ? data[0] : data
  const fundedCents = Number(row?.funded_cents)
  const spentCents = Number(row?.spent_cents)
  const availableCents = Number(row?.available_cents)

  if (!row || row.campaign_id !== campaignId
    || typeof row.changed !== 'boolean'
    || !['approved', 'active', 'paused', 'completed'].includes(row.campaign_status)
    || ![fundedCents, spentCents, availableCents].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw lifecycleError('INVALID_AUTHOR_AD_LIFECYCLE_RESULT', 'Invalid campaign lifecycle response', 502)
  }

  return {
    changed: row.changed,
    campaignId: row.campaign_id,
    status: row.campaign_status,
    startAt: row.starts_at || null,
    endAt: row.ends_at || null,
    fundedCents,
    spentCents,
    availableCents,
  }
}

export async function transitionOwnedAuthorAdCampaign({ campaignId, ownerUserId, action }) {
  const id = requireUuid(campaignId, 'campaign ID')
  const ownerId = requireUuid(ownerUserId, 'author identity')
  const transitionAction = requireOwnerAction(action)

  const { data, error } = await supabase.from('author_ad_campaigns')
    .select('id,status,campaign_kind,funded_cents,spent_cents,refunded_cents')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()

  if (error) throw error
  if (!data) {
    throw lifecycleError('AUTHOR_AD_CAMPAIGN_NOT_FOUND', 'Campaign not found', 404)
  }

  assertDeliveryEnabled(transitionAction, data.campaign_kind)

  const money = [data.funded_cents, data.spent_cents, data.refunded_cents].map(Number)
  if (!money.every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw lifecycleError('INVALID_AUTHOR_AD_FUNDING', 'Invalid campaign funding state', 409)
  }

  const atomicDiamondStart = transitionAction === 'start' && data.status === 'approved' &&
    money.every(value => value === 0)

  return transition(id, transitionAction, atomicDiamondStart ? ownerId : null)
}

export async function expireAuthorAdCampaign(campaignId) {
  const id = requireUuid(campaignId, 'campaign ID')
  return transition(id, 'expire')
}
