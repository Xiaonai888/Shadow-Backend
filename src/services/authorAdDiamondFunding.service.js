import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fundingError(status, code, message) {
  const error = new Error(message)
  error.httpStatus = status
  error.publicCode = code
  return error
}

function requireUuid(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!UUID.test(id)) {
    throw fundingError(400, 'INVALID_AUTHOR_AD_ID', 'Invalid campaign or account ID')
  }
  return id
}

export async function reserveAuthorAdDiamonds({ campaignId, ownerUserId }) {
  const id = requireUuid(campaignId)
  const ownerId = requireUuid(ownerUserId)
  const { data, error } = await supabase.rpc('reserve_author_ad_diamonds_v1', {
    p_campaign_id: id,
    p_owner_user_id: ownerId,
  })

  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw fundingError(503, 'AUTHOR_AD_DIAMOND_SQL_REQUIRED', 'Diamond funding is not available yet')
    }
    if (error.code === 'P0001') {
      throw fundingError(409, 'AUTHOR_AD_DIAMOND_FUNDING_DENIED', error.message)
    }
    if (error.code === '22023') {
      throw fundingError(400, 'INVALID_AUTHOR_AD_DIAMOND_BUDGET', error.message)
    }
    throw error
  }

  const row = Array.isArray(data) ? data[0] : data
  const diamonds = Number(row?.reserved_diamonds)
  const balance = Number(row?.wallet_balance)

  if (!row || row.campaign_id !== id || typeof row.recorded !== 'boolean'
    || !Number.isSafeInteger(diamonds) || diamonds < 100 || diamonds > 1000000
    || !Number.isSafeInteger(balance) || balance < 0) {
    throw fundingError(502, 'INVALID_AUTHOR_AD_DIAMOND_RESULT', 'Invalid Diamond funding response')
  }

  return {
    recorded: row.recorded,
    campaignId: id,
    reservedDiamonds: diamonds,
    walletBalance: balance,
  }
}
