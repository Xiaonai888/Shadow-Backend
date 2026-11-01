import { supabase } from '../config/supabase.js'
import {
  requireReadEventId,
  validateRewardReadiness,
  validateFeaturedCardAudit,
} from './shadowReadEventRewardAudit.validation.js'

function unwrap(result) {
  return Array.isArray(result) ? result[0] : result
}

export async function readShadowReadEventRewardAudit({ eventId }) {
  const id = requireReadEventId(eventId)
  const [readiness, cards] = await Promise.all([
    supabase.rpc('shadow_read_event_reward_readiness_audit', { p_event_id: id }),
    supabase.rpc('shadow_read_event_featured_card_audit', { p_event_id: id }),
  ])

  if (readiness.error) throw readiness.error
  if (cards.error) throw cards.error

  return {
    event_id: id,
    readiness: validateRewardReadiness(unwrap(readiness.data), id),
    featured_cards: validateFeaturedCardAudit(unwrap(cards.data), id),
  }
}
