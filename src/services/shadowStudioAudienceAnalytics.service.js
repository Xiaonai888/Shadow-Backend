import { supabase } from '../config/supabase.js'

const PERIODS = new Set([7, 28, 30])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function studioAudienceSummary(ownerId, days = 30) {
  if (!UUID.test(String(ownerId || '')) || !PERIODS.has(days)) {
    throw new TypeError('Invalid Studio audience request.')
  }

  const { data, error } = await supabase.rpc('shadow_studio_audience_summary', {
    p_owner: ownerId,
    p_days: days,
  })

  if (error) throw error
  const result = Array.isArray(data) ? data[0] : data
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Invalid Studio audience summary response.')
  }

  return result
}
