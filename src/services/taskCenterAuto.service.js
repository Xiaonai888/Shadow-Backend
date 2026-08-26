import { supabase } from '../config/supabase.js'

const SETTING_KEY = 'main'
const AUTO_MODE = 'auto'
const MISSION_LIMIT = 2
const RECENT_COOLDOWN_DAYS = 7

function getPhnomPenhDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value

  return `${year}-${month}-${day}`
}

function normalizeStoryStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function randomItem(items = []) {
  if (!Array.isArray(items) || items.length === 0) return null
  return items[Math.floor(Math.random() * items.length)] || null
}

function toTime(value) {
  const time = value ? new Date(value).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

async function getAutoSettings() {
  const { data, error } = await supabase
    .from('task_center_settings')
    .select('setting_key, reading_mission_mode, auto_last_rotation_date, auto_last_rotated_at')
    .eq('setting_key', SETTING_KEY)
    .maybeSingle()

  if (error) throw error

  return data || {
    setting_key: SETTING_KEY,
    reading_mission_mode: 'manual',
    auto_last_rotation_date: null,
    auto_last_rotated_at: null,
  }
}

async function getMissionRows() {
  const { data, error } = await supabase
    .from('task_center_reading_missions')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(MISSION_LIMIT)

  if (error) throw error

  const rows = data || []

  if (rows.length !== MISSION_LIMIT) {
    throw new Error('Auto reading mission requires exactly 2 existing missions')
  }

  return rows
}

async function getEligibleStories() {
  const { data, error } = await supabase
    .from('stories')
    .select('id, title, story_status, status, deleted_at, is_shadow_exclusive, is_adult, total_episodes, created_at, updated_at')
    .eq('status', 'published')
    .is('deleted_at', null)
    .limit(5000)

  if (error) throw error

  return (data || []).filter((story) => {
    if (!story?.id) return false
    if (!String(story.title || '').trim()) return false
    if (Boolean(story.is_shadow_exclusive)) return false
    if (Boolean(story.is_adult)) return false
    if (Number(story.total_episodes || 0) <= 0) return false
    return true
  })
}

async function getRecentUpdateMap() {
  const { data, error } = await supabase.rpc('get_public_story_updates', {
    p_language: null,
    p_story_type: null,
    p_include_adult: false,
    p_days: 7,
    p_limit_per_day: 100,
  })

  if (error) {
    console.error('TASK CENTER AUTO UPDATE SOURCE ERROR:', error)
    return new Map()
  }

  const map = new Map()

  for (const item of data || []) {
    const storyId = String(item?.id || '').trim()
    if (!storyId) continue

    const current = map.get(storyId)
    const nextTime = toTime(item?.last_episode_published_at)
    const currentTime = toTime(current?.last_episode_published_at)

    if (!current || nextTime > currentTime) {
      map.set(storyId, item)
    }
  }

  return map
}

async function getHistoryRows() {
  const { data, error } = await supabase
    .from('task_center_auto_story_history')
    .select('id, featured_date, slot, story_id, mission_id, selection_source, story_status, story_updated_at, selected_at')
    .order('selected_at', { ascending: true })
    .limit(10000)

  if (error) throw error

  return data || []
}

function buildLastSelectedMap(historyRows = []) {
  const map = new Map()

  for (const row of historyRows) {
    const storyId = String(row?.story_id || '').trim()
    if (!storyId) continue

    const previous = map.get(storyId)
    if (!previous || toTime(row.selected_at) > toTime(previous.selected_at)) {
      map.set(storyId, row)
    }
  }

  return map
}

function pickStory({
  stories,
  selectedStoryIds,
  lastSelectedMap,
  recentUpdateMap,
  cooldownCutoff,
}) {
  const available = stories.filter((story) => !selectedStoryIds.has(String(story.id)))

  const unseen = available.filter((story) => !lastSelectedMap.has(String(story.id)))
  const unseenPick = randomItem(unseen)
  if (unseenPick) return { story: unseenPick, source: 'unseen' }

  const outsideCooldown = available.filter((story) => {
    const history = lastSelectedMap.get(String(story.id))
    return !history || toTime(history.selected_at) < cooldownCutoff
  })

  const updated = outsideCooldown.filter((story) => recentUpdateMap.has(String(story.id)))
  const updatedPick = randomItem(updated)
  if (updatedPick) return { story: updatedPick, source: 'updated' }

  const fresh = outsideCooldown.filter((story) => normalizeStoryStatus(story.story_status) === 'new')
  const freshPick = randomItem(fresh)
  if (freshPick) return { story: freshPick, source: 'new' }

  const completed = outsideCooldown.filter(
    (story) => normalizeStoryStatus(story.story_status) === 'completed'
  )
  const completedPick = randomItem(completed)
  if (completedPick) return { story: completedPick, source: 'completed' }

  const recyclePool = [...available].sort((a, b) => {
    const aTime = toTime(lastSelectedMap.get(String(a.id))?.selected_at)
    const bTime = toTime(lastSelectedMap.get(String(b.id))?.selected_at)

    if (aTime !== bTime) return aTime - bTime
    return Math.random() - 0.5
  })

  const recyclePick = recyclePool[0] || null
  return recyclePick ? { story: recyclePick, source: 'recycle' } : null
}

async function deleteInvalidTodayRows(rows = []) {
  const ids = rows.map((row) => row?.id).filter(Boolean)
  if (ids.length === 0) return

  const { error } = await supabase
    .from('task_center_auto_story_history')
    .delete()
    .in('id', ids)

  if (error) throw error
}

async function insertHistoryRows(rows = []) {
  if (rows.length === 0) return []

  const { data, error } = await supabase
    .from('task_center_auto_story_history')
    .insert(rows)
    .select('*')

  if (error) throw error
  return data || []
}

async function applySelectionsToMissions(selections, missions, nowIso) {
  const results = []

  for (const selection of selections) {
    const mission = missions[selection.slot - 1]
    const targetMinutes = Math.max(1, Number(mission?.target_minutes || 1))
    const storyTitle = String(selection.story.title || '').trim()

    const { data, error } = await supabase
      .from('task_center_reading_missions')
      .update({
        is_active: true,
        title: `Read ${targetMinutes} minutes`,
        subtitle: storyTitle,
        story_link: `/story/${selection.story.id}`,
        updated_at: nowIso,
      })
      .eq('id', mission.id)
      .select('*')
      .single()

    if (error) throw error
    results.push(data)
  }

  return results
}

async function updateRotationStamp(dateKey, nowIso) {
  const { error } = await supabase
    .from('task_center_settings')
    .update({
      auto_last_rotation_date: dateKey,
      auto_last_rotated_at: nowIso,
      updated_at: nowIso,
    })
    .eq('setting_key', SETTING_KEY)

  if (error) throw error
}

function publicSelection(selection) {
  return {
    slot: selection.slot,
    mission_id: selection.mission_id,
    story_id: String(selection.story.id),
    story_title: selection.story.title,
    story_status: selection.story.story_status || null,
    story_link: `/story/${selection.story.id}`,
    selection_source: selection.source,
  }
}

export async function ensureTaskCenterAutoRotation() {
  const settings = await getAutoSettings()
  const dateKey = getPhnomPenhDateKey()
  if (settings.reading_mission_mode !== 'auto') return
  if (String(settings.auto_last_rotation_date || '') === dateKey) return
  return rotateTaskCenterAutoStories()
}

export async function rotateTaskCenterAutoStories({ force = false } = {}) {
  const now = new Date()
  const nowIso = now.toISOString()
  const dateKey = getPhnomPenhDateKey(now)
  const settings = await getAutoSettings()

  if (!force && String(settings.reading_mission_mode || 'manual') !== AUTO_MODE) {
    return {
      rotated: false,
      reason: 'manual_mode',
      date: dateKey,
      selections: [],
    }
  }

  const [missions, stories, recentUpdateMap, historyRows] = await Promise.all([
    getMissionRows(),
    getEligibleStories(),
    getRecentUpdateMap(),
    getHistoryRows(),
  ])

  if (stories.length < MISSION_LIMIT) {
    throw new Error('Auto reading mission requires at least 2 eligible published stories')
  }

  const storyMap = new Map(stories.map((story) => [String(story.id), story]))
  const todayRows = historyRows.filter((row) => String(row.featured_date) === dateKey)
  const validTodayRows = []
  const invalidTodayRows = []
  const usedSlots = new Set()
  const usedStoryIds = new Set()

  for (const row of todayRows) {
    const slot = Number(row.slot)
    const storyId = String(row.story_id || '')
    const story = storyMap.get(storyId)

    if (
      !story ||
      ![1, 2].includes(slot) ||
      usedSlots.has(slot) ||
      usedStoryIds.has(storyId)
    ) {
      invalidTodayRows.push(row)
      continue
    }

    usedSlots.add(slot)
    usedStoryIds.add(storyId)
    validTodayRows.push(row)
  }

  if (invalidTodayRows.length > 0) {
    await deleteInvalidTodayRows(invalidTodayRows)
  }

  const lastSelectedMap = buildLastSelectedMap(
    historyRows.filter((row) => !invalidTodayRows.some((invalid) => invalid.id === row.id))
  )
  const cooldownCutoff = now.getTime() - RECENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  const selections = validTodayRows.map((row) => ({
    slot: Number(row.slot),
    mission_id: row.mission_id || missions[Number(row.slot) - 1]?.id || null,
    story: storyMap.get(String(row.story_id)),
    source: row.selection_source || 'recycle',
    existing: true,
  }))

  for (let slot = 1; slot <= MISSION_LIMIT; slot += 1) {
    if (selections.some((selection) => selection.slot === slot)) continue

    const picked = pickStory({
      stories,
      selectedStoryIds: new Set(selections.map((selection) => String(selection.story.id))),
      lastSelectedMap,
      recentUpdateMap,
      cooldownCutoff,
    })

    if (!picked?.story) {
      throw new Error(`Could not select a story for auto mission slot ${slot}`)
    }

    selections.push({
      slot,
      mission_id: missions[slot - 1].id,
      story: picked.story,
      source: picked.source,
      existing: false,
    })
  }

  selections.sort((a, b) => a.slot - b.slot)

  const newSelections = selections.filter((selection) => !selection.existing)

  if (newSelections.length > 0) {
    const rows = newSelections.map((selection) => ({
      featured_date: dateKey,
      slot: selection.slot,
      story_id: String(selection.story.id),
      mission_id: String(selection.mission_id || ''),
      selection_source: selection.source,
      story_status: selection.story.story_status || null,
      story_updated_at:
        recentUpdateMap.get(String(selection.story.id))?.last_episode_published_at ||
        selection.story.updated_at ||
        null,
      selected_at: nowIso,
    }))

    try {
      await insertHistoryRows(rows)
    } catch (error) {
      if (String(error?.code || '') !== '23505') throw error

      const { data: concurrentRows, error: concurrentError } = await supabase
        .from('task_center_auto_story_history')
        .select('*')
        .eq('featured_date', dateKey)
        .order('slot', { ascending: true })

      if (concurrentError) throw concurrentError

      const concurrentSelections = (concurrentRows || [])
        .map((row) => ({
          slot: Number(row.slot),
          mission_id: row.mission_id || missions[Number(row.slot) - 1]?.id || null,
          story: storyMap.get(String(row.story_id)),
          source: row.selection_source || 'recycle',
          existing: true,
        }))
        .filter((selection) => selection.story)

      if (concurrentSelections.length !== MISSION_LIMIT) throw error

      selections.splice(0, selections.length, ...concurrentSelections)
      selections.sort((a, b) => a.slot - b.slot)
    }
  }

  await applySelectionsToMissions(selections, missions, nowIso)
  await updateRotationStamp(dateKey, nowIso)

  return {
    rotated: newSelections.length > 0,
    reason: newSelections.length > 0 ? 'rotated' : 'already_rotated',
    date: dateKey,
    selections: selections.map(publicSelection),
  }
}
