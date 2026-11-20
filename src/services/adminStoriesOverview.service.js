import { supabase } from '../config/supabase.js'
import { getAdminStoryLanguage } from './adminStoryLanguage.service.js'

const SUMMARY_FIELDS = Object.freeze([
  'total_stories',
  'active_stories',
  'deleted_by_authors',
  'restricted_stories',
  'disabled_stories',
  'warned_stories',
  'disabled_authors',
  'new_stories',
  'ongoing_stories',
  'completed_stories',
])

export async function loadAdminStoriesOverview(rawLanguage = 'all') {
  const language = getAdminStoryLanguage(rawLanguage)
  const { data, error } = await supabase.rpc('get_admin_story_language_overview', {
    p_language: language,
  })
  if (error) throw error
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid stories overview response')
  }
  const summary = {}
  for (const field of SUMMARY_FIELDS) {
    const value = data[field]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid stories overview totals')
    }
    summary[field] = value
  }
  return summary
}
