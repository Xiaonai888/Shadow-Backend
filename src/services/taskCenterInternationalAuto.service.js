import { supabase } from '../config/supabase.js'
import { invalidateActiveSessionMissionsCache } from './taskCenterMissionCache.service.js'

// Completely independent of taskCenterAuto.service.js (Khmer).
const AUDIENCE = 'international'
const STORY_LANGUAGE = 'English'
const HISTORY_TABLE = 'task_center_international_auto_story_history'
const SETTING_KEY = 'main'
const MISSION_LIMIT = 2
const MIN_EPISODES = 5
const RECENT_COOLDOWN_DAYS = 7
const MAX_STORIES = 5000
const MAX_HISTORY = 10000

function phnomPenhDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (name) => parts.find((item) => item.type === name)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function asTime(value) {
  const valueMs = value ? Date.parse(value) : 0
  return Number.isFinite(valueMs) ? valueMs : 0
}

function completed(story) {
  return String(story?.story_status || '').trim().toLowerCase() === 'completed'
}

function randomOne(rows) {
  return rows.length ? rows[Math.floor(Math.random() * rows.length)] : null
}

async function getSettings() {
  const { data, error } = await supabase
    .from('task_center_settings')
    .select('international_reading_mission_mode, international_auto_last_rotation_date, international_auto_last_rotated_at')
    .eq('setting_key', SETTING_KEY)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Task Center settings are missing')
  return data
}

async function getMissions() {
  const { data, error } = await supabase
    .from('task_center_reading_missions')
    .select('id, audience, is_active, target_minutes, sort_order, created_at')
    .eq('audience', AUDIENCE)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(MISSION_LIMIT + 1)
  if (error) throw error
  if ((data || []).length !== MISSION_LIMIT) {
    throw new Error('International Auto mode requires exactly 2 International Reading Missions')
  }
  return data
}

async function getEnglishStories() {
  const { data, error } = await supabase
    .from('stories')
    .select('id, title, story_language, story_status, status, deleted_at, is_shadow_exclusive, is_adult, total_episodes, updated_at')
    .eq('story_language', STORY_LANGUAGE)
    .eq('status', 'published')
    .is('deleted_at', null)
    .limit(MAX_STORIES)
  if (error) throw error
  return (data || []).filter((story) =>
    story.id &&
    String(story.title || '').trim() &&
    story.story_language === STORY_LANGUAGE &&
    !story.is_shadow_exclusive &&
    !story.is_adult &&
    Number(story.total_episodes || 0) >= MIN_EPISODES
  )
}

async function getRecentUpdateMap() {
  const { data, error } = await supabase.rpc('get_public_story_updates', {
    p_language: STORY_LANGUAGE,
    p_story_type: null,
    p_include_adult: false,
    p_days: RECENT_COOLDOWN_DAYS,
    p_limit_per_day: 100,
  })
  if (error) {
    // Recent updates are a ranking hint, not a reason to block English rotation.
    console.warn('INTERNATIONAL_AUTO_RECENT_UPDATES_UNAVAILABLE', error.code || error.message)
    return new Map()
  }
  const result = new Map()
  for (const row of data || []) {
    const id = String(row.id || '')
    if (!id) continue
    const old = result.get(id)
    if (!old || asTime(row.last_episode_published_at) > asTime(old.last_episode_published_at)) {
      result.set(id, row)
    }
  }
  return result
}

async function getHistory() {
  const { data, error } = await supabase
    .from(HISTORY_TABLE)
    .select('id, featured_date, slot, story_id, mission_id, selection_source, selected_at')
    .order('selected_at', { ascending: false })
    .limit(MAX_HISTORY)
  if (error) throw error
  return data || []
}

function lastSelectedStories(rows) {
  const map = new Map()
  for (const row of rows) {
    const id = String(row.story_id || '')
    if (!id) continue
    const previous = map.get(id)
    if (!previous || asTime(row.selected_at) > asTime(previous.selected_at)) map.set(id, row)
  }
  return map
}

function pickStory(stories, chosenIds, lastSelected, recent, cutoff) {
  const remaining = stories.filter((s) => !chosenIds.has(String(s.id)))
  if (!remaining.length) return null
  const unseen = remaining.filter((s) => !lastSelected.has(String(s.id)))
  const unseenUpdated = unseen.filter((s) => recent.has(String(s.id)))
  const first = randomOne(unseenUpdated)
  if (first) return { story: first, source: 'unseen' }
  const unseenCompleted = randomOne(unseen.filter(completed))
  if (unseenCompleted) return { story: unseenCompleted, source: 'unseen' }
  const unseenOther = randomOne(unseen)
  if (unseenOther) return { story: unseenOther, source: 'unseen' }
  const cooled = remaining.filter((s) => asTime(lastSelected.get(String(s.id))?.selected_at) < cutoff)
  const updated = randomOne(cooled.filter((s) => recent.has(String(s.id))))
  if (updated) return { story: updated, source: 'updated' }
  const complete = randomOne(cooled.filter(completed))
  if (complete) return { story: complete, source: 'completed' }
  // When all English stories were recently used, recycle the oldest first.
  const oldest = [...remaining].sort((a, b) =>
    asTime(lastSelected.get(String(a.id))?.selected_at) -
    asTime(lastSelected.get(String(b.id))?.selected_at)
  )[0]
  return oldest ? { story: oldest, source: 'recycle' } : null
}

function validTodaySelection(row, missions, storyById, slots, ids) {
  const slot = Number(row.slot)
  const storyId = String(row.story_id || '')
  const mission = missions[slot - 1]
  if (!Number.isInteger(slot) || slot < 1 || slot > MISSION_LIMIT) return false
  if (!mission || String(mission.id) !== String(row.mission_id || '')) return false
  if (!storyById.has(storyId) || slots.has(slot) || ids.has(storyId)) return false
  slots.add(slot)
  ids.add(storyId)
  return true
}

function toPublic(row) {
  return {
    slot: row.slot,
    mission_id: row.mission_id,
    story_id: String(row.story.id),
    story_title: row.story.title,
    story_status: row.story.story_status || null,
    story_link: `/story/${row.story.id}`,
    selection_source: row.source,
  }
}

async function saveTodaySelections(dateKey, selections, nowIso, missions, storyById) {
  const newSelections = selections.filter((s) => !s.existing)
  if (!newSelections.length) return selections
  const rows = newSelections.map((s) => ({
    featured_date: dateKey,
    slot: s.slot,
    story_id: String(s.story.id),
    mission_id: String(s.mission_id),
    selection_source: s.source,
    story_status: s.story.story_status || null,
    story_updated_at: s.story.updated_at || null,
    selected_at: nowIso,
  }))
  const { error } = await supabase.from(HISTORY_TABLE).insert(rows)
  if (!error) return selections
  if (String(error.code || '') !== '23505') throw error

  // Another server may already have selected today's stories. Reuse its result.
  const { data: concurrent, error: readError } = await supabase
    .from(HISTORY_TABLE)
    .select('id, featured_date, slot, story_id, mission_id, selection_source, selected_at')
    .eq('featured_date', dateKey)
    .order('slot', { ascending: true })
  if (readError) throw readError
  const seenSlots = new Set()
  const seenStories = new Set()
  const existing = (concurrent || [])
    .filter((row) => validTodaySelection(row, missions, storyById, seenSlots, seenStories))
    .map((row) => ({
      slot: Number(row.slot),
      mission_id: row.mission_id,
      story: storyById.get(String(row.story_id)),
      source: row.selection_source || 'recycle',
      existing: true,
    }))
  if (existing.length !== MISSION_LIMIT) throw error
  return existing
}

async function applySelections(rows, missions, nowIso) {
  for (const selection of rows) {
    const mission = missions[selection.slot - 1]
    const minutes = Math.max(1, Number(mission.target_minutes || 1))
    const { data, error } = await supabase
      .from('task_center_reading_missions')
      .update({
        is_active: true,
        title: `Read ${minutes} minutes`,
        subtitle: String(selection.story.title || '').trim(),
        story_link: `/story/${selection.story.id}`,
        updated_at: nowIso,
      })
      .eq('id', mission.id)
      .eq('audience', AUDIENCE)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) throw new Error('International Mission was removed during rotation')
  }
}

async function stampRotation(day, nowIso) {
  const { data, error } = await supabase
    .from('task_center_settings')
    .update({
      international_auto_last_rotation_date: day,
      international_auto_last_rotated_at: nowIso,
      updated_at: nowIso,
    })
    .eq('setting_key', SETTING_KEY)
    .select('setting_key')
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Failed to save International rotation timestamp')
}

let rotating = null
let ensurePending = null
let lastEnsure = { day: '', until: 0 }

export async function rotateTaskCenterInternationalAutoStories({ force = false } = {}) {
  if (rotating) return rotating
  const job = (async () => {
    const now = new Date()
    const nowIso = now.toISOString()
    const day = phnomPenhDay(now)
    const settings = await getSettings()
    if (!force && settings.international_reading_mission_mode !== 'auto') {
      return { rotated: false, reason: 'manual_mode', date: day, selections: [] }
    }
    if (!force && String(settings.international_auto_last_rotation_date || '') === day) {
      return { rotated: false, reason: 'already_rotated', date: day, selections: [] }
    }

    const missions = await getMissions()
    const [stories, recent, history] = await Promise.all([
      getEnglishStories(), getRecentUpdateMap(), getHistory(),
    ])
    if (stories.length < MISSION_LIMIT) {
      throw new Error('International Auto mode requires at least 2 eligible English stories with 5 episodes')
    }
    const storyById = new Map(stories.map((story) => [String(story.id), story]))
    const usedSlots = new Set()
    const usedIds = new Set()
    const invalidRows = []
    const selections = []

    for (const row of history.filter((item) => String(item.featured_date) === day)) {
      if (!validTodaySelection(row, missions, storyById, usedSlots, usedIds)) {
        invalidRows.push(row.id)
        continue
      }
      selections.push({
        slot: Number(row.slot),
        mission_id: row.mission_id,
        story: storyById.get(String(row.story_id)),
        source: row.selection_source || 'recycle',
        existing: true,
      })
    }

    if (invalidRows.length) {
      const { error } = await supabase.from(HISTORY_TABLE).delete().in('id', invalidRows)
      if (error) throw error
    }
    const validHistory = history.filter((row) => !invalidRows.includes(row.id))
    const lastSelected = lastSelectedStories(validHistory)
    const cutoff = now.getTime() - RECENT_COOLDOWN_DAYS * 86400000
    for (let slot = 1; slot <= MISSION_LIMIT; slot += 1) {
      if (selections.some((row) => row.slot === slot)) continue
      const pick = pickStory(stories, new Set(selections.map((row) => String(row.story.id))), lastSelected, recent, cutoff)
      if (!pick) throw new Error(`No eligible English story for International slot ${slot}`)
      selections.push({
        slot,
        mission_id: missions[slot - 1].id,
        story: pick.story,
        source: pick.source,
        existing: false,
      })
    }
    selections.sort((a, b) => a.slot - b.slot)
    const newCount = selections.filter((row) => !row.existing).length
    const finalSelections = await saveTodaySelections(day, selections, nowIso, missions, storyById)
    await applySelections(finalSelections, missions, nowIso)
    invalidateActiveSessionMissionsCache(AUDIENCE)
    await stampRotation(day, nowIso)
    return {
      rotated: newCount > 0,
      reason: newCount > 0 ? 'rotated' : 'already_rotated',
      date: day,
      selections: finalSelections.map(toPublic),
    }
  })()
  rotating = job
  try {
    return await job
  } finally {
    if (rotating === job) rotating = null
  }
}

// To be called by the future International mode/cron endpoints.
export async function ensureTaskCenterInternationalAutoRotation() {
  if (ensurePending) return ensurePending
  const day = phnomPenhDay()
  if (lastEnsure.day === day && Date.now() < lastEnsure.until) return
  const promise = (async () => {
    const settings = await getSettings()
    if (settings.international_reading_mission_mode !== 'auto') return
    if (String(settings.international_auto_last_rotation_date || '') === day) return
    return rotateTaskCenterInternationalAutoStories()
  })()
  ensurePending = promise
  try {
    return await promise
  } finally {
    if (ensurePending === promise) ensurePending = null
    lastEnsure = { day: phnomPenhDay(), until: Date.now() + 10000 }
  }
}
