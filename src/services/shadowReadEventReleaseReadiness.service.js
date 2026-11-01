import { supabase } from '../config/supabase.js'
import { requireReadEventId } from './shadowReadEventRewardAudit.validation.js'
import { summarizeReadEventReleaseReadiness } from './shadowReadEventReleaseReadiness.validation.js'

function responseObject(result, name) {
  if (result.error) {
    const error = new Error(`Read Event ${name} unavailable`)
    error.code = result.error.code || 'READ_EVENT_AUDIT_RPC_FAILED'
    throw error
  }
  return Array.isArray(result.data) ? result.data[0] : result.data
}

export async function readShadowReadEventReleaseReadiness({ eventId }) {
  const id = requireReadEventId(eventId)

  const requests = [
    ['installation', 'shadow_read_event_integration_preflight'],
    ['rewards', 'shadow_read_event_reward_readiness_audit'],
    ['cards', 'shadow_read_event_featured_card_audit'],
    ['cutover', 'shadow_read_event_card_cutover_preflight'],
  ]

  const results = await Promise.all(requests.map(async ([name, procedure]) => ({
    name,
    result: await supabase.rpc(procedure, { p_event_id: id }),
  })))
  const response = Object.fromEntries(
    results.map(({ name, result }) => [name, responseObject(result, name)])
  )

  return summarizeReadEventReleaseReadiness({
    eventId: id,
    inspection: response.installation,
    readiness: response.rewards,
    cards: response.cards,
    cutover: response.cutover,
  })
}
