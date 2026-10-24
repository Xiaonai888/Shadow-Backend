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

async function transition(campaignId, action) {
  const { data, error } = await supabase.rpc('transition_author_ad_campaign_v1', {
    p_campaign_id: campaignId,
    p_action: action,
  })

  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw lifecycleError('AUTHOR_AD_LIFECYCLE_SQL_REQUIRED', 'Author ad lifecycle SQL is not installed', 503)
    }
    if (error.code === 'P0002') {
      throw lifecycleError('AUTHOR_AD_CAMPAIGN_NOT_FOUND', 'Campaign not found', 404)
    }
    if (error.code === 'P0001') {
      throw lifecycleError('AUTHOR_AD_TRANSITION_DENIED', 'Campaign cannot change status yet')
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
    .select('id')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()

  if (error) throw error
  if (!data) {
    throw lifecycleError('AUTHOR_AD_CAMPAIGN_NOT_FOUND', 'Campaign not found', 404)
  }

  return transition(id, transitionAction)
}

export async function expireAuthorAdCampaign(campaignId) {
  const id = requireUuid(campaignId, 'campaign ID')
  return transition(id, 'expire')
}
