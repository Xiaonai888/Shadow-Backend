import { supabase } from '../config/supabase.js'

const DAY_MS = 86400000
const FIRST_EVENT_MS = Date.UTC(2026, 10, 2)
const EVENT_INTERVAL_DAYS = 28
const EVENT_LENGTH_DAYS = 7
const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function khmerToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = (type) => parts.find((part) => part.type === type)?.value
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function getShadowReadEventReadingWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null
  const today = khmerToday(now)
  const todayMs = Date.parse(`${today}T00:00:00.000Z`)
  const elapsedDays = (todayMs - FIRST_EVENT_MS) / DAY_MS
  if (elapsedDays < 0 || !Number.isInteger(elapsedDays)) return null

  const cycleDay = elapsedDays % EVENT_INTERVAL_DAYS
  if (cycleDay >= EVENT_LENGTH_DAYS) return null

  const eventStartMs = todayMs - cycleDay * DAY_MS
  const dayStartMs = todayMs - CAMBODIA_OFFSET_MS
  return {
    startsOn: new Date(eventStartMs).toISOString().slice(0, 10),
    dayNumber: cycleDay + 1,
    dayStartIso: new Date(dayStartMs).toISOString(),
    nextDayStartIso: new Date(dayStartMs + DAY_MS).toISOString(),
  }
}

export async function recordShadowReadEventReadingScore({ userId, storyId, episodeId } = {}) {
  const user = String(userId || '').trim()
  const story = String(storyId || '').trim()
  const episode = String(episodeId || '').trim()
  if (![user, story, episode].every((value) => UUID.test(value))) {
    return { ok: false, reason: 'invalid_reading_identifiers' }
  }

  const window = getShadowReadEventReadingWindow()
  if (!window) return { ok: true, awarded: false, reason: 'event_not_running' }

  const { data: event, error: eventError } = await supabase
    .from('shadow_read_event_weeks')
    .select('id')
    .eq('starts_on', window.startsOn)
    .eq('audience_group', 'kh')
    .eq('is_enabled', true)
    .maybeSingle()
  if (eventError) throw eventError
  if (!event) return { ok: true, awarded: false, reason: 'event_not_enabled' }

  const { data: participant, error: participantError } = await supabase
    .from('shadow_read_event_participants')
    .select('joined_at')
    .eq('event_id', event.id)
    .eq('user_id', user)
    .eq('reader_group_snapshot', 'kh')
    .maybeSingle()
  if (participantError) throw participantError
  if (!participant) return { ok: true, awarded: false, reason: 'not_joined' }

  const joinedAt = new Date(participant.joined_at).getTime()
  const minimumReadAt = Math.max(joinedAt, Date.parse(window.dayStartIso))
  if (!Number.isFinite(minimumReadAt)) throw new Error('Invalid Read Event join time')

  const [readingResult, missionResult] = await Promise.all([
    supabase.from('reader_weekly_reading_episodes')
      .select('episode_id,story_id,counted_at')
      .eq('user_id', user)
      .eq('week_start', window.startsOn)
      .eq('story_id', story)
      .eq('episode_id', episode)
      .gte('counted_at', new Date(minimumReadAt).toISOString())
      .lt('counted_at', window.nextDayStartIso)
      .maybeSingle(),
    supabase.from('shadow_read_event_missions')
      .select('id,slot,mission_type,story_id,target_amount,max_points')
      .eq('event_id', event.id)
      .eq('day_number', window.dayNumber)
      .in('mission_type', ['daily_story', 'free_read'])
      .order('slot', { ascending: true })
      .limit(2),
  ])
  if (readingResult.error) throw readingResult.error
  if (missionResult.error) throw missionResult.error
  if (!readingResult.data) return { ok: true, awarded: false, reason: 'reading_not_verified' }

  const missions = (missionResult.data || []).filter((mission) =>
    mission.mission_type === 'free_read' ||
    (mission.mission_type === 'daily_story' && String(mission.story_id) === story)
  )
  if (!missions.length) return { ok: true, awarded: false, reason: 'no_matching_mission' }

  const credited = []
  for (const mission of missions) {
    const target = Number(mission.target_amount)
    const maximum = Number(mission.max_points)
    if (!Number.isInteger(target) || target < 1 || !Number.isInteger(maximum) || maximum < 1) {
      throw new Error('Invalid Read Event mission point configuration')
    }

    const pointsPerEpisode = Math.ceil(maximum / target)
    const { data, error } = await supabase.rpc('shadow_read_event_record_mission_points', {
      p_event_id: event.id,
      p_user_id: user,
      p_mission_id: mission.id,
      p_evidence_key: `episode:${episode}`,
      p_points: pointsPerEpisode,
    })
    if (error) throw error
    const result = Array.isArray(data) ? data[0] : data
    if (!result || result.ok !== true) throw new Error('Invalid Read Event mission score response')
    credited.push({
      mission_id: mission.id,
      awarded: result.awarded === true,
      points_added: Number(result.points_added || 0),
      reason: result.reason || null,
    })
  }

  return {
    ok: true,
    awarded: credited.some((item) => item.awarded),
    event_id: event.id,
    day_number: window.dayNumber,
    missions: credited,
  }
}
