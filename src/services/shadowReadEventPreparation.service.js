import { supabase } from '../config/supabase.js'
import {
  getNextShadowReadEventStart,
  planShadowReadEvent,
  validateShadowReadEventStart,
} from './shadowReadEventPlanner.service.js'

const pendingPreparations = new Map()

async function readSavedEvent(startsOn) {
  const { data: week, error: weekError } = await supabase
    .from('shadow_read_event_weeks')
    .select('id,starts_on,featured_story_id,audience_group,is_enabled')
    .eq('starts_on', startsOn)
    .maybeSingle()

  if (weekError) throw weekError
  if (!week) return null

  const [missions, milestones, dailyStories] = await Promise.all([
    supabase.from('shadow_read_event_missions')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', week.id),
    supabase.from('shadow_read_event_milestones')
      .select('event_id', { count: 'exact', head: true })
      .eq('event_id', week.id),
    supabase.from('shadow_read_event_missions')
      .select('day_number,story_id')
      .eq('event_id', week.id)
      .eq('slot', 1)
      .order('day_number', { ascending: true })
      .limit(7),
  ])

  for (const result of [missions, milestones, dailyStories]) {
    if (result.error) throw result.error
  }

  const stories = dailyStories.data || []
  const storyIds = stories.map((item) => String(item.story_id || ''))
  if (
    week.audience_group !== 'kh' ||
    Number(missions.count) !== 35 ||
    Number(milestones.count) !== 35 ||
    stories.length !== 7 ||
    stories.some((item, index) => Number(item.day_number) !== index + 1) ||
    new Set(storyIds).size !== 7 ||
    storyIds.some((id) => !id || id === String(week.featured_story_id))
  ) {
    throw new Error(`Shadow Read Event ${startsOn} has an incomplete or invalid saved plan`)
  }

  return {
    event_id: week.id,
    starts_on: week.starts_on,
    featured_story_id: week.featured_story_id,
    daily_story_ids: storyIds,
    mission_count: 35,
    milestone_count: 35,
    is_enabled: Boolean(week.is_enabled),
  }
}

export async function prepareShadowReadEvent(startsOn) {
  validateShadowReadEventStart(startsOn)

  const inFlight = pendingPreparations.get(startsOn)
  if (inFlight) return inFlight

  const preparation = (async () => {
    const existing = await readSavedEvent(startsOn)
    if (existing) return { ok: true, created: false, ...existing }

    const plan = await planShadowReadEvent(startsOn)
    const { data, error } = await supabase.rpc('shadow_read_event_save_plan', {
      p_plan: {
        week: plan.week,
        missions: plan.missions,
        milestones: plan.milestones,
      },
    })

    if (error) throw error

    const result = Array.isArray(data) ? data[0] : data
    if (!result || result.ok !== true || !result.event_id || result.starts_on !== startsOn) {
      throw new Error('Shadow Read Event database did not confirm the saved plan')
    }

    const saved = await readSavedEvent(startsOn)
    if (!saved || String(saved.event_id) !== String(result.event_id)) {
      throw new Error('Shadow Read Event saved-plan verification failed')
    }

    return { ok: true, created: result.created === true, ...saved }
  })()

  pendingPreparations.set(startsOn, preparation)
  try {
    return await preparation
  } finally {
    if (pendingPreparations.get(startsOn) === preparation) {
      pendingPreparations.delete(startsOn)
    }
  }
}

export async function prepareNextShadowReadEvent() {
  return prepareShadowReadEvent(getNextShadowReadEventStart())
}
