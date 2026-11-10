import { supabase } from '../config/supabase.js'

const PERIODS = new Set([7, 28, 30])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateOwner(ownerId) {
  if (!UUID.test(String(ownerId || ''))) throw new TypeError('Invalid Studio owner.')
}

function validateTopic(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid Studio topic.')
  const topic = value.replace(/\s+/gu, ' ').trim()
  if (topic.length < 2 || topic.length > 80) throw new TypeError('Invalid Studio topic.')
  return topic
}

function requireData({ data, error }) {
  if (error) throw error
  const result = Array.isArray(data) ? data[0] : data
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Invalid Studio trends response.')
  }
  return result
}

export async function studioTrendsSummary(ownerId, days = 30) {
  validateOwner(ownerId)
  if (!PERIODS.has(days)) throw new TypeError('Invalid Studio trends period.')

  const [trends, saved] = await Promise.all([
    supabase.rpc('shadow_studio_trends_summary', { p_days: days }),
    supabase.from('shadow_studio_saved_topics')
      .select('topic,created_at')
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(30),
  ])

  if (saved.error) throw saved.error
  const result = requireData(trends)
  return {
    ...result,
    saved_topics: (saved.data || []).map(row => ({ title: row.topic, saved_at: row.created_at })),
  }
}

export async function studioSaveTopic(ownerId, value) {
  validateOwner(ownerId)
  const topic = validateTopic(value)
  return requireData(await supabase.rpc('shadow_studio_save_topic', {
    p_owner: ownerId,
    p_topic: topic,
  }))
}

export async function studioRemoveSavedTopic(ownerId, value) {
  validateOwner(ownerId)
  const topic = validateTopic(value)
  return requireData(await supabase.rpc('shadow_studio_remove_saved_topic', {
    p_owner: ownerId,
    p_topic: topic,
  }))
}
