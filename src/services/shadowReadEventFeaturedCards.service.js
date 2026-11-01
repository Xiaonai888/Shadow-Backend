import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requiredUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError('Invalid Featured Story Card identifier')
  }
  return value
}

function safeBalance(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Invalid Featured Story Card balance')
  }
  return parsed
}

export async function readFeaturedStoryCards({ eventId, userId }) {
  const event_id = requiredUuid(eventId)
  const user_id = requiredUuid(userId)

  const { data, error } = await supabase
    .from('shadow_read_event_featured_card_balances')
    .select('story_id,granted_cards,spent_cards,updated_at')
    .eq('event_id', event_id)
    .eq('user_id', user_id)
    .maybeSingle()

  if (error) throw error
  if (!data) return { event_id, user_id, story_id: null, available_cards: 0 }
  const granted = safeBalance(data.granted_cards)
  const spent = safeBalance(data.spent_cards)
  if (spent > granted) throw new Error('Invalid Featured Story Card ledger')

  return {
    event_id, user_id,
    story_id: data.story_id,
    available_cards: granted - spent,
    granted_cards: granted,
    spent_cards: spent,
    updated_at: data.updated_at,
  }
}

export async function creditFeaturedStoryCardClaim({ claimId }) {
  const { data, error } = await supabase.rpc('shadow_read_event_credit_featured_cards', {
    p_claim_id: requiredUuid(claimId),
  })
  if (error) throw error
  const result = Array.isArray(data) ? data[0] : data
  if (!result || result.ok !== true || typeof result.credited !== 'boolean') {
    throw new Error('Invalid Featured Story Card credit result')
  }
  return result
}

export async function redeemFeaturedStoryCards({ eventId, userId, episodeId }) {
  const { data, error } = await supabase.rpc('shadow_read_event_redeem_featured_cards', {
    p_event_id: requiredUuid(eventId),
    p_user_id: requiredUuid(userId),
    p_episode_id: requiredUuid(episodeId),
  })
  if (error) throw error
  const result = Array.isArray(data) ? data[0] : data
  if (!result || result.ok !== true || result.unlocked !== true ||
      typeof result.already_unlocked !== 'boolean' ||
      ![0, 10].includes(result.cards_spent) ||
      !Number.isSafeInteger(Number(result.remaining_cards)) || Number(result.remaining_cards) < 0) {
    throw new Error('Invalid Featured Story Card redemption result')
  }
  return result
}
